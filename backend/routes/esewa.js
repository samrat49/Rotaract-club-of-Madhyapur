const router = require("express").Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const asyncHandler = require("./asyncHandler");
const { logActivity } = require("../lib/activityLog");
const { parseEsewaWorkbook } = require("../lib/esewaParse");

router.use(requireAuth);

router.get("/uploads", asyncHandler(async (req, res) => {
  const r = await pool.query("select * from esewa_uploads order by created_at desc");
  res.json(r.rows);
}));

router.get("/transactions", asyncHandler(async (req, res) => {
  const r = await pool.query("select * from esewa_transactions order by txn_date desc, txn_time desc nulls last");
  res.json(r.rows);
}));

// Accepts the raw .xls/.xlsx file as a base64 data URL (same pattern the
// Bills upload uses) so the frontend doesn't need a parsing library —
// parsing happens here, server-side, with the xlsx package.
router.post("/upload", asyncHandler(async (req, res) => {
  const { fileName, fileData } = req.body;
  if (!fileName || !fileData) {
    return res.status(400).json({ error: "fileName and fileData are required" });
  }

  const base64 = String(fileData).includes(",") ? String(fileData).split(",")[1] : fileData;
  const buffer = Buffer.from(base64, "base64");

  let parsed;
  try {
    parsed = parseEsewaWorkbook(buffer);
  } catch (err) {
    return res.status(400).json({ error: err.message || "Could not parse this file." });
  }

  if (!parsed.rows.length) {
    return res.status(400).json({
      error: "No completed transactions were found in this file. Make sure it's an unmodified eSewa Statement Report export.",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const uploadRes = await client.query(
      `insert into esewa_uploads
       (file_name, from_date_raw, to_date_raw, parsed_count, uploaded_by_id, uploaded_by_name)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [fileName, parsed.fromDateRaw, parsed.toDateRaw, parsed.rows.length, req.user.id, req.user.name]
    );
    const upload = uploadRes.rows[0];

    const inserted = [];
    let duplicateCount = 0;
    for (const t of parsed.rows) {
      const r = await client.query(
        `insert into esewa_transactions
         (upload_id, reference_code, txn_date, txn_time, description, type, amount, balance, status, channel, month_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (reference_code, txn_date, txn_time, description, type, amount) do nothing
         returning *`,
        [upload.id, t.referenceCode, t.txnDate, t.txnTime, t.description, t.type, t.amount, t.balance, t.status, t.channel, t.monthKey]
      );
      if (r.rows[0]) inserted.push(r.rows[0]);
      else duplicateCount++;
    }

    await client.query(
      "update esewa_uploads set inserted_count = $1, duplicate_count = $2 where id = $3",
      [inserted.length, duplicateCount, upload.id]
    );
    upload.inserted_count = inserted.length;
    upload.duplicate_count = duplicateCount;

    await client.query("commit");

    res.json({
      upload,
      transactions: inserted,
      skippedNonComplete: parsed.skippedNonComplete,
      skippedInvalid: parsed.skippedInvalid,
      duplicateCount,
    });
  } catch (err) {
    await client.query("rollback");
    console.error(err);
    res.status(500).json({ error: "Import failed — please try again." });
  } finally {
    client.release();
  }
}));

router.delete("/transactions/:id", asyncHandler(async (req, res) => {
  const existing = await pool.query("select * from esewa_transactions where id = $1", [req.params.id]);
  const txn = existing.rows[0];
  if (!txn) return res.status(404).json({ error: "eSewa transaction not found" });

  await pool.query("delete from esewa_transactions where id = $1", [req.params.id]);

  await logActivity({
    action: "delete",
    entityType: "esewa",
    entityId: txn.id,
    summary: `Deleted eSewa ${txn.type.toLowerCase()} "${txn.description}" — Rs ${txn.amount} on ${txn.txn_date}`,
    before: txn,
    user: req.user,
  });

  res.json({ ok: true });
}));

// Deletes an upload and every transaction it inserted (cascade) — used to
// undo uploading the wrong file. Transactions from an overlapping upload
// that were skipped as duplicates belong to whichever upload inserted them
// first, so they're unaffected unless that earlier upload is deleted too.
router.delete("/uploads/:id", asyncHandler(async (req, res) => {
  const existing = await pool.query("select * from esewa_uploads where id = $1", [req.params.id]);
  const upload = existing.rows[0];
  if (!upload) return res.status(404).json({ error: "Upload not found" });

  await pool.query("delete from esewa_uploads where id = $1", [req.params.id]);

  await logActivity({
    action: "delete",
    entityType: "esewa",
    entityId: upload.id,
    summary: `Deleted eSewa upload "${upload.file_name}" and its ${upload.inserted_count} transaction(s)`,
    before: upload,
    user: req.user,
  });

  res.json({ ok: true });
}));

module.exports = router;
