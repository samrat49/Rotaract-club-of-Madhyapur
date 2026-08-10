const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");

router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
  const r = await pool.query("select * from members order by created_at asc");
  res.json(r.rows);
}));

router.post("/", asyncHandler(async (req, res) => {
  const { name, phone, annualDues } = req.body;
  if (!name || !annualDues) return res.status(400).json({ error: "Name and annual dues are required" });
  const r = await pool.query(
    "insert into members (name, phone, annual_dues) values ($1,$2,$3) returning *",
    [name, phone || null, annualDues]
  );
  res.json(r.rows[0]);
}));

router.put("/:id", asyncHandler(async (req, res) => {
  const { name, phone, annualDues } = req.body;
  if (!name || !annualDues) return res.status(400).json({ error: "Name and annual dues are required" });
  const r = await pool.query(
    "update members set name = $1, phone = $2, annual_dues = $3 where id = $4 returning *",
    [name, phone || null, annualDues, req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Member not found" });
  res.json(r.rows[0]);
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  // Unlink (not delete) their transactions first, so the ledger stays intact.
  await pool.query("update transactions set member_id = null where member_id = $1", [req.params.id]);
  await pool.query("delete from members where id = $1", [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;