const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");

// Admin credentials come from the admin_credentials table once the admin has
// changed them on the Settings page; until then from env vars:
//   ADMIN_EMAIL          the admin's login email
//   ADMIN_PASSWORD_HASH  bcrypt hash (generate: npm run admin:hash -- "password")
// They are kept apart from the users table, so a normal member account can
// never be promoted to admin. The admin signs in through the same
// /api/auth/login as everyone else.

const DUMMY_HASH = bcrypt.hashSync("not-the-admin-password", 12);

// Admin tokens are signed with a different secret than member tokens, so a
// member token can never pass as admin (and vice versa).
function adminSecret() {
  return process.env.ADMIN_JWT_SECRET || `${process.env.JWT_SECRET}:admin`;
}

// The credentials currently in force, or null if admin login isn't configured.
// `version` ties tokens to the credentials they were issued for (env = 0).
async function getCredentials() {
  try {
    const r = await pool.query("select email, password_hash, version, updated_at from admin_credentials where id = 1");
    if (r.rows[0]) {
      const row = r.rows[0];
      return { email: row.email.trim().toLowerCase(), hash: row.password_hash, version: row.version, source: "database", updatedAt: row.updated_at };
    }
  } catch (err) {
    // Table not created yet on this database: fall back to env vars below.
    if (err.code !== "42P01") throw err;
  }
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const hash = process.env.ADMIN_PASSWORD_HASH || "";
  if (!email || !hash) return null;
  return { email, hash, version: 0, source: "environment", updatedAt: null };
}

async function isAdminEmail(email) {
  const creds = await getCredentials();
  return !!creds && String(email || "").trim().toLowerCase() === creds.email;
}

// Always runs bcrypt, so timing doesn't reveal whether admin login exists.
async function verifyAdminPassword(password, creds) {
  const c = creds || (await getCredentials());
  return bcrypt.compare(String(password || ""), c ? c.hash : DUMMY_HASH);
}

function signAdminToken(creds) {
  return jwt.sign({ email: creds.email, role: "admin", v: creds.version }, adminSecret(), { expiresIn: "12h" });
}

// Tiny in-memory brute-force guard: 5 failed admin attempts per IP per 15
// minutes. Shared by the login form and the Settings password check.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const fails = new Map();

function isBlocked(ip) {
  const rec = fails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    fails.delete(ip);
    return false;
  }
  return rec.count >= MAX_FAILS;
}

function recordFail(ip) {
  const rec = fails.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) fails.set(ip, { first: Date.now(), count: 1 });
  else rec.count += 1;
}

function clearFails(ip) {
  fails.delete(ip);
}

module.exports = {
  adminSecret, getCredentials, isAdminEmail, verifyAdminPassword, signAdminToken,
  isBlocked, recordFail, clearFails,
};
