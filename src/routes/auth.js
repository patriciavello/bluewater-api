const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool"); // adjust if your pool path differs

const router = express.Router();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

router.post("/register", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const phone = String(req.body.phone || "").trim();
  const password = String(req.body.password || "");

  if (!email || !phone || !password) {
    return res.status(400).json({ error: "email, phone, and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const result = await pool.query(
      `insert into users (email, phone, password_hash)
       values ($1, $2, $3)
       returning id, email, is_admin, is_goldmember, is_captain`,
      [email, phone, passwordHash]
    );

    const user = result.rows[0];

    const token = jwt.sign(
      { userId: user.id, isAdmin: user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.cookie("session", token, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === "true",
      sameSite: process.env.COOKIE_SAMESITE || "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        isAdmin: user.is_admin,
        isGoldmember: user.is_goldmember,
        isCaptain: user.is_captain,
      },
    });
  } catch (e) {
    if (String(e.message).includes("users_email_key") || String(e.message).includes("duplicate key")) {
      return res.status(409).json({ error: "Email already registered" });
    }
    return res.status(500).json({ error: e.message });
  }
});

router.post("/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const r = await pool.query(
    `select id, email, password_hash, is_admin, is_goldmember, is_captain
     from users where email=$1`,
    [email]
  );

  const user = r.rows[0];
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign(
    { userId: user.id, isAdmin: user.is_admin },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.cookie("session", token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: process.env.COOKIE_SAMESITE || "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  return res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      isAdmin: user.is_admin,
      isGoldmember: user.is_goldmember,
      isCaptain: user.is_captain,
    },
  });
});

router.post("/logout", async (req, res) => {
  res.clearCookie("session");
  res.json({ ok: true });
});

module.exports = router;
