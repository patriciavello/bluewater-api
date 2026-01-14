const express = require("express");
const pool = require("../db/pool");
const requireUser = require("../middleware/requireUser");

const router = express.Router();

// List my reservations
router.get("/", requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.boat_id, b.name as boat_name,
              r.start_date, r.end_exclusive, r.status,
              r.notes, r.created_at, r.updated_at
       FROM reservations r
       JOIN boats b ON b.id = r.boat_id
       WHERE r.user_id = $1
       ORDER BY r.start_date DESC
       LIMIT 200`,
      [req.user.userId]
    );

    res.json({ ok: true, reservations: rows });
  } catch (e) {
    console.error("GET /api/me/reservations error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Edit my reservation (pending + future only)
router.patch("/:id", requireUser, async (req, res) => {
  const { id } = req.params;
  const { start_date, end_exclusive } = req.body || {};

  if (!start_date || !end_exclusive) {
    return res.status(400).json({ ok: false, error: "start_date and end_exclusive are required (YYYY-MM-DD)" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, status, start_date
       FROM reservations
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ ok: false, error: "Not found" });

    const status = String(r.status).toUpperCase();
    if (status !== "PENDING") return res.status(400).json({ ok: false, error: "Only PENDING reservations can be edited" });

    // start_date is a date in DB; treat as midnight local
    const startExisting = new Date(`${r.start_date}T00:00:00`);
    const today = new Date(); today.setHours(0,0,0,0);
    if (startExisting <= today) return res.status(400).json({ ok: false, error: "Past/active reservations cannot be edited" });

    const { rows: updated } = await pool.query(
      `UPDATE reservations
       SET start_date = $1::date,
           end_exclusive = $2::date,
           updated_at = now()
       WHERE id = $3 AND user_id = $4
       RETURNING id, boat_id, start_date, end_exclusive, status, notes, created_at, updated_at`,
      [start_date, end_exclusive, id, req.user.userId]
    );

    res.json({ ok: true, reservation: updated[0] });
  } catch (e) {
    console.error("PATCH /api/me/reservations/:id error:", e);
    // Handle overlap constraint nicely
    const msg = String(e.message || "");
    if (msg.toLowerCase().includes("reservations_no_overlap")) {
      return res.status(409).json({ ok: false, error: "Those dates are not available for that boat." });
    }
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Cancel my reservation (pending + future only)
router.delete("/:id", requireUser, async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT id, status, start_date
       FROM reservations
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ ok: false, error: "Not found" });

    const status = String(r.status).toUpperCase();
    if (status !== "PENDING") return res.status(400).json({ ok: false, error: "Only PENDING reservations can be cancelled" });

    const startExisting = new Date(`${r.start_date}T00:00:00`);
    const today = new Date(); today.setHours(0,0,0,0);
    if (startExisting <= today) return res.status(400).json({ ok: false, error: "Past/active reservations cannot be cancelled" });

    await pool.query(
      `UPDATE reservations
       SET status = 'CANCELLED',
           updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/me/reservations/:id error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
