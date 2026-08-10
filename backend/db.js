const { Pool, types } = require("pg");

// By default node-postgres parses DATE columns into JS Date objects,
// which can be re-interpreted in local time and shift by a day.
// Keep DATE columns as plain "YYYY-MM-DD" strings for the frontend.
types.setTypeParser(1082, (val) => val);

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL &&
    process.env.DATABASE_URL.includes("localhost")
      ? false
      : { rejectUnauthorized: false },
});

// Check which database the backend is actually connected to.
pool
  .query("SELECT current_database(), current_user")
  .then((result) => {
    console.log("DATABASE USED BY BACKEND:", result.rows[0]);
  })
  .catch((err) => {
    console.error("DATABASE CONNECTION ERROR:", err.message);
  });

module.exports = pool;