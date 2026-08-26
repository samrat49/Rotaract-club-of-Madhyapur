const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");
const { logActivity } = require("../lib/activityLog");

router.use(requireAuth);

// Pending liabilities first (oldest due first), fully paid ones sink to the
// bottom of the list — matches how the Liabilities tab displays them.
router.get("/", asyncHandler(async (req, res) => {
  const r = await pool.query(
    `select * from liabilities
     order by (status = 'paid') asc, date asc, created_at asc`
  );
  res.json(r.rows);
}));

router.post("/", asyncHandler(async (req, res) => {
  const { payeeName, memberId, eventId, category, amount, date, notes } = req.body;
  if (!payeeName || !amount || amount <= 0 || !date) {
    return res.status(400).json({ error: "Payee/source, amount, and date are required" });
  }
  const r = await pool.query(
    `insert into liabilities (payee_name, member_id, event_id, category, amount, date, notes)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [payeeName, memberId || null, eventId || null, category || "", amount, date, notes || ""]
  );
  res.json(r.rows[0]);
}));

// Records a payment against a liability: inserts a normal Expense
// transaction (tagged back to the liability via liability_id) and updates
// the liability's paid_amount/status in the same DB transaction, so the two
// can never drift apart.
router.post("/:id/pay", asyncHandler(async (req, res) => {
  const { amount, date, account, paymentMethod, notes } = req.body;
  if (!amount || amount <= 0 || !date || !account) {
    return res.status(400).json({ error: "Amount, date, and account are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const liabRes = await client.query("select * from liabilities where id = $1 for update", [req.params.id]);
    const liability = liabRes.rows[0];
    if (!liability) {
      await client.query("rollback");
      return res.status(404).json({ error: "Liability not found" });
    }

    const remaining = Number(liability.amount) - Number(liability.paid_amount);
    if (amount > remaining + 0.01) {
      await client.query("rollback");
      return res.status(400).json({ error: `Payment of Rs ${amount} exceeds the remaining Rs ${remaining} owed` });
    }

    const txnRes = await client.query(
      `insert into transactions
       (date, description, type, category, account, amount, payment_method, notes, member_id, event_id, liability_id)
       values ($1,$2,'Expense','Liability Payment',$3,$4,$5,$6,$7,$8,$9) returning *`,
      [date, `Liability payment — ${liability.payee_name}`, account, amount, paymentMethod || "", notes || "", liability.member_id, liability.event_id, liability.id]
    );

    const newPaid = Number(liability.paid_amount) + Number(amount);
    const newStatus = newPaid >= Number(liability.amount) - 0.01 ? "paid" : "pending";
    const updatedLiabRes = await client.query(
      "update liabilities set paid_amount = $1, status = $2 where id = $3 returning *",
      [newPaid, newStatus, liability.id]
    );

    await client.query("commit");

    await logActivity({
      action: "update",
      entityType: "liability",
      entityId: liability.id,
      summary: `Recorded a payment of Rs ${amount} against liability "${liability.payee_name}" (${newStatus === "paid" ? "now fully paid" : `Rs ${Number(liability.amount) - newPaid} still remaining`})`,
      before: liability,
      after: updatedLiabRes.rows[0],
      user: req.user,
    });

    res.json({ liability: updatedLiabRes.rows[0], transaction: txnRes.rows[0] });
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const before = await pool.query("select * from liabilities where id = $1", [req.params.id]);
  const liability = before.rows[0];
  if (!liability) return res.status(404).json({ error: "Liability not found" });

  await pool.query("update transactions set liability_id = null where liability_id = $1", [req.params.id]);
  await pool.query("delete from liabilities where id = $1", [req.params.id]);

  await logActivity({
    action: "delete",
    entityType: "liability",
    entityId: liability.id,
    summary: `Deleted liability "${liability.payee_name}" (Rs ${liability.amount}, Rs ${liability.paid_amount} paid)`,
    before: liability,
    user: req.user,
  });

  res.json({ ok: true });
}));

module.exports = router;
