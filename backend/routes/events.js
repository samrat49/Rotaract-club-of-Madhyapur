const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");

router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
  const r = await pool.query("select * from events order by created_at desc");
  res.json(r.rows);
}));

router.post("/", asyncHandler(async (req, res) => {
  const { name, date, budget, expectedIncome, expectedExpense, notes } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });
  const r = await pool.query(
    `insert into events (name, date, budget, expected_income, expected_expense, notes)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [name, date || null, budget || 0, expectedIncome || 0, expectedExpense || 0, notes || ""]
  );
  res.json(r.rows[0]);
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  await pool.query("update transactions set event_id = null where event_id = $1", [req.params.id]);
  await pool.query("update bills set event_id = null where event_id = $1", [req.params.id]);
  await pool.query("delete from events where id = $1", [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;