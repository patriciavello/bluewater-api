const express = require("express");
const router = express.Router();

router.get("/cors", (req, res) => {
  const raw = process.env.CLIENT_ORIGIN || "";
  const allowedOrigins = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  res.json({
    ok: true,
    raw_CLIENT_ORIGIN: raw,
    allowedOrigins,
    requestOrigin: req.headers.origin || null,
  });
});

module.exports = router;
