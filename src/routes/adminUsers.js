const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

// Same requireAdmin pattern as your existing admin.js
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

/**
 * GET /api/admin/users?q=search
 * Returns up to 200 users
 */
router.get("/users", requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    const sql = `
      SELECT
        id,
        email,
        phone,
        first_name as "firstName",
        last_name as "lastName",
        is_admin as "isAdmin",
        is_goldmember as "isGoldMember",
        is_captain as "isCaptain",
        created_at as "createdAt"
      FROM users
      WHERE ($1 = '' OR
        email ILIKE '%' || $1 || '%' OR
        COALESCE(first_name,'') ILIKE '%' || $1 || '%' OR
        COALESCE(last_name,'') ILIKE '%' || $1 || '%'
      )
      ORDER BY created_at DESC
      LIMIT 200
    `;

    const { rows } = await pool.query(sql, [q]);
    res.json({ ok: true, users: rows });
  } catch (e) {
    console.error("GET /api/admin/users error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});


/**
 * POST /api/admin/users
 * Body: { email, password, name?, membership_tier? }
 *
 * IMPORTANT:
 * - Your users table must have a password column.
 * - Many projects use password_hash. Some use password.
 * - Choose ONE below and delete the other.
 */
router.post("/users", requireAdmin, async (req, res) => {
  try {
    const { email, phone, password, firstName = "", lastName = "", isGoldMember = false, isAdmin = false ,  isCaptain = false} = req.body || {};

    if (!email || !phone || !password) {
      return res.status(400).json({ ok: false, error: "email, phone, and password are required" });
    }

    const emailClean = String(email).toLowerCase().trim();
    const phoneClean = String(phone).trim();

    const hash = await bcrypt.hash(String(password), 10);

    const sql = `
      INSERT INTO users
        (email, phone, password_hash, is_admin, is_goldmember, is_captain, first_name, last_name)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        id,
        email,
        phone,
        first_name as "firstName",
        last_name as "lastName",
        is_admin as "isAdmin",
        is_goldmember as "isGoldMember",
        is_Captain as "isCaptain" ,
        created_at as "createdAt"
    `;

    const { rows } = await pool.query(sql, [
      emailClean,
      phoneClean,
      hash,
      !!isAdmin,
      !!isGoldMember,
      !!isCaptain,
      firstName || null,
      lastName || null,
    ]);

    res.status(201).json({ ok: true, user: rows[0] });
  } catch (e) {
    console.error("POST /api/admin/users error:", e);
    if (String(e.message || "").toLowerCase().includes("unique")) {
      return res.status(409).json({ ok: false, error: "Email already exists" });
    }
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});


/**
 * PATCH /api/admin/users/:id/membership
 * Body: { membership_tier: "standard" | "gold" }
 */
router.patch("/users/:id/gold", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { isGoldMember } = req.body || {};

    if (typeof isGoldMember !== "boolean") {
      return res.status(400).json({ ok: false, error: "isGoldMember must be boolean" });
    }

    const sql = `
      UPDATE users
      SET is_goldmember = $1, updated_at = now()
      WHERE id = $2::uuid
      RETURNING
        id,
        email,
        phone,
        first_name as "firstName",
        last_name as "lastName",
        is_admin as "isAdmin",
        is_goldmember as "isGoldMember",
        created_at as "createdAt"
    `;

    const { rows } = await pool.query(sql, [isGoldMember, id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "User not found" });

    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    console.error("PATCH /api/admin/users/:id/gold error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

// PATCH /api/admin/users/:id/captain  body: { isCaptain: boolean }
router.patch("/users/:id/captain", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { isCaptain } = req.body || {};

    if (typeof isCaptain !== "boolean") {
      return res.status(400).json({ ok: false, error: "isCaptain must be boolean" });
    }

    const sql = `
      UPDATE users
      SET is_captain = $1, updated_at = now()
      WHERE id = $2::uuid
      RETURNING
        id,
        email,
        phone,
        first_name as "firstName",
        last_name as "lastName",
        is_admin as "isAdmin",
        is_goldmember as "isGoldMember",
        is_captain as "isCaptain",
        created_at as "createdAt"
    `;

    const { rows } = await pool.query(sql, [isCaptain, id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "User not found" });

    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    console.error("PATCH /api/admin/users/:id/captain error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});


/**
 * DELETE /api/admin/users/:id
 */
router.delete("/users/:id", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;

    const sql = `DELETE FROM users WHERE id = $1::uuid RETURNING id`;
    const { rows } = await pool.query(sql, [id]);

    if (!rows.length) return res.status(404).json({ ok: false, error: "User not found" });

    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/admin/users/:id error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});


module.exports = router;
