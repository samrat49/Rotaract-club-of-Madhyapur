const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");

router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
  const r = await pool.query("select * from bills order by date desc, created_at desc");
  res.json(r.rows);
}));

router.post("/", asyncHandler(async (req, res) => {
  const { eventId, fileName, fileType, fileData, description, date } = req.body;
  if (!fileName || !fileType || !fileData || !date) {
    return res.status(400).json({ error: "fileName, fileType, fileData and date are required" });
  }
  const r = await pool.query(
    `insert into bills (event_id, file_name, file_type, file_data, description, date)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [eventId || null, fileName, fileType, fileData, description || "", date]
  );
  res.json(r.rows[0]);
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  await pool.query("delete from bills where id = $1", [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;