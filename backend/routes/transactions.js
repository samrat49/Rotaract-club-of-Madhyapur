const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");
const { assertPermission } = require("../lib/permissions");
const { logActivity } = require("../lib/activityLog");
const { resolveActiveTenureId, assertTenureEditable } = require("../lib/tenure");

router.use(requireAuth);

// Which permission lets a member add/delete this transaction: one linked to an
// event needs "event_transactions"; a dues payment (linked to a member) is
// covered by either "members" or "transactions"; anything else "transactions".
function permissionsFor(t) {
  if (t.eventId || t.event_id) return ["event_transactions"];
  if (t.memberId || t.member_id) return ["members", "transactions"];
  return ["transactions"];
}

router.get("/", asyncHandler(async (req, res) => {
  const tenureId = req.query.tenureId || (await resolveActiveTenureId(pool));
  if (!tenureId) return res.json([]);
  const r = await pool.query(
    "select * from transactions where tenure_id = $1 order by date desc, created_at desc",
    [tenureId]
  );
  res.json(r.rows);
}));

router.post("/", asyncHandler(async (req, res) => {
  const { date, description, type, category, account, amount, paymentMethod, notes, memberId, eventId } = req.body;
  await assertPermission(req, ...permissionsFor({ memberId, eventId }));
  if (!date || !description || !type || !category || !account || !amount) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const tenureId = await resolveActiveTenureId(pool);
  if (!tenureId) return res.status(400).json({ error: "No active tenure — start one in Settings first." });
  const r = await pool.query(
    `insert into transactions
     (date, description, type, category, account, amount, payment_method, notes, member_id, event_id, tenure_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [date, description, type, category, account, amount, paymentMethod || "", notes || "", memberId || null, eventId || null, tenureId]
  );
  await logActivity({
    action: "create",
    entityType: "transaction",
    entityId: r.rows[0].id,
    summary: `Added ${String(type).toLowerCase()} transaction "${description}" — Rs ${amount} on ${date}${eventId ? " (event)" : ""}`,
    after: r.rows[0],
    user: req.user,
  });
  res.json(r.rows[0]);
}));

// Bulk insert — used by the CSV import feature so we don't make one
// request per row.
router.post("/bulk", asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body.transactions) ? req.body.transactions : [];
  if (!rows.length) return res.status(400).json({ error: "No transactions provided" });
  // Every distinct kind of row in the import must be permitted.
  const needed = new Map(rows.map((t) => { const k = permissionsFor(t); return [k.join("|"), k]; }));
  for (const keys of needed.values()) await assertPermission(req, ...keys);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const tenureId = await resolveActiveTenureId(client);
    if (!tenureId) {
      await client.query("rollback");
      return res.status(400).json({ error: "No active tenure — start one in Settings first." });
    }
    const inserted = [];
    for (const t of rows) {
      const r = await client.query(
        `insert into transactions
         (date, description, type, category, account, amount, payment_method, notes, member_id, event_id, tenure_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [t.date, t.description, t.type, t.category, t.account, t.amount, t.paymentMethod || "", t.notes || "", t.memberId || null, t.eventId || null, tenureId]
      );
      inserted.push(r.rows[0]);
    }
    await client.query("commit");
    await logActivity({
      action: "create",
      entityType: "transaction",
      summary: `Imported ${inserted.length} transaction${inserted.length === 1 ? "" : "s"} from a file`,
      user: req.user,
    });
    res.json({ count: inserted.length, transactions: inserted });
  } catch (err) {
    await client.query("rollback");
    console.error(err);
    res.status(500).json({ error: "Bulk import failed" });
  } finally {
    client.release();
  }
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const existing = await pool.query("select * from transactions where id = $1", [req.params.id]);
  const txn = existing.rows[0];
  if (!txn) return res.status(404).json({ error: "Transaction not found" });
  await assertPermission(req, ...permissionsFor(txn));
  if (txn.tenure_id) await assertTenureEditable(pool, txn.tenure_id);

  await pool.query("delete from transactions where id = $1", [req.params.id]);

  // If this was a payment recorded against a liability, that liability's
  // paid_amount/status must reflect the remaining linked payments — recompute
  // it from scratch rather than trying to subtract, so it can never drift.
  if (txn.liability_id) {
    const sumRes = await pool.query(
      "select coalesce(sum(amount), 0) as paid from transactions where liability_id = $1",
      [txn.liability_id]
    );
    const liabRes = await pool.query("select * from liabilities where id = $1", [txn.liability_id]);
    const liability = liabRes.rows[0];
    if (liability) {
      const newPaid = Number(sumRes.rows[0].paid);
      const newStatus = newPaid >= Number(liability.amount) - 0.01 ? "paid" : "pending";
      await pool.query("update liabilities set paid_amount = $1, status = $2 where id = $3", [newPaid, newStatus, liability.id]);
    }
  }

  await logActivity({
    action: "delete",
    entityType: "transaction",
    entityId: txn.id,
    summary: `Deleted ${txn.type.toLowerCase()} transaction "${txn.description}" — Rs ${txn.amount} on ${txn.date}`,
    before: txn,
    user: req.user,
  });

  res.json({ ok: true });
}));

module.exports = router;