const pool = require("../db");

// What an admin can grant to a member. Reading data is open to every signed-in
// member; these control who can make changes. `settings` also gates seeing the
// Settings page (opening balances, tenure start/close, club name).
const PERMISSIONS = [
  { key: "members", label: "Membership & Dues", description: "Add, edit and remove members, set dues, record dues payments" },
  { key: "transactions", label: "Transactions", description: "Add, import and delete transactions; manage liabilities" },
  { key: "event_transactions", label: "Event transactions", description: "Add and delete transactions linked to an event" },
  { key: "esewa", label: "eSewa", description: "Upload eSewa statements and transfer entries into transactions" },
  { key: "events", label: "Event creation", description: "Create and delete events" },
  { key: "bills", label: "Billing", description: "Upload and delete bills" },
  { key: "settings", label: "Settings", description: "See Settings; set opening balances, start/close tenures, rename the club" },
];
const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// An admin can grant a permission for a limited time. users.permissions holds
// the granted keys and users.permission_expires maps a key to the ISO time it
// stops applying (no entry = permanent). Expiry is checked here on every
// request, so a timed grant ends at its exact time with no background job.
const MIN_GRANT_MINUTES = 60;          // shortest timed grant: 1 hour
const MAX_GRANT_MINUTES = 60 * 24 * 30; // longest timed grant: 30 days

function isActive(expires, key, now) {
  const at = expires && expires[key];
  if (!at) return true;
  const t = Date.parse(at);
  return Number.isFinite(t) && t > now;
}

// Keys currently in force for a users row.
function effectivePermissions(row, now = Date.now()) {
  if (!row) return [];
  const expires = row.permission_expires || {};
  return (row.permissions || []).filter((k) => isActive(expires, k, now));
}

// The expiry times (key -> ISO string) of the timed grants still in force.
function activeExpiries(row, now = Date.now()) {
  const out = {};
  const expires = (row && row.permission_expires) || {};
  for (const k of effectivePermissions(row, now)) if (expires[k]) out[k] = expires[k];
  return out;
}

// Reads the member's permissions fresh from the database on every check, so an
// admin's change (including a revoke) takes effect immediately instead of
// waiting for a login token to expire.
async function getPermissions(userId) {
  if (!userId) return [];
  const r = await pool.query("select permissions, permission_expires from users where id = $1", [userId]);
  return effectivePermissions(r.rows[0]);
}

function forbidden() {
  const err = new Error("You don't have permission to do that. Ask an admin to grant access.");
  err.status = 403;
  return err;
}

// Throws a 403 unless the member holds at least one of `keys`.
async function assertPermission(req, ...keys) {
  const have = await getPermissions(req.user && req.user.id);
  if (!keys.some((k) => have.includes(k))) throw forbidden();
}

// Route middleware form of the above. Errors are passed to next() so the
// shared error handler in index.js turns them into a JSON 403.
function requirePermission(...keys) {
  return (req, res, next) => {
    assertPermission(req, ...keys).then(() => next(), next);
  };
}

module.exports = {
  PERMISSIONS, PERMISSION_KEYS, MIN_GRANT_MINUTES, MAX_GRANT_MINUTES,
  effectivePermissions, activeExpiries, getPermissions, assertPermission, requirePermission,
};
