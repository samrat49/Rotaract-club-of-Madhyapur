const XLSX = require("xlsx");

// Column labels as they appear in eSewa's own "Statement Report" export
// (Merchant/App > Reports > Statement Report > Download as XLS). Matched
// case-insensitively so minor label changes across app versions don't break
// import.
const COLUMN_MATCHERS = {
  ref: (h) => h === "reference code",
  dt: (h) => h === "date time",
  desc: (h) => h === "description",
  dr: (h) => h.startsWith("dr"),
  cr: (h) => h.startsWith("cr"),
  status: (h) => h === "status",
  balance: (h) => h.startsWith("balance"),
  channel: (h) => h === "channel",
};

function findHeaderRow(rows) {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((c) => String(c || "").trim().toLowerCase());
    if (cells.includes("reference code") && cells.includes("date time") && cells.includes("description")) {
      return i;
    }
  }
  return -1;
}

function buildColumnIndex(headerRow) {
  const cells = headerRow.map((c) => String(c || "").trim().toLowerCase());
  const index = {};
  for (const [key, matches] of Object.entries(COLUMN_MATCHERS)) {
    index[key] = cells.findIndex(matches);
  }
  return index;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// The "Date Time" column comes through as plain text like
// "2026-09-04 20:39:49.0" in every sample we've seen, but we also handle a
// real Excel date cell or serial number in case a future export changes format.
function parseDateTimeCell(raw) {
  if (raw instanceof Date && !isNaN(raw)) {
    return { date: raw.toISOString().slice(0, 10), time: raw.toISOString().slice(11, 19) };
  }
  if (typeof raw === "number") {
    const d = XLSX.SSF.parse_date_code(raw);
    if (d) return { date: `${d.y}-${pad2(d.m)}-${pad2(d.d)}`, time: `${pad2(d.H)}:${pad2(d.M)}:${pad2(Math.floor(d.S))}` };
  }
  if (typeof raw === "string") {
    const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    if (m) return { date: m[1], time: m[2] };
    const d = new Date(raw);
    if (!isNaN(d)) return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 19) };
  }
  return null;
}

// Metadata rows hold multiple "Label" / value pairs across their columns,
// e.g. ["From Date", "...", "To Date", "...", ...] — not just in column 0.
function findMetaValue(rows, headerRowIndex, label) {
  for (let i = 0; i < headerRowIndex; i++) {
    const row = rows[i];
    for (let c = 0; c < row.length - 1; c++) {
      if (String(row[c] || "").trim().toLowerCase() === label.toLowerCase()) {
        const v = row[c + 1];
        return v !== undefined && v !== "" ? String(v).trim() : null;
      }
    }
  }
  return null;
}

// Parses an eSewa "Statement Report" .xls/.xlsx buffer into transaction
// rows. Only COMPLETE rows count as real money movement — PENDING/CANCELED
// rows are skipped since they never actually moved money.
function parseEsewaWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error("The uploaded file has no readable sheet.");

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  const headerRowIndex = findHeaderRow(rows);
  if (headerRowIndex === -1) {
    throw new Error("Could not find the statement's header row (Reference Code / Date Time / Description). Is this an eSewa Statement Report export?");
  }
  const col = buildColumnIndex(rows[headerRowIndex]);
  if (col.dt === -1 || col.desc === -1 || (col.dr === -1 && col.cr === -1)) {
    throw new Error("Could not identify the Date Time / Description / Dr. / Cr. columns in this file.");
  }

  const fromDateRaw = findMetaValue(rows, headerRowIndex, "From Date");
  const toDateRaw = findMetaValue(rows, headerRowIndex, "To Date");

  const result = [];
  let skippedNonComplete = 0;
  let skippedInvalid = 0;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const descCell = String(row[col.desc] ?? "").trim();
    if (descCell.toLowerCase() === "total") break; // trailing totals row ends the data

    const refCell = col.ref !== -1 ? String(row[col.ref] ?? "").trim() : "";
    const dtCell = row[col.dt];
    const dtBlank = dtCell === undefined || dtCell === null || String(dtCell).trim() === "";
    if (!refCell && dtBlank) continue; // blank separator row

    const parsedDt = parseDateTimeCell(dtCell);
    if (!parsedDt) { skippedInvalid++; continue; }

    const statusCell = col.status !== -1 ? String(row[col.status] ?? "").trim().toUpperCase() : "";
    if (statusCell && statusCell !== "COMPLETE") { skippedNonComplete++; continue; }

    const dr = col.dr !== -1 ? Number(row[col.dr]) || 0 : 0;
    const cr = col.cr !== -1 ? Number(row[col.cr]) || 0 : 0;
    if (dr <= 0 && cr <= 0) { skippedInvalid++; continue; }

    const balanceCell = col.balance !== -1 ? row[col.balance] : "";
    const balance = balanceCell !== undefined && balanceCell !== "" && !isNaN(Number(balanceCell)) ? Number(balanceCell) : null;
    const channel = col.channel !== -1 ? String(row[col.channel] ?? "").trim() : "";

    result.push({
      referenceCode: refCell || null,
      txnDate: parsedDt.date,
      txnTime: parsedDt.time,
      description: descCell || (dr > 0 ? "eSewa Expense" : "eSewa Income"),
      type: dr > 0 ? "Expense" : "Income",
      amount: dr > 0 ? dr : cr,
      balance,
      status: statusCell || null,
      channel: channel || null,
      monthKey: parsedDt.date.slice(0, 7),
    });
  }

  return { sheetName, fromDateRaw, toDateRaw, rows: result, skippedNonComplete, skippedInvalid };
}

module.exports = { parseEsewaWorkbook };
