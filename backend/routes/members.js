const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");
const { logActivity } = require("../lib/activityLog");

router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
  const r = await pool.query("select * from members order by created_at asc");
  res.json(r.rows);
}));

router.post("/", asyncHandler(async (req, res) => {
  const { name, designation, phone, annualDues } = req.body;
  if (!name || !annualDues) return res.status(400).json({ error: "Name and annual dues are required" });
  const r = await pool.query(
    "insert into members (name, designation, phone, annual_dues) values ($1,$2,$3,$4) returning *",
    [name, designation || "", phone || null, annualDues]
  );
  res.json(r.rows[0]);
}));

router.put("/:id", asyncHandler(async (req, res) => {
  const { name, designation, phone, annualDues } = req.body;
  if (!name || !annualDues) return res.status(400).json({ error: "Name and annual dues are required" });

  const before = await pool.query("select * from members where id = $1", [req.params.id]);
  if (!before.rows[0]) return res.status(404).json({ error: "Member not found" });

  const r = await pool.query(
    "update members set name = $1, designation = $2, phone = $3, annual_dues = $4 where id = $5 returning *",
    [name, designation || "", phone || null, annualDues, req.params.id]
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

router.delete("/:id", asyncHandler(async (req, res) => {
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