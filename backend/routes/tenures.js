const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");
const { requirePermission } = require("../lib/permissions");
const { logActivity } = require("../lib/activityLog");

router.use(requireAuth);

function labelForStartYear(startYear) {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// Suggests the next July 1 – June 30 cycle following a tenure's end_date.
function nextCycleDefaults(prevEndDateStr) {
  const prevEnd = new Date(prevEndDateStr + "T00:00:00Z");
  const startYear = prevEnd.getUTCFullYear() + (prevEnd.getUTCMonth() >= 6 ? 1 : 0);
  const startDate = new Date(Date.UTC(startYear, 6, 1));
  const endDate = new Date(Date.UTC(startYear + 1, 5, 30));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { label: labelForStartYear(startYear), startDate: iso(startDate), endDate: iso(endDate) };
}

async function computeClosingBalances(db, tenure) {
  const r = await db.query(
    `select account, coalesce(sum(case when type = 'Income' then amount else -amount end), 0) as delta
     from transactions where tenure_id = $1 group by account`,
    [tenure.id]
  );
  const deltas = { Cash: 0, Online: 0, Bank: 0 };
  for (const row of r.rows) deltas[row.account] = Number(row.delta);
  return {
    closingCash: Number(tenure.opening_cash) + deltas.Cash,
    closingOnline: Number(tenure.opening_online) + deltas.Online,
    closingBank: Number(tenure.opening_bank) + deltas.Bank,
  };
}

router.get("/", asyncHandler(async (req, res) => {
  const r = await pool.query("select * from tenures order by start_date desc");
  res.json(r.rows);
}));

// Pre-fills the bootstrap form with whatever the (soon-to-be-deprecated)
// global opening balances were, so the very first tenure doesn't start from
// a blank Rs 0.
router.get("/bootstrap-defaults", asyncHandler(async (req, res) => {
  const r = await pool.query("select opening_cash, opening_online, opening_bank from club_settings where id = 1");
  res.json(r.rows[0] || { opening_cash: 0, opening_online: 0, opening_bank: 0 });
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const r = await pool.query("select * from tenures where id = $1", [req.params.id]);
  const tenure = r.rows[0];
  if (!tenure) return res.status(404).json({ error: "Tenure not found" });

  if (tenure.status === "active") {
    const live = await computeClosingBalances(pool, tenure);
    return res.json({ ...tenure, ...live });
  }
  res.json(tenure);
}));

// Bootstrap-only: creates the very first tenure. Every tenure after this
// one is only ever created by POST /:id/close, which carries balances
// forward automatically.
router.post("/", requirePermission("settings"), asyncHandler(async (req, res) => {
  const existing = await pool.query("select count(*) from tenures");
  if (Number(existing.rows[0].count) > 0) {
    return res.status(400).json({ error: "A tenure already exists — use Close & Start New Year instead of creating one directly." });
  }

  const { label, startDate, endDate, openingCash, openingOnline, openingBank } = req.body;
  if (!label || !startDate || !endDate) {
    return res.status(400).json({ error: "label, startDate, and endDate are required" });
  }

  const r = await pool.query(
    `insert into tenures (label, start_date, end_date, status, opening_cash, opening_online, opening_bank)
     values ($1,$2,$3,'active',$4,$5,$6) returning *`,
    [label, startDate, endDate, openingCash || 0, openingOnline || 0, openingBank || 0]
  );
  const tenure = r.rows[0];

  await logActivity({
    action: "create",
    entityType: "tenure",
    entityId: tenure.id,
    summary: `Started tenure "${tenure.label}" — opening balances Cash Rs ${tenure.opening_cash} / Online Rs ${tenure.opening_online} / Bank Rs ${tenure.opening_bank}`,
    after: tenure,
    user: req.user,
  });

  res.json(tenure);
}));

// Corrects the active tenure's opening balances (e.g. a mistake made when the
// first tenure was set up). Closed tenures stay locked. A reason is required
// and the old/new values are written to the activity log.
router.patch("/:id/opening", requirePermission("settings"), asyncHandler(async (req, res) => {
  const { openingCash, openingOnline, openingBank, reason } = req.body;
  const values = [openingCash, openingOnline, openingBank];
  if (values.some((v) => v === undefined || v === null || v === "" || !Number.isFinite(Number(v)))) {
    return res.status(400).json({ error: "openingCash, openingOnline and openingBank must all be numbers" });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: "Please give a reason for changing the opening balances" });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query("select * from tenures where id = $1 for update", [req.params.id]);
    const before = cur.rows[0];
    if (!before) {
      await client.query("rollback");
      return res.status(404).json({ error: "Tenure not found" });
    }
    if (before.status !== "active") {
      await client.query("rollback");
      return res.status(409).json({ error: "Only the active tenure's opening balances can be changed." });
    }
    const upd = await client.query(
      "update tenures set opening_cash = $1, opening_online = $2, opening_bank = $3 where id = $4 returning *",
      [Number(openingCash), Number(openingOnline), Number(openingBank), before.id]
    );
    await client.query("commit");
    const after = upd.rows[0];

    await logActivity({
      action: "update",
      entityType: "tenure",
      entityId: after.id,
      summary: `Changed opening balances of "${after.label}" — Cash Rs ${before.opening_cash} → ${after.opening_cash}, Online Rs ${before.opening_online} → ${after.opening_online}, Bank Rs ${before.opening_bank} → ${after.opening_bank}. Reason: ${String(reason).trim()}`,
      before,
      after,
      user: req.user,
    });

    res.json(after);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// The handover: closes the active tenure with computed closing balances and
// opens the next one, carrying those closing balances forward as its
// opening balances — all in one DB transaction so the two tenures can never
// end up out of sync (e.g. a closed tenure with no successor).
router.post("/:id/close", requirePermission("settings"), asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const tenureRes = await client.query("select * from tenures where id = $1 for update", [req.params.id]);
    const tenure = tenureRes.rows[0];
    if (!tenure) {
      await client.query("rollback");
      return res.status(404).json({ error: "Tenure not found" });
    }
    if (tenure.status !== "active") {
      await client.query("rollback");
      return res.status(409).json({ error: "This tenure is already closed." });
    }

    const closing = await computeClosingBalances(client, tenure);

    const closedRes = await client.query(
      `update tenures
       set status = 'closed', closing_cash = $1, closing_online = $2, closing_bank = $3,
           closed_at = now(), closed_by = $4
       where id = $5 returning *`,
      [closing.closingCash, closing.closingOnline, closing.closingBank, req.user.id, tenure.id]
    );
    const closedTenure = closedRes.rows[0];

    const suggested = nextCycleDefaults(tenure.end_date);
    const label = req.body.label || suggested.label;
    const startDate = req.body.startDate || suggested.startDate;
    const endDate = req.body.endDate || suggested.endDate;

    const newRes = await client.query(
      `insert into tenures (label, start_date, end_date, status, opening_cash, opening_online, opening_bank)
       values ($1,$2,$3,'active',$4,$5,$6) returning *`,
      [label, startDate, endDate, closing.closingCash, closing.closingOnline, closing.closingBank]
    );
    const newTenure = newRes.rows[0];

    // Carry each member's dues forward so the treasurer isn't re-entering
    // ~30 members' dues from scratch — editable afterward per member.
    await client.query(
      `insert into member_tenure_dues (member_id, tenure_id, dues_amount)
       select member_id, $1, dues_amount from member_tenure_dues where tenure_id = $2
       on conflict (member_id, tenure_id) do nothing`,
      [newTenure.id, tenure.id]
    );

    await client.query("commit");

    await logActivity({
      action: "update",
      entityType: "tenure",
      entityId: closedTenure.id,
      summary: `Closed tenure "${closedTenure.label}" — closing balances Cash Rs ${closing.closingCash} / Online Rs ${closing.closingOnline} / Bank Rs ${closing.closingBank}`,
      before: tenure,
      after: closedTenure,
      user: req.user,
    });
    await logActivity({
      action: "create",
      entityType: "tenure",
      entityId: newTenure.id,
      summary: `Started tenure "${newTenure.label}" — opening balances carried forward from "${closedTenure.label}"`,
      after: newTenure,
      user: req.user,
    });

    res.json({ closedTenure, newTenure });
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
