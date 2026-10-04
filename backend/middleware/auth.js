const jwt = require("jsonwebtoken");
const pool = require("../db");

// Records "last seen" for the admin page's online indicator. Throttled to one
// write per user per minute, fire-and-forget, so it adds no latency and a DB
// hiccup here can never fail a real request.
const SEEN_EVERY_MS = 60 * 1000;
const lastTouched = new Map();

function touchLastSeen(userId) {
  if (!userId) return;
  const now = Date.now();
  if (now - (lastTouched.get(userId) || 0) < SEEN_EVERY_MS) return;
  lastTouched.set(userId, now);
  pool
    .query("update users set last_seen_at = now() where id = $1", [userId])
    .catch((err) => console.error("last_seen update failed:", err.message));
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  touchLastSeen(req.user.id);
  next();
}

module.exports = requireAuth;
