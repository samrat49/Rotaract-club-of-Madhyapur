const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const asyncHandler = require("./asyncHandler");
const requireAuth = require("../middleware/auth");
const adminLogin = require("../lib/adminLogin");
const { effectivePermissions, activeExpiries } = require("../lib/permissions");

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      name: user.name,
      email: user.email
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "30d"
    }
  );
}

// REGISTER
router.post("/register", asyncHandler(async (req, res) => {
  const { name, email, password, inviteCode } = req.body;

  if (inviteCode !== process.env.INVITE_CODE) {
    return res.status(403).json({
      error: "Invalid invite code"
    });
  }

  if (!name || !email || !password) {
    return res.status(400).json({
      error: "Name, email and password are required"
    });
  }

  try {
    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "insert into users (name, email, password_hash, last_login_at, last_seen_at) values ($1,$2,$3, now(), now()) returning id, name, email, permissions",
      [name, email, hash]
    );

    const user = result.rows[0];

    res.json({
      token: signToken(user),
      user
    });

  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        error: "That email is already registered"
      });
    }

    throw err;
  }
}));

// LOGIN
router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  console.log("LOGIN EMAIL:", email);
  console.log("PASSWORD RECEIVED:", !!password);

  if (!email || !password) {
    return res.status(400).json({
      error: "Email and password are required"
    });
  }

  // Admin sign-in shares this form. If the email is the admin's and the
  // password matches the admin's, issue an admin token; otherwise fall
  // through so the same email can still be a normal member account.
  const adminCreds = await adminLogin.getCredentials();
  const isAdminAttempt = !!adminCreds &&
    String(email).trim().toLowerCase() === adminCreds.email;
  if (isAdminAttempt) {
    if (adminLogin.isBlocked(req.ip)) {
      return res.status(429).json({
        error: "Too many failed attempts. Try again in 15 minutes."
      });
    }
    if (await adminLogin.verifyAdminPassword(password, adminCreds)) {
      adminLogin.clearFails(req.ip);
      return res.json({
        admin: true,
        token: adminLogin.signAdminToken(adminCreds),
        user: { email: adminCreds.email }
      });
    }
  }

  const result = await pool.query(
    "select * from users where email = $1",
    [email]
  );

  const user = result.rows[0];

  console.log("USER FOUND:", !!user);

  const ok = user
    ? await bcrypt.compare(password, user.password_hash)
    : false;

  console.log("PASSWORD MATCH:", ok);

  if (!ok) {
    console.log("LOGIN FAILED");
    if (isAdminAttempt) adminLogin.recordFail(req.ip);

    return res.status(401).json({
      error: "Invalid email or password"
    });
  }

  const publicUser = {
    id: user.id,
    name: user.name,
    email: user.email
  };
  const responseUser = {
    ...publicUser,
    permissions: effectivePermissions(user),
    permissionExpires: activeExpiries(user)
  };

  // Best-effort: a tracking failure must never block a valid login.
  pool
    .query("update users set last_login_at = now(), last_seen_at = now() where id = $1", [user.id])
    .catch((err) => console.error("last_login update failed:", err.message));

  console.log("LOGIN SUCCESS");

  res.json({
    token: signToken(publicUser),
    user: responseUser
  });
}));

// GET MY PROFILE — also doubles as a lightweight "is this token still good"
// check the account page can call on open.
router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    "select id, name, email, position, permissions, permission_expires from users where id = $1",
    [req.user.id]
  );
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "User not found" });
  const { permission_expires, ...user } = row;
  // serverTime lets the app judge expiry by the server's clock, not the device's.
  res.json({
    ...user,
    permissions: effectivePermissions(row),
    permissionExpires: activeExpiries(row),
    serverTime: new Date().toISOString()
  });
}));

// UPDATE MY PROFILE — for now just the self-reported position field; name
// and email aren't editable here (email is the login identifier).
router.put("/me", requireAuth, asyncHandler(async (req, res) => {
  const position = String(req.body.position || "").slice(0, 120);
  const result = await pool.query(
    "update users set position = $1 where id = $2 returning id, name, email, position",
    [position, req.user.id]
  );
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
}));

// CHANGE MY PASSWORD — requires the current password so a hijacked but
// still-logged-in session can't silently lock the real owner out.
router.post("/change-password", requireAuth, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password are required" });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }

  const result = await pool.query("select * from users where id = $1", [req.user.id]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  // 400, not 401 — a wrong current password is a bad request, not an invalid
  // session; the frontend treats every 401 as "your login token expired" and
  // force-signs-out the whole app, which must not happen just because this
  // one field was typed wrong.
  if (!ok) return res.status(400).json({ error: "Current password is incorrect" });

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query("update users set password_hash = $1 where id = $2", [hash, user.id]);

  res.json({ ok: true });
}));

module.exports = router;