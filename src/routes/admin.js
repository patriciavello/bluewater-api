//This gives admin a list of reservations in the window + pending-only list + approve/deny endpoints.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool"); // adjust if your pool path differs
const jwt = require("jsonwebtoken");
const {stripe} = require("../lib/stripe");

const { sendReservationApprovedEmail, sendCaptainAssignedEmails } = require("../lib/mailer");

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
function requireFullAdmin(req, res, next) {
  if (!req.admin?.isAdmin) {
    return res.status(403).json({ ok: false, error: "Admin access required" });
  }
  next();
}


// List all reservations in range (admin sees status)
router.get("/reservations", requireAdmin,  async (req, res) => {
  try {
    const start = String(req.query.start || "");
    const days = Math.max(1, Math.min(parseInt(String(req.query.days || "14"), 10) || 14, 60));
    if (!start) return res.status(400).json({ ok: false, error: "Missing start" });

    const sql = `
      SELECT
        r.id,
        r.boat_id as "boatId",
        b.name as "boatName",
        r.start_date as "startDate",
        r.end_exclusive as "endExclusive",
        r.status,
        r.user_id as "userId",
        r.captain_id as "captainId",

        r.requester_name as "requesterName",
        r.requester_email as "requesterEmail",
        r.notes,
        r.created_at as "createdAt",

        r.payment_status as "paymentStatus",
        r.amount_paid as "amountPaid",
        r.paid_at as "paidAt",

        r.refunded_amount as "refundedAmount",
        r.refunded_at as "refundedAt",
        r.refund_status as "refundStatus",

        u.is_goldmember as "isGoldMember",

        COALESCE(c.first_name,'') as "captainFirstName",
        COALESCE(c.last_name,'')  as "captainLastName",
        c.email as "captainEmail"

      FROM reservations r
      JOIN boats b ON b.id = r.boat_id
      LEFT JOIN users u ON u.id = r.user_id
      LEFT JOIN users c ON c.id = r.captain_id

      WHERE daterange(r.start_date, r.end_exclusive, '[)')
            && daterange($1::date, ($1::date + ($2::int || ' days')::interval)::date, '[)')
      ORDER BY r.start_date ASC, b.name ASC
    `;

    const { rows } = await pool.query(sql, [start, days]);
    res.json({ ok: true, reservations: rows });
  } catch (e) {
    console.error("GET /api/admin/reservations error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});


// Pending-only list (nice for admin inbox)
router.get("/requests/pending", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        r.id,
        r.boat_id,
        b.name AS boat_name,
        r.user_id,
        r.start_date,
        r.end_exclusive,
        r.status,
        r.notes,
        r.requested_start_date,
        r.requested_end_exclusive,
        r.change_request_note,
        r.change_fee_percent,
        r.change_fee_amount,
        r.change_requested_at,
        r.created_at,
        r.updated_at
      FROM public.reservations r
      JOIN public.boats b ON b.id = r.boat_id
      WHERE r.status IN ('PENDING', 'CHANGE_REQUESTED')
      ORDER BY r.created_at DESC
      `
    );

    return res.json({ ok: true, requests: rows });
  } catch (e) {
    console.error("GET /api/admin/requests/pending error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Approve a pending reservation
router.post("/reservations/:id/approve", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const sql = `
      UPDATE reservations
      SET status = 'APPROVED', updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id, status
    `;
    //send email
    try {
      const { rows: infoRows } = await pool.query(
        `SELECT
           r.start_date,
           r.end_exclusive,
           r.requester_email,
           r.requester_name,
           b.name as boat_name,
           b.location,
           b.price_per_day
         FROM reservations r
         JOIN boats b ON b.id = r.boat_id
         WHERE r.id = $1`,
        [req.params.id]
      );
    
      const info = infoRows[0];
      if (info?.requester_email) {
        await sendReservationApprovedEmail(info.requester_email, {
          boatName: info.boat_name,
          location: info.location,
          pricePerDay: info.price_per_day || 0,
          startDate: info.start_date,
          endExclusive: info.end_exclusive,
        });
      }
    } catch (mailErr) {
      console.error("sendReservationApprovedEmail error:", mailErr);
    }
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Not found or not pending" });
    res.json({ ok: true, reservation: rows[0] });
  } catch (e) {
    console.error("POST /api/admin/reservations/:id/approve error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

//Approve change request
router.post("/reservations/:id/approve-change", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `
      SELECT
        id,
        boat_id,
        status,
        start_date,
        end_exclusive,
        requested_start_date,
        requested_end_exclusive,
        change_request_note,
        change_fee_percent,
        change_fee_amount
      FROM public.reservations
      WHERE id = $1
      `,
      [id]
    );

    const r = rows[0];

    if (!r) {
      return res.status(404).json({ ok: false, error: "Reservation not found" });
    }

    if (String(r.status).toUpperCase() !== "CHANGE_REQUESTED") {
      return res.status(400).json({
        ok: false,
        error: "Reservation is not waiting for change approval"
      });
    }

    if (!r.requested_start_date || !r.requested_end_exclusive) {
      return res.status(400).json({
        ok: false,
        error: "Requested dates are missing"
      });
    }

    // Re-check availability before approval
    const overlap = await pool.query(
      `
      SELECT 1
      FROM public.reservations x
      WHERE x.boat_id = $1
        AND x.id <> $2
        AND x.status IN ('PENDING','APPROVED','BLOCKED','MAINTENANCE','CHANGE_REQUESTED')
        AND daterange(x.start_date, x.end_exclusive, '[)')
            && daterange($3::date, $4::date, '[)')
      LIMIT 1
      `,
      [r.boat_id, id, r.requested_start_date, r.requested_end_exclusive]
    );

    if (overlap.rows.length) {
      return res.status(409).json({
        ok: false,
        error: "Requested dates are no longer available"
      });
    }

    const { rows: updated } = await pool.query(
      `
      UPDATE public.reservations
      SET
        start_date = requested_start_date,
        end_exclusive = requested_end_exclusive,
        status = 'APPROVED',
        requested_start_date = NULL,
        requested_end_exclusive = NULL,
        change_request_note = NULL,
        change_fee_percent = NULL,
        change_fee_amount = NULL,
        change_requested_at = NULL,
        original_status_before_change = NULL,
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        boat_id,
        start_date,
        end_exclusive,
        status,
        updated_at
      `,
      [id]
    );

    return res.json({
      ok: true,
      message: "Reservation change approved",
      reservation: updated[0]
    });
  } catch (e) {
    console.error("POST /api/admin/reservations/:id/approve-change error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Deny a pending reservation (removes booking effect for users)
router.post("/reservations/:id/deny", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const sql = `
      UPDATE public.reservations
      SET status = 'DENIED', updated_at = NOW()
      WHERE id = $1
        AND status IN ('PENDING', 'APPROVED')
      RETURNING id, status
    `;
    const { rows } = await pool.query(sql, [id]);

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Not found or reservation cannot be denied from its current status",
      });
    }

    res.json({ ok: true, reservation: rows[0] });
  } catch (e) {
    console.error("POST /api/admin/reservations/:id/deny error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

//Deny change request
router.post("/reservations/:id/deny-change", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `
      SELECT
        id,
        status,
        original_status_before_change
      FROM public.reservations
      WHERE id = $1
      `,
      [id]
    );

    const r = rows[0];

    if (!r) {
      return res.status(404).json({ ok: false, error: "Reservation not found" });
    }

    if (String(r.status).toUpperCase() !== "CHANGE_REQUESTED") {
      return res.status(400).json({
        ok: false,
        error: "Reservation is not waiting for change approval"
      });
    }

    const restoreStatus = r.original_status_before_change || "APPROVED";

    const { rows: updated } = await pool.query(
      `
      UPDATE public.reservations
      SET
        status = $2,
        requested_start_date = NULL,
        requested_end_exclusive = NULL,
        change_request_note = NULL,
        change_fee_percent = NULL,
        change_fee_amount = NULL,
        change_requested_at = NULL,
        original_status_before_change = NULL,
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        boat_id,
        start_date,
        end_exclusive,
        status,
        updated_at
      `,
      [id, restoreStatus]
    );

    return res.json({
      ok: true,
      message: "Reservation change denied",
      reservation: updated[0]
    });
  } catch (e) {
    console.error("POST /api/admin/reservations/:id/deny-change error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/blocks", requireAdmin, async (req, res) => {
  try {
    const {
      boatId,
      startDate,
      days = 1,
      note = "",
      status = "BLOCKED",
    } = req.body || {};

    if (!boatId) return res.status(400).json({ ok: false, error: "Missing boatId" });
    if (!startDate) return res.status(400).json({ ok: false, error: "Missing startDate" });

    const allowedStatuses = ["BLOCKED", "MAINTENANCE", "OPEN"];
    const normalizedStatus = String(status || "").toUpperCase();

    if (!allowedStatuses.includes(normalizedStatus)) {
      return res.status(400).json({ ok: false, error: "Invalid block status" });
    }

    const nDays = Math.max(1, Math.min(parseInt(String(days), 10) || 1, 60));

    const overlapSql = `
      SELECT 1
      FROM reservations r
      WHERE r.boat_id = $1
        AND r.status IN ('APPROVED','PENDING','BLOCKED','MAINTENANCE')
        AND NOT (
          r.end_exclusive <= $2::date OR
          r.start_date >= ($2::date + $3::int)
        )
      LIMIT 1
    `;

    const overlap = await pool.query(overlapSql, [boatId, startDate, nDays]);
    if (overlap.rows.length) {
      return res.status(409).json({ ok: false, error: "Date overlaps an existing blocking reservation/block" });
    }

    const insertSql = `
      INSERT INTO reservations
        (boat_id, start_date, end_exclusive, status, requester_name, requester_email, notes)
      VALUES
        ($1, $2::date, ($2::date + $3::int), $4::reservation_status, 'ADMIN', 'admin', $5)
      RETURNING
        id,
        boat_id as "boatId",
        start_date as "startDate",
        end_exclusive as "endExclusive",
        status,
        notes
    `;

    const { rows } = await pool.query(insertSql, [
      boatId,
      startDate,
      nDays,
      normalizedStatus,
      note || null,
    ]);

    res.json({ ok: true, block: rows[0] });
  } catch (e) {
    console.error("POST /api/admin/blocks error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

// GET /api/admin/captains/available?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get("/captains/available", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const start = String(req.query.start || "");
    const end = String(req.query.end || "");

    const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
    if (!isIso(start) || !isIso(end)) {
      return res.status(400).json({ ok: false, error: "start/end must be YYYY-MM-DD" });
    }

    const blockingStatuses = ["PENDING", "APPROVED", "BLOCKED", "CHANGE_REQUESTED", "CANCEL_REQUESTED"];

    const sql = `
      SELECT
        u.id,
        u.email,
        u.phone,
        u.first_name as "firstName",
        u.last_name as "lastName"
      FROM users u
      WHERE u.is_captain = true
        AND NOT EXISTS (
          SELECT 1
          FROM reservations r
          WHERE r.status = ANY($3::reservation_status[])
            AND (r.captain_id = u.id OR r.user_id = u.id)
            AND daterange(r.start_date, r.end_exclusive, '[)') && daterange($1::date, $2::date, '[)')
        )
      ORDER BY u.first_name NULLS LAST, u.last_name NULLS LAST, u.email ASC
      LIMIT 200
    `;

    const { rows } = await pool.query(sql, [start, end, blockingStatuses]);
    res.json({ ok: true, captains: rows });
  } catch (e) {
    console.error("GET /api/admin/captains/available error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

// Route to change reservation status by admin
router.post("/reservations/:id/status", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};

  const allowedStatuses = [
    "OPEN",
    "BLOCKED",
    "MAINTENANCE",
    "DENIED",
    "CANCELED",
    "PENDING",
    "APPROVED",
  ];

  const normalizedStatus = String(status || "").toUpperCase();

  if (!allowedStatuses.includes(normalizedStatus)) {
    return res.status(400).json({ ok: false, error: "Invalid status" });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE reservations
       SET status = $1::reservation_status,
           updated_at = NOW()
       WHERE id = $2
       RETURNING
         id,
         boat_id as "boatId",
         start_date as "startDate",
         end_exclusive as "endExclusive",
         status,
         requester_name as "requesterName",
         requester_email as "requesterEmail",
         notes,
         created_at as "createdAt"`,
      [normalizedStatus, id]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "Reservation not found" });
    }

    res.json({ ok: true, reservation: rows[0] });
  } catch (e) {
    console.error("PATCH /api/admin/reservations/:id/status error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

// POST /api/admin/reservations/:id/assign-captain
// Body: { captainId: string | null }
router.post("/reservations/:id/assign-captain", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const captainId = req.body?.captainId ? String(req.body.captainId) : null;

    // load reservation + requester gold status
    const { rows: rrows } = await pool.query(
      `
      SELECT r.id, r.user_id, u.is_goldmember
      FROM reservations r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.id = $1
      `,
      [id]
    );
    const r = rrows[0];
    if (!r) return res.status(404).json({ ok: false, error: "Reservation not found" });

    if (r.is_goldmember) {
      return res.status(400).json({ ok: false, error: "Gold members do not need a captain" });
    }

    if (captainId) {
      // validate captain
      const { rows: crows } = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND is_captain = true`,
        [captainId]
      );
      if (!crows.length) return res.status(400).json({ ok: false, error: "Invalid captainId" });
    }

    const { rows: updated } = await pool.query(
      `
      UPDATE reservations
      SET captain_id = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, captain_id as "captainId"
      `,
      [id, captainId]
    );
    //send email
    try {
      const { rows: infoRows } = await pool.query(
        `SELECT
           r.start_date,
           r.end_exclusive,
           r.requester_name,
           r.requester_email,
           u.email as user_email,
           b.name as boat_name,
           b.location,
           b.price_per_day,
           c.email as captain_email,
           c.first_name as captain_first_name,
           c.last_name as captain_last_name
         FROM reservations r
         JOIN boats b ON b.id = r.boat_id
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN users c ON c.id = r.captain_id
         WHERE r.id = $1`,
        [req.params.id]
      );
    
      const info = infoRows[0];
      const captainName =
        `${info?.captain_first_name || ""} ${info?.captain_last_name || ""}`.trim() || info?.captain_email || "Captain";
    
      await sendCaptainAssignedEmails(
        info?.user_email || info?.requester_email || null,
        info?.captain_email || null,
        {
          boatName: info?.boat_name || "Boat",
          location: info?.location || null,
          pricePerDay: info?.price_per_day || 0,
          startDate: info?.start_date,
          endExclusive: info?.end_exclusive,
          captainName,
          requesterName: info?.requester_name || null,
          requesterEmail: info?.requester_email || null,
        }
      );
    } catch (mailErr) {
      console.error("sendCaptainAssignedEmails error:", mailErr);
    }
    res.json({ ok: true, reservation: updated[0] });
  } catch (e) {
    console.error("POST /api/admin/reservations/:id/assign-captain error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

// change reservations
router.patch("/reservations/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { boatId, startDate, durationDays } = req.body || {};

  if (!boatId || !startDate || !durationDays) {
    return res.status(400).json({
      ok: false,
      error: "boatId, startDate, and durationDays are required",
    });
  }

  const days = Math.max(1, parseInt(String(durationDays), 10) || 1);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate))) {
    return res.status(400).json({
      ok: false,
      error: "startDate must be YYYY-MM-DD",
    });
  }

  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  const endExclusive = end.toISOString().slice(0, 10);

  try {
    const { rows: currentRows } = await pool.query(
      `
      SELECT
        r.id,
        r.boat_id,
        r.user_id,
        r.captain_id,
        r.status,
        r.start_date,
        r.end_exclusive,
        r.requester_name,
        r.requester_email,
        r.notes,
        u.email AS user_email,
        u.first_name AS user_first_name,
        u.last_name AS user_last_name,
        c.email AS captain_email,
        c.first_name AS captain_first_name,
        c.last_name AS captain_last_name
      FROM public.reservations r
      LEFT JOIN public.users u ON u.id = r.user_id
      LEFT JOIN public.users c ON c.id = r.captain_id
      WHERE r.id = $1
      `,
      [id]
    );

    const current = currentRows[0];
    if (!current) {
      return res.status(404).json({ ok: false, error: "Reservation not found" });
    }

    const { rows: boatRows } = await pool.query(
      `
      SELECT id, name, price_per_day
      FROM public.boats
      WHERE id = $1
      `,
      [boatId]
    );

    const targetBoat = boatRows[0];
    if (!targetBoat) {
      return res.status(404).json({ ok: false, error: "Boat not found" });
    }

    const { rows: overlapRows } = await pool.query(
      `
      SELECT 1
      FROM public.reservations x
      WHERE x.boat_id = $1
        AND x.id <> $2
        AND x.status IN ('PENDING','APPROVED','CHANGE_REQUESTED','BLOCKED','MAINTENANCE')
        AND daterange(x.start_date, x.end_exclusive, '[)')
            && daterange($3::date, $4::date, '[)')
      LIMIT 1
      `,
      [boatId, id, startDate, endExclusive]
    );

    if (overlapRows.length) {
      return res.status(409).json({
        ok: false,
        error: "Those dates are not available for that boat.",
      });
    }

    const { rows: updatedRows } = await pool.query(
      `
      UPDATE public.reservations
      SET
        boat_id = $1,
        start_date = $2::date,
        end_exclusive = $3::date,
        requested_start_date = NULL,
        requested_end_exclusive = NULL,
        change_request_note = NULL,
        change_fee_percent = NULL,
        change_fee_amount = NULL,
        change_requested_at = NULL,
        original_status_before_change = NULL,
        updated_at = NOW()
      WHERE id = $4
      RETURNING
        id,
        boat_id,
        user_id,
        captain_id,
        status,
        start_date,
        end_exclusive,
        requester_name,
        requester_email,
        notes
      `,
      [boatId, startDate, endExclusive, id]
    );

    const updated = updatedRows[0];

    // reload with boat + emails for notification
    const { rows: notifyRows } = await pool.query(
      `
      SELECT
        r.id,
        r.status,
        r.start_date,
        r.end_exclusive,
        r.requester_name,
        r.requester_email,
        b.name AS boat_name,
        u.email AS user_email,
        u.first_name AS user_first_name,
        u.last_name AS user_last_name,
        c.email AS captain_email,
        c.first_name AS captain_first_name,
        c.last_name AS captain_last_name
      FROM public.reservations r
      JOIN public.boats b ON b.id = r.boat_id
      LEFT JOIN public.users u ON u.id = r.user_id
      LEFT JOIN public.users c ON c.id = r.captain_id
      WHERE r.id = $1
      `,
      [id]
    );

    const notifyData = notifyRows[0];

    // email helpers
    const userEmail =
      notifyData?.user_email ||
      notifyData?.requester_email ||
      null;

    const userName =
      `${notifyData?.user_first_name || ""} ${notifyData?.user_last_name || ""}`.trim() ||
      notifyData?.requester_name ||
      "Member";

    const captainEmail = notifyData?.captain_email || null;
    const captainName =
      `${notifyData?.captain_first_name || ""} ${notifyData?.captain_last_name || ""}`.trim() ||
      "Captain";

    const visibleEnd = new Date(`${String(notifyData.end_exclusive).slice(0, 10)}T00:00:00`);
    visibleEnd.setDate(visibleEnd.getDate() - 1);
    const visibleEndIso = visibleEnd.toISOString().slice(0, 10);

    const subject = `Bluewater reservation updated - ${notifyData.boat_name}`;
    const bodyForUser = `
Hello ${userName},

Your Bluewater reservation has been updated by an administrator.

Boat: ${notifyData.boat_name}
Start date: ${String(notifyData.start_date).slice(0, 10)}
End date: ${visibleEndIso}
Status: ${notifyData.status}

If you have any questions, please contact the office.

Bluewater
    `.trim();

    const bodyForCaptain = `
Hello ${captainName},

A Bluewater reservation assigned to you has been updated by an administrator.

Boat: ${notifyData.boat_name}
Start date: ${String(notifyData.start_date).slice(0, 10)}
End date: ${visibleEndIso}
Status: ${notifyData.status}

Please review your schedule.

Bluewater
    `.trim();

    try {
      if (userEmail) {
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
          to: userEmail,
          subject,
          text: bodyForUser,
        });
      }

      if (captainEmail) {
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
          to: captainEmail,
          subject,
          text: bodyForCaptain,
        });
      }
    } catch (mailErr) {
      console.error("Reservation updated but email failed:", mailErr);
    }

    return res.json({
      ok: true,
      reservation: {
        id: updated.id,
        boatId: updated.boat_id,
        startDate: String(updated.start_date).slice(0, 10),
        endExclusive: String(updated.end_exclusive).slice(0, 10),
        durationDays: days,
        status: updated.status,
      },
    });
  } catch (e) {
    console.error("PATCH /api/admin/reservations/:id error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Remove an admin block (only deletes BLOCKED rows)
router.delete("/blocks/:id", requireAdmin, requireFullAdmin, async (req, res) => {
  try {
    const id = req.params.id;

    const sql = `
      DELETE FROM reservations
      WHERE id = $1 AND status = 'BLOCKED'
      RETURNING id
    `;
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Not found or not a block" });

    res.json({ ok: true, deleted: rows[0] });
  } catch (e) {
    console.error("DELETE /api/admin/blocks/:id error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

//allow admin to refund customer
router.post("/reservations/:id/refund", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const percent = Number(req.body?.percent);

    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      return res.status(400).json({
        ok: false,
        error: "Refund percent must be between 1 and 100",
      });
    }

    const { rows } = await pool.query(
      `
      SELECT
        id,
        status,
        payment_status,
        amount_paid,
        refunded_amount,
        stripe_payment_intent_id
      FROM public.reservations
      WHERE id = $1
      `,
      [id]
    );

    const r = rows[0];
    if (!r) {
      return res.status(404).json({ ok: false, error: "Reservation not found" });
    }

    const status = String(r.status || "").toUpperCase();
    if (!["DENIED", "CANCELED"].includes(status)) {
      return res.status(400).json({
        ok: false,
        error: "Refund allowed only for DENIED or CANCELED reservations",
      });
    }

    if (!r.stripe_payment_intent_id) {
      return res.status(400).json({
        ok: false,
        error: "No Stripe payment found for this reservation",
      });
    }

    const paid = Number(r.amount_paid || 0);
    const alreadyRefunded = Number(r.refunded_amount || 0);

    if (paid <= 0) {
      return res.status(400).json({
        ok: false,
        error: "No paid amount found for this reservation",
      });
    }

    const requested = Number((paid * (percent / 100)).toFixed(2));
    const remaining = Number((paid - alreadyRefunded).toFixed(2));
    const refundAmount = Math.min(requested, remaining);

    if (refundAmount <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Nothing left to refund",
      });
    }

    const refund = await stripe.refunds.create({
      payment_intent: r.stripe_payment_intent_id,
      amount: Math.round(refundAmount * 100),
    });

    const newRefundedTotal = Number((alreadyRefunded + refundAmount).toFixed(2));
    const newPaymentStatus =
      newRefundedTotal >= paid ? "REFUNDED" : "PARTIALLY_REFUNDED";

    const { rows: updated } = await pool.query(
      `
      UPDATE public.reservations
      SET
        payment_status = $2,
        refunded_amount = $3,
        refunded_at = NOW(),
        stripe_refund_id = $4,
        refund_status = $5,
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        status,
        payment_status,
        amount_paid,
        refunded_amount,
        refunded_at,
        stripe_refund_id,
        refund_status
      `,
      [
        id,
        newPaymentStatus,
        newRefundedTotal,
        refund.id,
        refund.status || "succeeded",
      ]
    );

    res.json({
      ok: true,
      reservation: updated[0],
      refundedNow: refundAmount,
    });
  } catch (e) {
    console.error("POST /api/admin/reservations/:id/refund error:", e);
    res.status(500).json({ ok: false, error: e.message || "Refund failed" });
  }
});

//allow any user to create a maintenance request
router.get("/maintenance/requests", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        mr.id,
        mr.boat_id as "boatId",
        b.name as "boatName",
        mr.submitted_by_user_id as "submittedByUserId",
        mr.submitted_by_name as "submittedByName",
        mr.submitted_by_email as "submittedByEmail",
        mr.notes,
        mr.status,
        mr.created_at as "createdAt",
        mr.updated_at as "updatedAt"
      FROM public.maintenance_requests mr
      JOIN public.boats b ON b.id = mr.boat_id
      ORDER BY mr.created_at DESC
      `
    );

    return res.json({ ok: true, requests: rows });
  } catch (e) {
    console.error("GET /api/admin/maintenance/requests error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.get("/maintenance/requests/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: requestRows } = await pool.query(
      `
      SELECT
        mr.id,
        mr.boat_id as "boatId",
        b.name as "boatName",
        mr.submitted_by_user_id as "submittedByUserId",
        mr.submitted_by_name as "submittedByName",
        mr.submitted_by_email as "submittedByEmail",
        mr.notes,
        mr.status,
        mr.admin_decision_note as "adminDecisionNote",
        mr.created_at as "createdAt",
        mr.updated_at as "updatedAt"
      FROM public.maintenance_requests mr
      JOIN public.boats b ON b.id = mr.boat_id
      WHERE mr.id = $1
      `,
      [id]
    );

    if (!requestRows.length) {
      return res.status(404).json({ ok: false, error: "Maintenance request not found" });
    }

    const { rows: itemRows } = await pool.query(
      `
      SELECT
        id,
        maintenance_request_id as "maintenanceRequestId",
        problem_description as "problemDescription",
        classification,
        out_of_service_required as "outOfServiceRequired",
        required_fix_date as "requiredFixDate",
        priority,
        status,
        technician_user_id as "technicianUserId",
        scheduled_start_date as "scheduledStartDate",
        scheduled_end_date as "scheduledEndDate",
        supervisor_note as "supervisorNote",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM public.maintenance_request_items
      WHERE maintenance_request_id = $1
      ORDER BY created_at ASC
      `,
      [id]
    );

    return res.json({
      ok: true,
      request: requestRows[0],
      items: itemRows,
    });
  } catch (e) {
    console.error("GET /api/admin/maintenance/requests/:id error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/maintenance/requests/:id/approve", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `
      UPDATE public.maintenance_requests
      SET
        status = 'APPROVED',
        admin_approved_by = $2,
        admin_approved_at = NOW(),
        admin_denied_by = NULL,
        admin_denied_at = NULL,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id, req.admin?.userId || null]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "Request not found" });
    }

    return res.json({ ok: true, request: rows[0] });
  } catch (e) {
    console.error("POST /api/admin/maintenance/requests/:id/approve error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/maintenance/requests/:id/deny", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const note = String(req.body?.note || "").trim() || null;

    const { rows } = await pool.query(
      `
      UPDATE public.maintenance_requests
      SET
        status = 'DENIED',
        admin_denied_by = $2,
        admin_denied_at = NOW(),
        admin_decision_note = $3,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id, req.admin?.userId || null, note]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "Request not found" });
    }

    return res.json({ ok: true, request: rows[0] });
  } catch (e) {
    console.error("POST /api/admin/maintenance/requests/:id/deny error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});


module.exports = router;
