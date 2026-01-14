const express = require("express");
const pool = require("../db/pool"); // adjust if your pool path differs

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const r = await pool.query(
      `select id, name, type, capacity, number_of_beds, location, image_url, description, active
       from boats
       where active=true
       order by name asc`
    );
    res.json({ ok: true, boats: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
