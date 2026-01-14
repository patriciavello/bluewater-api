const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../db/pool");
const requireUser = require("../middleware/requireUser");

const router = express.Router();

router.get("/", requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, phone,
              first_name, last_name,
              address1, address2, city, state, zip, country,
              is_goldmember
       FROM users
       WHERE id = $1`,
      [req.user.userId]
    );
    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    console.error("GET /api/me error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.patch("/", requireUser, async (req, res) => {
  const {
    phone, first_name, last_name,
    address1, address2, city, state, zip, country
  } = req.body || {};

  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET phone = COALESCE($1, phone),
           first_name = COALESCE($2, first_name),
           last_name = COALESCE($3, last_name),
           address1 = COALESCE($4, address1),
           address2 = COALESCE($5, address2),
           city = COALESCE($6, city),
           state = COALESCE($7, state),
           zip = COALESCE($8, zip),
           country = COALESCE($9, country),
           updated_at = now()
       WHERE id = $10
       RETURNING id, email, phone, first_name, last_name,
                 address1, address2, city, state, zip, country,
                 is_goldmember`,
      [phone, first_name, last_name, address1, address2, city, state, zip, country, req.user.userId]
    );

    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    console.error("PATCH /api/me error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/password", requireUser, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: "Missing currentPassword or newPassword" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [req.user.userId]
    );
    const ok = await bcrypt.compare(String(currentPassword), rows[0].password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: "Current password is incorrect" });

    const hash = await bcrypt.hash(String(newPassword), 10);
    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [hash, req.user.userId]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/me/password error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
