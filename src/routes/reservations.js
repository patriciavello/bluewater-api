const express = require("express");
const router = express.Router();

const pool = require("../db/pool"); // ✅ adjust if your file name differs

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

router.post("/request", async (req, res) => {
  try {
    const {
      boatId,
      startDate,
      durationDays,
      requesterName,
      requesterEmail,
      notes,
    } = req.body || {};

    if (!boatId) return res.status(400).json({ ok: false, error: "boatId is required" });
    if (!isISODate(startDate)) return res.status(400).json({ ok: false, error: "startDate must be YYYY-MM-DD" });

    const n = Number(durationDays);
    if (!Number.isFinite(n) || n < 1 || n > 30) {
      return res.status(400).json({ ok: false, error: "durationDays must be 1–30" });
    }

    const end = new Date(startDate);
    end.setDate(end.getDate() + n);
    const endExclusive = end.toISOString().slice(0, 10);

    // Check overlap against confirmed reservations
    const overlap = await pool.query(
      `
      SELECT 1
      FROM reservations
      WHERE boat_id = $1
        AND status = 'confirmed'
        AND NOT ($3 <= start_date OR $2 >= end_exclusive)
      LIMIT 1
      `,
      [boatId, startDate, endExclusive]
    );

    if (overlap.rows.length) {
      return res.status(409).json({
        ok: false,
        error: "Boat already booked for part of this period",
      });
    }

    const inserted = await pool.query(
      `
      INSERT INTO reservations
        (boat_id, start_date, end_exclusive, status, requester_name, requester_email, notes)
      VALUES ($1,$2,$3,'pending',$4,$5,$6)
      RETURNING id,
        boat_id AS "boatId",
        start_date AS "startDate",
        end_exclusive AS "endExclusive",
        status
      `,
      [boatId, startDate, endExclusive, requesterName || null, requesterEmail || null, notes || null]
    );

    return res.json({ ok: true, request: inserted.rows[0] });
  } catch (err) {
    console.error("Reservation request error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
