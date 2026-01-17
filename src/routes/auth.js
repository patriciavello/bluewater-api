const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool"); // adjust if your pool path differs
const crypto = require("crypto");
const { sendResetEmail } = require("../lib/mailer");

const router = express.Router();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function makeResetToken() {
  return crypto.randomBytes(32).toString("hex"); // 64 chars
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
  console.log("LOGIN email:", email);

  const user = r.rows[0];
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  console.log("FOUND user?", !!user);
  console.log("HASH starts:", user?.password_hash?.slice(0, 4));

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  console.log("COMPARE ok:", ok);


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

router.post("/password/request-reset", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email) return res.json({ ok: true });

  try {
    const u = await pool.query(`SELECT id FROM users WHERE email=$1`, [email]);

    // Always respond ok (prevents email enumeration)
    if (!u.rows[0]) return res.json({ ok: true });

    const token = makeResetToken();
    const tokenHash = sha256(token);

    await pool.query(
      `UPDATE users
       SET reset_token_hash=$1,
           reset_token_expires_at=now() + interval '30 minutes',
           updated_at=now()
       WHERE id=$2`,
      [tokenHash, u.rows[0].id]
    );

    const base = process.env.APP_BASE_URL || "http://localhost:5173";
    const link =
      `${base}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

    await sendResetEmail(email, link);

    return res.json({ ok: true });
  } catch (e) {
    console.error("request-reset error:", e);
    // still respond ok
    return res.json({ ok: true });
  }
});

router.post("/password/reset", async (req, res) => {
  const token = String(req.body.token || "");
  const email = normalizeEmail(req.body.email);
  const newPassword = String(req.body.newPassword || "");

  if (!token || !email || newPassword.length < 8) {
    return res.status(400).json({ ok: false, error: "Invalid request" });
  }

  try {
    const tokenHash = sha256(token);

    const r = await pool.query(
      `SELECT id, is_admin
       FROM users
       WHERE email=$1
         AND reset_token_hash=$2
         AND reset_token_expires_at > now()`,
      [email, tokenHash]
    );

    if (!r.rows[0]) {
      return res.status(400).json({ ok: false, error: "Reset link is invalid or expired" });
    }

    const hash = await bcrypt.hash(newPassword, 12);

    await pool.query(
      `UPDATE users
       SET password_hash=$1,
           reset_token_hash=NULL,
           reset_token_expires_at=NULL,
           updated_at=now()
       WHERE id=$2`,
      [hash, r.rows[0].id]
    );

    // Optional: auto-login after reset (cookie session)
    const sessionToken = jwt.sign(
      { userId: r.rows[0].id, isAdmin: r.rows[0].is_admin },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.cookie("session", sessionToken, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === "true",
      sameSite: process.env.COOKIE_SAMESITE || "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("reset error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});


module.exports = router;
