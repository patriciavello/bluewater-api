const express = require("express");
const pool = require("../db/pool");
const requireUser = require("../middleware/requireUser");

const router = express.Router();

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function diffDays(startIso) {
  const now = new Date();
  const start = new Date(`${startIso}T00:00:00`);
  return (start.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
}

function daysBetween(startIso, endIso) {
  const a = new Date(`${startIso}T00:00:00`);
  const b = new Date(`${endIso}T00:00:00`);
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)));
}

// List my reservations (as client OR as assigned captain)
router.get("/", requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
          r.id,
          r.boat_id,
          b.name as boat_name,
          r.start_date,
          r.end_exclusive,
          r.status,
          CASE
            WHEN r.status IN ('APPROVED','BLOCKED','PENDING')
            AND r.end_exclusive <= CURRENT_DATE
            THEN 'PAST RESERVATION'
            ELSE r.status::text
          END AS display_status,
          r.notes,
          r.created_at,
          r.updated_at,

          r.user_id,
          r.captain_id,

          r.payment_status,
          r.amount_paid,
          r.paid_at,

          -- client info (so captain can see who the customer is)
          u.email as client_email,
          u.first_name as client_first_name,
          u.last_name as client_last_name

       FROM reservations r
       JOIN boats b ON b.id = r.boat_id
       JOIN users u ON u.id = r.user_id

       WHERE (r.user_id = $1 OR r.captain_id = $1)
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
  const {
    start_date,
    end_exclusive,
    change_note,
    accept_change_fee
  } = req.body || {};

  if (!isISODate(start_date) || !isISODate(end_exclusive)) {
    return res.status(400).json({
      ok: false,
      error: "start_date and end_exclusive are required in YYYY-MM-DD format"
    });
  }

  if (end_exclusive <= start_date) {
    return res.status(400).json({ ok: false, error: "end_exclusive must be after start_date" });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT
        r.id,
        r.boat_id,
        r.user_id,
        r.status,
        r.start_date,
        r.end_exclusive,
        b.price_per_day
      FROM reservations r
      JOIN boats b ON b.id = r.boat_id
      WHERE r.id = $1 AND r.user_id = $2
      `,
      [id, req.user.userId]
    );

    const r = rows[0];
    if (!r) return res.status(404).json({ ok: false, error: "Reservation not found" });

    const status = String(r.status).toUpperCase();
    const todayIso = new Date().toISOString().slice(0, 10);
    const currentStartIso = String(r.start_date).slice(0, 10);
    
    if (currentStartIso <= todayIso) {
      return res.status(400).json({
        ok: false,
        error: "Past or active reservations cannot be changed"
      });
    }

    // 1) PENDING => direct edit, no fee
    if (status === "PENDING") {
      const overlap = await pool.query(
        `
        SELECT 1
        FROM reservations x
        WHERE x.boat_id = $1
          AND x.id <> $2
          AND x.status IN ('PENDING','APPROVED','BLOCKED','MAINTENANCE','CHANGE_REQUESTED')
          AND daterange(x.start_date, x.end_exclusive, '[)')
              && daterange($3::date, $4::date, '[)')
        LIMIT 1
        `,
        [r.boat_id, id, start_date, end_exclusive]
      );

      if (overlap.rows.length) {
        return res.status(409).json({ ok: false, error: "Those dates are not available for that boat." });
      }

      const { rows: updated } = await pool.query(
        `
        UPDATE reservations
        SET start_date = $1::date,
            end_exclusive = $2::date,
            updated_at = NOW()
        WHERE id = $3 AND user_id = $4
        RETURNING id, boat_id, start_date, end_exclusive, status, notes, created_at, updated_at
        `,
        [start_date, end_exclusive, id, req.user.userId]
      );

      return res.json({ ok: true, mode: "DIRECT_EDIT", reservation: updated[0] });
    }

    // 2) APPROVED => create change request
    if (status === "APPROVED") {
      if (!change_note || !String(change_note).trim()) {
        return res.status(400).json({ 
          ok: false, error: "Justification is required for approved reservation changes" });
      }

      const overlap = await pool.query(
        `
        SELECT 1
        FROM reservations x
        WHERE x.boat_id = $1
          AND x.id <> $2
          AND x.status IN ('PENDING','APPROVED','BLOCKED','MAINTENANCE','CHANGE_REQUESTED')
          AND daterange(x.start_date, x.end_exclusive, '[)')
              && daterange($3::date, $4::date, '[)')
        LIMIT 1
        `,
        [r.boat_id, id, start_date, end_exclusive]
      );

      if (overlap.rows.length) {
        return res.status(409).json({ 
          ok: false, error: "Requested dates are not available for that boat." });
      }

      const currentStartIso = String(r.start_date).slice(0, 10);
      const currentEndIso = String(r.end_exclusive).slice(0, 10);
      const daysBeforeStart = diffDays(currentStartIso);

      // allow only before trip starts
      if (daysBeforeStart <= 0) {
        return res.status(400).json({
          ok: false,
          error: "Approved reservations cannot be changed on or after the start date."
        });
      }

      let percent = 5;
      if (daysBeforeStart < 1) {
        percent = 20;
      }

      const totalDays = daysBetween(currentStartIso, currentEndIso);
      const totalPrice = Number(r.price_per_day || 0) * totalDays;
      const feeAmount = Number(((totalPrice * percent) / 100).toFixed(2));
     
      if (accept_change_fee !== true) {
        return res.status(400).json({
          ok: false,
          error: "User must accept the change fee",
          changeFeePercent: percent,
          changeFeeAmount: feeAmount
        });
      }

      const { rows: updated } = await pool.query(
        `
        UPDATE reservations
        SET status = 'CHANGE_REQUESTED',
            requested_start_date = $1::date,
            requested_end_exclusive = $2::date,
            change_request_note = $3,
            change_fee_percent = $4,
            change_fee_amount = $5,
            change_requested_at = NOW(),
            original_status_before_change = 'APPROVED',
            updated_at = NOW()
        WHERE id = $6 AND user_id = $7
        RETURNING
          id,
          boat_id,
          start_date,
          end_exclusive,
          requested_start_date,
          requested_end_exclusive,
          status,
          change_request_note,
          change_fee_percent,
          change_fee_amount,
          updated_at
        `,
        [start_date, end_exclusive, change_note.trim(), percent, feeAmount, id, req.user.userId]
      );

      return res.json({
        ok: true,
        mode: "CHANGE_REQUEST_SUBMITTED",
        reservation: updated[0],
        changeFeePercent: percent,
        changeFeeAmount: feeAmount
      });
    }

    if (status === "CHANGE_REQUESTED") {
      return res.status(400).json({ ok: false, error: "A change request is already pending admin approval" });
    }

    return res.status(400).json({
      ok: false,
      error: "Only PENDING or APPROVED reservations can be changed"
    });
  } catch (e) {
    console.error("PATCH /api/me/reservations/:id error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});


// Cancel my reservation (pending + future only)
router.delete("/:id", requireUser, async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `UPDATE reservations
       SET status = 'CANCELED',
           updated_at = NOW()
       WHERE id = $1
         AND (
           user_id = $2
           OR captain_id = $2
         )
         AND status IN ('PENDING', 'APPROVED', 'CHANGE_REQUESTED', 'CANCEL_REQUESTED')
       RETURNING
         id,
         boat_id,
         user_id,
         start_date,
         end_exclusive,
         status,
         notes,
         updated_at`,
      [id, req.user.userId]
    );
    if (status !== "PENDING") {
      return res.status(400).json({ ok: false, error: "Only PENDING reservations can be cancelled by user. Please call to cancel the reservation after approval." });
    }
    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Reservation not found or cannot be cancelled",
      });
    }

    res.json({ ok: true, reservation: rows[0] });
  } catch (e) {
    console.error("DELETE /api/me/reservations/:id error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
