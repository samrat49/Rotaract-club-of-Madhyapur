// Usage: npm run admin:reset
// Deletes the admin credentials saved from the Settings page, so the admin
// signs in with ADMIN_EMAIL / ADMIN_PASSWORD_HASH from .env again. Use this if
// the admin password is forgotten.
require("dotenv").config();
const pool = require("../db");

pool
  .query("delete from admin_credentials")
  .then((r) => {
    console.log(r.rowCount ? "Reset: admin sign-in now uses ADMIN_EMAIL / ADMIN_PASSWORD_HASH from .env." : "Nothing to reset: already using .env credentials.");
    return pool.end();
  })
  .catch((err) => {
    console.error("Reset failed:", err.message);
    process.exit(1);
  });
