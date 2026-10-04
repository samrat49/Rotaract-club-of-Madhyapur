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
  if (!tenureId) return res.json([]);
  const r = await pool.query(
    "select * from events where tenure_id = $1 order by created_at desc",
    [tenureId]
  );
  res.json(r.rows);
}));

router.post("/", requirePermission("events"), asyncHandler(async (req, res) => {
  const { name, date, budget, expectedIncome, expectedExpense, notes } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });
  const tenureId = await resolveActiveTenureId(pool);
  if (!tenureId) return res.status(400).json({ error: "No active tenure — start one in Settings first." });
  const r = await pool.query(
    `insert into events (name, date, budget, expected_income, expected_expense, notes, tenure_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [name, date || null, budget || 0, expectedIncome || 0, expectedExpense || 0, notes || "", tenureId]
  );
  await logActivity({
    action: "create",
    entityType: "event",
    entityId: r.rows[0].id,
    summary: `Created event "${r.rows[0].name}"`,
    after: r.rows[0],
    user: req.user,
  });
  res.json(r.rows[0]);
}));

router.delete("/:id", requirePermission("events"), asyncHandler(async (req, res) => {
  const before = await pool.query("select * from events where id = $1", [req.params.id]);
  const event = before.rows[0];
  if (!event) return res.status(404).json({ error: "Event not found" });
  if (event.tenure_id) await assertTenureEditable(pool, event.tenure_id);

  await pool.query("update transactions set event_id = null where event_id = $1", [req.params.id]);
  await pool.query("update bills set event_id = null where event_id = $1", [req.params.id]);
  await pool.query("update liabilities set event_id = null where event_id = $1", [req.params.id]);
  await pool.query("delete from events where id = $1", [req.params.id]);

  await logActivity({
    action: "delete",
    entityType: "event",
    entityId: event.id,
    summary: `Deleted event "${event.name}"`,
    before: event,
    user: req.user,
  });

  res.json({ ok: true });
}));

module.exports = router;