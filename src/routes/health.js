const express = require("express");
const router = express.Router();
const pool = require("../db/pool"); // adjust if your pool path differs

router.get("/", async (req, res) => {
  try {
    const r = await pool.query("select now() as now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
