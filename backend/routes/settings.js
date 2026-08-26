const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");

router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
  const r = await pool.query("select * from club_settings where id = 1");
  res.json(r.rows[0]);
}));

router.put("/", asyncHandler(async (req, res) => {
  const { clubName, openingCash, openingOnline, openingBank } = req.body;
  const r = await pool.query(
    `update club_settings
     set club_name = coalesce($1, club_name),
         opening_cash = coalesce($2, opening_cash),
         opening_online = coalesce($3, opening_online),
         opening_bank = coalesce($4, opening_bank)
     where id = 1
     returning *`,
    [clubName, openingCash, openingOnline, openingBank]
  );
  res.json(r.rows[0]);
}));

module.exports = router;