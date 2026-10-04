// Shared helpers for scoping routes to the current rotary tenure. `db` may
// be the pool or a checked-out client (inside a transaction) — both expose
// the same .query() interface.

async function resolveActiveTenureId(db) {
  const r = await db.query("select id from tenures where status = 'active' limit 1");
  return r.rows[0] ? r.rows[0].id : null;
}

async function assertTenureEditable(db, tenureId) {
  const r = await db.query("select status from tenures where id = $1", [tenureId]);
  if (!r.rows[0]) {
    const err = new Error("Tenure not found");
    err.status = 404;
    throw err;
  }
  if (r.rows[0].status === "closed") {
    const err = new Error("This belongs to a closed tenure and can no longer be edited.");
    err.status = 409;
    throw err;
  }
}

module.exports = { resolveActiveTenureId, assertTenureEditable };
