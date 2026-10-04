const jwt = require("jsonwebtoken");
const { adminSecret, getCredentials } = require("../lib/adminLogin");

// Valid only while the token matches the credentials currently in force, so
// changing the admin email or password signs out every other admin session.
async function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  if (!adminSecret()) return res.status(503).json({ error: "Admin is not configured on the server" });
  try {
    const payload = jwt.verify(token, adminSecret());
    if (payload.role !== "admin") throw new Error("not admin");
    const creds = await getCredentials();
    if (!creds || payload.email !== creds.email || (payload.v || 0) !== creds.version) {
      throw new Error("credentials changed");
    }
    req.admin = payload;
    req.adminCreds = creds;
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError" || err.message === "not admin" || err.message === "credentials changed") {
      return res.status(401).json({ error: "Invalid or expired admin token" });
    }
    next(err); // a real failure (e.g. database down) is a 500, not a logout
  }
}

module.exports = requireAdmin;
