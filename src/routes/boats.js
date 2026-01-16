const express = require("express");
const router = express.Router();

const pool = require("../db/pool");
const requireAdmin = require("../middleware/requireAdmin");

// ✅ Public: list active boats
router.get("/boats", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, type, capacity, number_of_beds, location, image_url, description, active
       FROM boats
       WHERE active = true
       ORDER BY name ASC`
    );
    res.json({ ok: true, boats: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ✅ Admin: list all boats (active + inactive)
router.get("/admin/boats", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, type, capacity, number_of_beds, location, image_url, description, active
       FROM boats
       ORDER BY name ASC`
    );
    res.json({ ok: true, boats: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ✅ Admin: create boat
router.post("/admin/boats", requireAdmin, async (req, res) => {
  const {
    name,
    type = null,
    capacity = null,
    number_of_beds = null,
    location = null,
    image_url = null,
    description = null,
    active = true,
  } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ ok: false, error: "name is required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO boats (name, type, capacity, number_of_beds, location, image_url, description, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, type, capacity, number_of_beds, location, image_url, description, active`,
      [
        String(name).trim(),
        type,
        capacity,
        number_of_beds,
        location,
        image_url,
        description,
        active,
      ]
    );
    res.json({ ok: true, boat: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ✅ Admin: update boat (partial)
router.patch("/admin/boats/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  // Allow partial updates
  const fields = [
    "name",
    "type",
    "capacity",
    "number_of_beds",
    "location",
    "image_url",
    "description",
    "active",
  ];

  const sets = [];
  const values = [];
  let idx = 1;

  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) {
      sets.push(`${f} = $${idx++}`);
      values.push(req.body[f]);
    }
  }

  if (sets.length === 0) {
    return res.status(400).json({ ok: false, error: "No fields to update" });
  }

  values.push(id);

  try {
    const { rows } = await pool.query(
      `UPDATE boats
       SET ${sets.join(", ")}
       WHERE id = $${idx}
       RETURNING id, name, type, capacity, number_of_beds, location, image_url, description, active`,
      values
    );

    if (!rows[0]) return res.status(404).json({ ok: false, error: "Boat not found" });

    res.json({ ok: true, boat: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ✅ Admin: soft delete (active=false)
router.delete("/admin/boats/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await pool.query(
      `UPDATE boats SET active = false WHERE id = $1`,
      [id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: "Boat not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
