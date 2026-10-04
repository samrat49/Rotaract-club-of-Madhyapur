const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");
const { requirePermission } = require("../lib/permissions");
const { logActivity } = require("../lib/activityLog");
const { resolveActiveTenureId, assertTenureEditable } = require("../lib/tenure");

router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
  const tenureId = req.query.tenureId || (await resolveActiveTenureId(pool));
  const r = await pool.query(
    `select m.*, coalesce(d.dues_amount, 0) as tenure_dues, d.id as dues_row_id
     from members m
     left join member_tenure_dues d on d.member_id = m.id and d.tenure_id = $1
     order by m.created_at asc`,
    [tenureId]
  );
  res.json(r.rows);
}));

router.post("/", requirePermission("members"), asyncHandler(async (req, res) => {
  const { name, designation, phone, duesAmount } = req.body;
  if (!name || !duesAmount) return res.status(400).json({ error: "Name and dues amount are required" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const memberRes = await client.query(
      "insert into members (name, designation, phone) values ($1,$2,$3) returning *",
      [name, designation || "", phone || null]
    );
    const member = memberRes.rows[0];

    const tenureId = await resolveActiveTenureId(client);
    let tenureDues = 0;
    if (tenureId) {
      const duesRes = await client.query(
        "insert into member_tenure_dues (member_id, tenure_id, dues_amount) values ($1,$2,$3) returning *",
        [member.id, tenureId, duesAmount]
      );
      tenureDues = Number(duesRes.rows[0].dues_amount);
    }

    await client.query("commit");
    await logActivity({
      action: "create",
      entityType: "member",
      entityId: member.id,
      summary: `Added member "${member.name}"${tenureId ? ` with dues of Rs ${tenureDues}` : ""}`,
      after: member,
      user: req.user,
    });
    res.json({ ...member, tenure_dues: tenureDues });
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}));

router.put("/:id", requirePermission("members"), asyncHandler(async (req, res) => {
  const { name, designation, phone } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  const before = await pool.query("select * from members where id = $1", [req.params.id]);
  if (!before.rows[0]) return res.status(404).json({ error: "Member not found" });

  const r = await pool.query(
    "update members set name = $1, designation = $2, phone = $3 where id = $4 returning *",
    [name, designation || "", phone || null, req.params.id]
  );
  const after = r.rows[0];

  await logActivity({
    action: "update",
    entityType: "member",
    entityId: after.id,
    summary: `Edited member "${before.rows[0].name}"`,
    before: before.rows[0],
    after,
    user: req.user,
  });

  res.json(after);
}));

// Sets a member's dues for a specific tenure (upsert) — used both when
// editing a member and when adjusting dues for the currently viewed year.
router.put("/:id/dues", requirePermission("members"), asyncHandler(async (req, res) => {
  const { tenureId, duesAmount } = req.body;
  if (!tenureId || duesAmount == null || duesAmount < 0) {
    return res.status(400).json({ error: "tenureId and duesAmount are required" });
  }
  await assertTenureEditable(pool, tenureId);

  const memberRes = await pool.query("select * from members where id = $1", [req.params.id]);
  const member = memberRes.rows[0];
  if (!member) return res.status(404).json({ error: "Member not found" });

  const r = await pool.query(
    `insert into member_tenure_dues (member_id, tenure_id, dues_amount)
     values ($1,$2,$3)
     on conflict (member_id, tenure_id) do update set dues_amount = excluded.dues_amount, updated_at = now()
     returning *`,
    [req.params.id, tenureId, duesAmount]
  );

  await logActivity({
    action: "update",
    entityType: "member",
    entityId: member.id,
    summary: `Set dues to Rs ${duesAmount} for member "${member.name}"`,
    after: r.rows[0],
    user: req.user,
  });

  res.json(r.rows[0]);
}));

router.delete("/:id", requirePermission("members"), asyncHandler(async (req, res) => {
  const before = await pool.query("select * from members where id = $1", [req.params.id]);
  const member = before.rows[0];
  if (!member) return res.status(404).json({ error: "Member not found" });

  // Unlink (not delete) their transactions first, so the ledger stays intact.
  await pool.query("update transactions set member_id = null where member_id = $1", [req.params.id]);
  await pool.query("delete from members where id = $1", [req.params.id]);

  await logActivity({
    action: "delete",
    entityType: "member",
    entityId: member.id,
    summary: `Deleted member "${member.name}"`,
    before: member,
    user: req.user,
  });

  res.json({ ok: true });
}));

module.exports = router;
