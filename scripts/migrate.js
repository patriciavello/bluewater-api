require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db/pool");

async function main() {
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migration files found.");
    process.exit(0);
  }

  console.log("Running migrations:", files);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      console.log(`\n--- Applying ${f} ---`);
      await client.query(sql);
    }
    await client.query("COMMIT");
    console.log("\n✅ Migrations applied successfully.");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
