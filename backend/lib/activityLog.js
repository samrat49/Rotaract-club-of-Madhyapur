const pool = require("../db");

// Records a deletion/edit for the Recent Activity log. Called from inside
// each route right after the delete/update succeeds. Rows written here are
// never updated or deleted by the app — the database itself rejects such
// attempts (see the triggers in schema.sql), so this is an append-only trail.
async function logActivity({ action, entityType, entityId, summary, before, after, user }) {
  await pool.query(
    `insert into activity_log
     (action, entity_type, entity_id, summary, before_data, after_data, performed_by_id, performed_by_name, performed_by_email)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      action,
      entityType,
      entityId || null,
      summary,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      (user && user.id) || null,
      (user && user.name) || null,
      (user && user.email) || null,
    ]
  );
}

module.exports = { logActivity };
