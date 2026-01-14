const express = require("express");
const router = express.Router();
const pool = require("../db/pool"); // adjust if your pool path differs
const requireUser = require("../middleware/requireUser");

// Helpers
function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function addDaysIso(startIso, days) {
  const d = new Date(`${startIso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// POST /api/reservations/request
router.post("/request", requireUser, async (req, res) => {
  const { boatId, startDate, durationDays, notes } = req.body || {};

  if (!boatId || !startDate || !durationDays) {
    return res.status(400).json({ ok: false, error: "boatId, startDate, durationDays are required" });
  }

  // Compute end_exclusive = start_date + durationDays
  const start = new Date(`${startDate}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    return res.status(400).json({ ok: false, error: "Invalid startDate (YYYY-MM-DD)" });
  }

  const days = Math.max(1, Math.min(parseInt(durationDays, 10) || 1, 60));
  const end = new Date(start);
  end.setDate(end.getDate() + days);

  const endExclusive = end.toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    // Optional: fetch email/name for requester fields
    const { rows: urows } = await pool.query(
      `SELECT email, first_name, last_name
       FROM users WHERE id = $1`,
      [req.user.userId]
    );
    const u = urows[0];
    const requesterEmail = u?.email || null;
    const requesterName = `${u?.first_name || ""} ${u?.last_name || ""}`.trim() || null;

    const { rows } = await pool.query(
      `INSERT INTO reservations
        (boat_id, user_id, start_date, end_exclusive, status, created_by_admin, notes, requester_email, requester_name)
       VALUES
        ($1, $2, $3::date, $4::date, 'PENDING', false, $5, $6, $7)
       RETURNING id, boat_id, user_id, start_date, end_exclusive, status`,
      [boatId, req.user.userId, startDate, endExclusive, notes || null, requesterEmail, requesterName]
    );

    res.json({ ok: true, reservation: rows[0] });
  } catch (e) {
    const msg = String(e?.message || "");
    // Handle your overlap constraint nicely
    if (msg.toLowerCase().includes("reservations_no_overlap")) {
      return res.status(409).json({ ok: false, error: "Those dates are not available." });
    }
    console.error("POST /api/reservations/request error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// GET /api/reservations?status=PENDING
router.get("/", async (req, res) => {
  try {
    const { status } = req.query; // optional

    const params = [];
    let where = "";

    if (status) {
      params.push(String(status).toUpperCase());
      where = `WHERE status = $${params.length}`;
    }

    const result = await pool.query(
      `
      SELECT
        id,
        boat_id AS "boatId",
        user_id AS "userId",
        start_date AS "startDate",
        end_exclusive AS "endExclusive",
        status,
        requester_name AS "requesterName",
        requester_email AS "requesterEmail",
        notes,
        created_at AS "createdAt"
      FROM reservations
      ${where}
      ORDER BY created_at DESC
      LIMIT 200
      `,
      params
    );

    res.json({ ok: true, reservations: result.rows });
  } catch (err) {
    console.error("GET /api/reservations error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// PATCH /api/reservations/:id/status  body: { status: "APPROVED" | "DENIED" | ... }
router.patch("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    const next = String(status || "").toUpperCase();
    const allowed = ["PENDING", "APPROVED", "DENIED", "CANCELED", "BLOCKED"];

    if (!allowed.includes(next)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }

    const result = await pool.query(
      `
      UPDATE reservations
      SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, status
      `,
      [id, next]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Reservation not found" });
    }

    res.json({ ok: true, reservation: result.rows[0] });
  } catch (err) {
    // Overlap conflict when switching to APPROVED/BLOCKED
    if (err?.code === "23P01") {
      return res.status(409).json({ ok: false, error: "Cannot approve: overlaps another reservation." });
    }
    console.error("PATCH /api/reservations/:id/status error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});



module.exports = router;
