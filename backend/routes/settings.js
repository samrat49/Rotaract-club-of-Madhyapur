const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");
const { requirePermission } = require("../lib/permissions");

router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
  const r = await pool.query("select * from club_settings where id = 1");
  res.json(r.rows[0]);
}));

// opening_cash/online/bank are deprecated here — opening balances now live
// on each tenure row (see routes/tenures.js) and are set once at tenure
// creation/handover, not edited as a standalone setting.
router.put("/", requirePermission("settings"), asyncHandler(async (req, res) => {
  const { clubName } = req.body;
  const r = await pool.query(
    `update club_settings set club_name = coalesce($1, club_name) where id = 1 returning *`,
    [clubName]
  );
  res.json(r.rows[0]);
}));

module.exports = router;