const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");

router.use(requireAuth);

// Read-only by design: this router intentionally exposes no POST/PUT/DELETE.
// Activity rows are written internally (see lib/activityLog.js) by the
// routes that perform deletes/edits, and are immutable at the database
// level once written (see schema.sql).
router.get("/", asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 300, 1000);
  const r = await pool.query(
    "select * from activity_log order by created_at desc limit $1",
    [limit]
  );
  res.json(r.rows);
}));

module.exports = router;
