const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL is not set. Set it in .env for local dev or Render env vars.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined
  // On Render INTERNAL url, SSL is usually not needed.
});

module.exports = { pool };
