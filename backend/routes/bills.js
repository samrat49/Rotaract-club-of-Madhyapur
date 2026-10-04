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
    "select * from bills where tenure_id = $1 order by date desc, created_at desc",
    [tenureId]
  );
  res.json(r.rows);
}));

router.post("/", requirePermission("bills"), asyncHandler(async (req, res) => {
  const { eventId, fileName, fileType, fileData, description, date } = req.body;
  if (!fileName || !fileType || !fileData || !date) {
    return res.status(400).json({ error: "fileName, fileType, fileData and date are required" });
  }
  const tenureId = await resolveActiveTenureId(pool);
  if (!tenureId) return res.status(400).json({ error: "No active tenure — start one in Settings first." });
  const r = await pool.query(
    `insert into bills (event_id, file_name, file_type, file_data, description, date, tenure_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [eventId || null, fileName, fileType, fileData, description || "", date, tenureId]
  );
  const { file_data, ...billMeta } = r.rows[0];
  await logActivity({
    action: "create",
    entityType: "bill",
    entityId: r.rows[0].id,
    summary: `Uploaded bill "${fileName}"${description ? ` — ${description}` : ""}`,
    after: billMeta,
    user: req.user,
  });
  res.json(r.rows[0]);
}));

router.delete("/:id", requirePermission("bills"), asyncHandler(async (req, res) => {
  const before = await pool.query("select * from bills where id = $1", [req.params.id]);
  const bill = before.rows[0];
  if (!bill) return res.status(404).json({ error: "Bill not found" });
  if (bill.tenure_id) await assertTenureEditable(pool, bill.tenure_id);

  await pool.query("delete from bills where id = $1", [req.params.id]);

  // Log everything except the base64 file bytes — keeps the audit trail lean.
  const { file_data, ...billMeta } = bill;
  await logActivity({
    action: "delete",
    entityType: "bill",
    entityId: bill.id,
    summary: `Deleted bill "${bill.file_name}"${bill.description ? ` — ${bill.description}` : ""}`,
    before: billMeta,
    user: req.user,
  });

  res.json({ ok: true });
}));

module.exports = router;