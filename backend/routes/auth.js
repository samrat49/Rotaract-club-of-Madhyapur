const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const asyncHandler = require("./asyncHandler");

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

module.exports = router;