const express = require("express");
const { pool } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { userId } = req.user;

  const r = await pool.query(
    `select id, email, phone, is_admin, is_goldmember, is_captain,
            first_name, last_name, address1, address2, city, state, zip, country
     from users where id=$1`,
    [userId]
  );

  if (!r.rows[0]) return res.status(404).json({ error: "User not found" });

  // Important: only show is_goldmember to user if true
  const u = r.rows[0];
  const response = {
    id: u.id,
    email: u.email,
    phone: u.phone,
    isAdmin: u.is_admin,
    isCaptain: u.is_captain,
    firstName: u.first_name,
    lastName: u.last_name,
    address1: u.address1,
    address2: u.address2,
    city: u.city,
    state: u.state,
    zip: u.zip,
    country: u.country,
  };
  if (u.is_goldmember) response.isGoldmember = true;

  res.json({ ok: true, user: response });
});

router.patch("/", requireAuth, async (req, res) => {
  const { userId } = req.user;

  const fields = {
    phone: req.body.phone,
    first_name: req.body.firstName,
    last_name: req.body.lastName,
    address1: req.body.address1,
    address2: req.body.address2,
    city: req.body.city,
    state: req.body.state,
    zip: req.body.zip,
    country: req.body.country
  };

  // Build dynamic update
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (keys.length === 0) return res.json({ ok: true });

  const setSql = keys.map((k, i) => `${k}=$${i + 1}`).join(", ");
  const values = keys.map((k) => fields[k]);

  const q = `update users set ${setSql}, updated_at=now() where id=$${keys.length + 1} returning id`;
  await pool.query(q, [...values, userId]);

  res.json({ ok: true });
});

module.exports = router;
