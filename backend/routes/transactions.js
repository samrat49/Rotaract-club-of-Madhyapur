const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");

router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
  const r = await pool.query("select * from transactions order by date desc, created_at desc");
  res.json(r.rows);
}));

router.post("/", asyncHandler(async (req, res) => {
  const { date, description, type, category, account, amount, paymentMethod, notes, memberId, eventId } = req.body;
  if (!date || !description || !type || !category || !account || !amount) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const r = await pool.query(
    `insert into transactions
     (date, description, type, category, account, amount, payment_method, notes, member_id, event_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [date, description, type, category, account, amount, paymentMethod || "", notes || "", memberId || null, eventId || null]
  );
  res.json(r.rows[0]);
}));

// Bulk insert — used by the CSV import feature so we don't make one
// request per row.
router.post("/bulk", asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body.transactions) ? req.body.transactions : [];
  if (!rows.length) return res.status(400).json({ error: "No transactions provided" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = [];
    for (const t of rows) {
      const r = await client.query(
        `insert into transactions
         (date, description, type, category, account, amount, payment_method, notes, member_id, event_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [t.date, t.description, t.type, t.category, t.account, t.amount, t.paymentMethod || "", t.notes || "", t.memberId || null, t.eventId || null]
      );
      inserted.push(r.rows[0]);
    }
    await client.query("commit");
    res.json({ count: inserted.length, transactions: inserted });
  } catch (err) {
    await client.query("rollback");
    console.error(err);
    res.status(500).json({ error: "Bulk import failed" });
  } finally {
    client.release();
  }
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  await pool.query("delete from transactions where id = $1", [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;