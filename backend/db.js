const { Pool, types } = require("pg");

// Keep PostgreSQL DATE columns as plain YYYY-MM-DD strings.
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL &&
    process.env.DATABASE_URL.includes("localhost")
      ? false
      : { rejectUnauthorized: false },
});

// Neon pooled connections don't accept search_path as a startup option.
// Set it after each connection is established.
pool.on("connect", async (client) => {
  try {
    await client.query("SET search_path TO public");
  } catch (err) {
    console.error("SEARCH PATH ERROR:", err.message);
  }
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