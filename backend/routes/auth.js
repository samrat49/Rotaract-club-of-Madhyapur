const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const asyncHandler = require("./asyncHandler");
const requireAuth = require("../middleware/auth");

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
      "insert into users (name, email, password_hash) values ($1,$2,$3) returning id, name, email",
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

  const result = await pool.query(
    "select * from users where email = $1",
    [email]
  );

  const user = result.rows[0];

  console.log("USER FOUND:", !!user);

  if (!user) {
    console.log("LOGIN FAILED: USER NOT FOUND");

    return res.status(401).json({
      error: "Invalid email or password"
    });
  }

  const ok = await bcrypt.compare(
    password,
    user.password_hash
  );

  console.log("PASSWORD MATCH:", ok);

  if (!ok) {
    console.log("LOGIN FAILED: PASSWORD DOES NOT MATCH");

    return res.status(401).json({
      error: "Invalid email or password"
    });
  }

  const publicUser = {
    id: user.id,
    name: user.name,
    email: user.email
  };

  console.log("LOGIN SUCCESS");

  res.json({
    token: signToken(publicUser),
    user: publicUser
  });
}));

// GET MY PROFILE — also doubles as a lightweight "is this token still good"
// check the account page can call on open.
router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    "select id, name, email, position from users where id = $1",
    [req.user.id]
  );
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
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