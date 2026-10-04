const router = require("express").Router();
const pool = require("../db");
const asyncHandler = require("./asyncHandler");
const bcrypt = require("bcryptjs");
const requireAdmin = require("../middleware/adminAuth");
const adminLogin = require("../lib/adminLogin");
const {
  PERMISSIONS, PERMISSION_KEYS, MIN_GRANT_MINUTES, MAX_GRANT_MINUTES,
  effectivePermissions, activeExpiries,
} = require("../lib/permissions");

// There is no separate admin login: the admin signs in through the normal
// /api/auth/login (see routes/auth.js), which returns an admin token.

// A member counts as "online" if the app was active within this window. The
// frontend pings every 2 minutes while open, so this tolerates one missed ping.
const ONLINE_WINDOW_MINUTES = 5;

// Lets the admin page check a saved token is still valid on open.
router.get("/me", requireAdmin, (req, res) => {
  res.json({ email: req.admin.email });
});

// All member accounts with login/activity info. Never returns password hashes.
router.get("/users", requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `select id, name, email, position, permissions, permission_expires, created_at, last_login_at, last_seen_at,
            (last_seen_at is not null
              and last_seen_at > now() - make_interval(mins => $1)) as online
       from users
      order by online desc, last_seen_at desc nulls last, created_at desc`,
    [ONLINE_WINDOW_MINUTES]
  );
  // Report only grants still in force; expired ones count as not granted.
  const users = result.rows.map(({ permission_expires, ...u }) => ({
    ...u,
    permissions: effectivePermissions({ permissions: u.permissions, permission_expires }),
    permissionExpires: activeExpiries({ permissions: u.permissions, permission_expires }),
  }));
  res.json({
    summary: {
      total: users.length,
      online: users.filter((u) => u.online).length,
      onlineWindowMinutes: ONLINE_WINDOW_MINUTES
    },
    permissionCatalog: PERMISSIONS,
    grantLimits: { minMinutes: MIN_GRANT_MINUTES, maxMinutes: MAX_GRANT_MINUTES },
    users
  });
}));

// Sets one member's permissions to the given list. Permissions the member
// already holds keep their existing expiry; newly added ones get the optional
// `expiresInMinutes` (omit/null = permanent, else 60 to 43200 = 1 hour to 30
// days). Unknown keys are rejected rather than silently dropped.
router.put("/users/:id/permissions", requireAdmin, asyncHandler(async (req, res) => {
  const list = req.body.permissions;
  if (!Array.isArray(list) || list.some((k) => typeof k !== "string")) {
    return res.status(400).json({ error: "permissions must be a list of permission keys" });
  }
  const unknown = list.filter((k) => !PERMISSION_KEYS.includes(k));
  if (unknown.length) {
    return res.status(400).json({ error: "Unknown permission: " + unknown.join(", ") });
  }

  let minutes = req.body.expiresInMinutes;
  if (minutes === undefined || minutes === null) {
    minutes = null;
  } else if (!Number.isInteger(minutes) || minutes < MIN_GRANT_MINUTES || minutes > MAX_GRANT_MINUTES) {
    return res.status(400).json({
      error: `Duration must be between ${MIN_GRANT_MINUTES / 60} hour and ${MAX_GRANT_MINUTES / 1440} days`
    });
  }

  const clean = PERMISSION_KEYS.filter((k) => list.includes(k)); // de-duplicated, canonical order
  const client = await pool.connect();
  try {
    await client.query("begin");
    let current;
    try {
      current = await client.query(
        "select permissions, permission_expires from users where id = $1 for update",
        [req.params.id]
      );
    } catch (err) {
      await client.query("rollback");
      if (err.code === "22P02") return res.status(400).json({ error: "Invalid user id" }); // not a uuid
      throw err;
    }
    if (!current.rows[0]) {
      await client.query("rollback");
      return res.status(404).json({ error: "User not found" });
    }

    const now = Date.now();
    const held = new Set(effectivePermissions(current.rows[0], now));
    const oldExpires = current.rows[0].permission_expires || {};
    const expires = {};
    for (const k of clean) {
      if (held.has(k)) {
        if (oldExpires[k]) expires[k] = oldExpires[k]; // keep the existing deadline
      } else if (minutes !== null) {
        expires[k] = new Date(now + minutes * 60000).toISOString();
      }
    }

    const result = await client.query(
      `update users set permissions = $1, permission_expires = $2::jsonb
        where id = $3 returning id, name, email, permissions, permission_expires`,
      [clean, JSON.stringify(expires), req.params.id]
    );
    await client.query("commit");
    const row = result.rows[0];
    res.json({
      id: row.id, name: row.name, email: row.email,
      permissions: effectivePermissions(row),
      permissionExpires: activeExpiries(row)
    });
  } catch (err) {
    try { await client.query("rollback"); } catch (e) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}));

// Admin sign-in settings. Changing either value needs the current password, and
// bumps the credentials version so every other admin session is signed out;
// the caller gets a fresh token so they stay signed in.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get("/settings", requireAdmin, (req, res) => {
  const c = req.adminCreds;
  res.json({ email: c.email, source: c.source, updatedAt: c.updatedAt });
});

router.put("/settings", requireAdmin, asyncHandler(async (req, res) => {
  const ip = req.ip;
  if (adminLogin.isBlocked(ip)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }

  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = req.body.newPassword == null ? "" : String(req.body.newPassword);
  const newEmail = req.body.newEmail == null ? "" : String(req.body.newEmail).trim().toLowerCase();
  if (!currentPassword) return res.status(400).json({ error: "Enter your current password to make changes" });

  const creds = req.adminCreds;
  // 400, not 401: the admin page treats every 401 as "session expired" and signs out.
  if (!(await adminLogin.verifyAdminPassword(currentPassword, creds))) {
    adminLogin.recordFail(ip);
    return res.status(400).json({ error: "Current password is incorrect" });
  }
  adminLogin.clearFails(ip);

  const emailChanged = !!newEmail && newEmail !== creds.email;
  const passwordChanged = newPassword !== "";
  if (!emailChanged && !passwordChanged) {
    return res.status(400).json({ error: "Nothing to change. Enter a new email or a new password." });
  }
  if (emailChanged && (newEmail.length > 254 || !EMAIL_RE.test(newEmail))) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
  if (passwordChanged) {
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
    if (Buffer.byteLength(newPassword, "utf8") > 72) return res.status(400).json({ error: "New password is too long (72 bytes max)" });
    if (newPassword === currentPassword) return res.status(400).json({ error: "New password must be different from the current one" });
  }

  const email = emailChanged ? newEmail : creds.email;
  const hash = passwordChanged ? await bcrypt.hash(newPassword, 12) : creds.hash;
  const saved = await pool.query(
    `insert into admin_credentials (id, email, password_hash, version)
     values (1, $1, $2, $3)
     on conflict (id) do update
       set email = excluded.email,
           password_hash = excluded.password_hash,
           version = admin_credentials.version + 1,
           updated_at = now()
     returning email, password_hash, version, updated_at`,
    [email, hash, creds.version + 1]
  );
  const row = saved.rows[0];
  const fresh = { email: row.email, hash: row.password_hash, version: row.version, source: "database", updatedAt: row.updated_at };
  res.json({
    ok: true,
    email: fresh.email,
    emailChanged,
    passwordChanged,
    token: adminLogin.signAdminToken(fresh)
  });
}));

// Club activity trail (edits/deletes/creates by members), newest first.
// Read-only: the table is append-only at the database level.
const ACTIONS = ["create", "update", "delete"];
router.get("/activity", requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  const action = ACTIONS.includes(req.query.action) ? req.query.action : null;
  const result = await pool.query(
    `select id, action, entity_type, summary, performed_by_name, performed_by_email, created_at
       from activity_log
      where ($1::text is null or action = $1)
      order by created_at desc
      limit $2`,
    [action, limit]
  );
  res.json({ entries: result.rows });
}));

module.exports = router;
