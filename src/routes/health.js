const express = require("express");
const router = express.Router();
const pool = require("../db/pool"); // adjust if your pool path differs

router.get("/", async (req, res) => {
  try {
    const r = await pool.query("select now() as now");
    res.json({
      ok: true,
      now: r.rows[0].now,
      buildMarker: "health-v2",
      service: process.env.RENDER_SERVICE_NAME || "bluewater-api",
      gitCommit:
        process.env.RENDER_GIT_COMMIT ||
        process.env.GIT_COMMIT ||
        null,
      gitBranch:
        process.env.RENDER_GIT_BRANCH ||
        process.env.GIT_BRANCH ||
        null,
      nodeEnv: process.env.NODE_ENV || null,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
