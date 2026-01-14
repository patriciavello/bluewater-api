const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const pool = require("../db/pool");

const router = express.Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: "Missing email or password" });

  const emailClean = String(email).toLowerCase().trim();

  try {
    const { rows } = await pool.query(
      `SELECT id, email, password_hash, is_goldmembeir FROM users WHERE email = $1`,
      [emailClean]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    const token = jwt.sign(
      { userId: user.id, email: user.email, isGoldMember: user.is_goldmember },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ ok: true, token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
