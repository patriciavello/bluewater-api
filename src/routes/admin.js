//This gives admin a list of reservations in the window + pending-only list + approve/deny endpoints.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool"); // adjust if your pool path differs
const jwt = require("jsonwebtoken");

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



// List all reservations in range (admin sees status)
router.get("/reservations", requireAdmin, async (req, res) => {
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

        u.is_goldmember as "isGoldMember",

        COALESCE(c.first_name,'') as "captainFirstName",
        COALESCE(c.last_name,'')  as "captainLastName",
        c.email as "captainEmail"

      FROM reservations r
      JOIN boats b ON b.id = r.boat_id
      LEFT JOIN users u ON u.id = r.user_id
      LEFT JOIN users c ON c.id = r.captain_id

      WHERE r.start_date >= $1::date
        AND r.start_date < ($1::date + ($2::int || ' days')::interval)
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
    const sql = `
      SELECT
        r.id,
        r.boat_id as "boatId",
        b.name as "boatName",
        r.start_date as "startDate",
        r.end_exclusive as "endExclusive",
        r.status,
        r.requester_name as "requesterName",
        r.requester_email as "requesterEmail",
        r.notes,
        r.created_at as "createdAt"
      FROM reservations r
      JOIN boats b ON b.id = r.boat_id
      WHERE r.status = 'PENDING'
      ORDER BY r.created_at DESC
    `;
    const { rows } = await pool.query(sql);
    res.json({ ok: true, requests: rows });
  } catch (e) {
    console.error("GET /api/admin/requests/pending error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

// Approve a pending reservation
router.post("/reservations/:id/approve", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const sql = `
      UPDATE reservations
      SET status = 'APPROVED', updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id, status
    `;
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Not found or not pending" });
    res.json({ ok: true, reservation: rows[0] });
  } catch (e) {
    console.error("POST /api/admin/reservations/:id/approve error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Deny a pending reservation (removes booking effect for users)
router.post("/reservations/:id/deny", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const sql = `
      UPDATE reservations
      SET status = 'DENIED', updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id, status
    `;
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Not found or not pending" });
    res.json({ ok: true, reservation: rows[0] });
  } catch (e) {
    console.error("POST /api/admin/reservations/:id/deny error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Create an admin block (stores as a reservation row with status = 'BLOCKED')
router.post("/blocks", requireAdmin, async (req, res) => {
  try {
    const { boatId, startDate, days = 1, note = "" } = req.body || {};
    const nDays = Math.max(1, Math.min(parseInt(String(days), 10) || 1, 60));

    if (!boatId) return res.status(400).json({ ok: false, error: "Missing boatId" });
    if (!startDate) return res.status(400).json({ ok: false, error: "Missing startDate" });

    // compute endExclusive = startDate + N days
    const endSql = `($2::date + ($3::int || ' days')::interval)`;

    // Prevent blocks on top of existing APPROVED/PENDING/BLOCKED
    const overlapSql = `
      SELECT 1
      FROM reservations r
      WHERE r.boat_id = $1
        AND r.status IN ('APPROVED','PENDING','BLOCKED')
        AND NOT (
          r.end_exclusive <= $2::date OR
          r.start_date >= ${endSql}
        )
      LIMIT 1
    `;
    const overlap = await pool.query(overlapSql, [boatId, startDate, nDays]);
    if (overlap.rows.length) {
      return res.status(409).json({ ok: false, error: "Dates overlap an existing reservation/block" });
    }

    const insertSql = `
      INSERT INTO reservations
        (boat_id, start_date, end_exclusive, status, requester_name, requester_email, notes)
      VALUES
        ($1, $2::date, ${endSql}, 'BLOCKED', 'ADMIN', 'admin', $4)
      RETURNING id, boat_id as "boatId", start_date as "startDate", end_exclusive as "endExclusive", status, notes
    `;
    const { rows } = await pool.query(insertSql, [boatId, startDate, nDays, note || null]);

    res.json({ ok: true, block: rows[0] });
  } catch (e) {
    console.error("POST /api/admin/blocks error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

// GET /api/admin/captains/available?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get("/captains/available", requireAdmin, async (req, res) => {
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

    res.json({ ok: true, reservation: updated[0] });
  } catch (e) {
    console.error("POST /api/admin/reservations/:id/assign-captain error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});


// Remove an admin block (only deletes BLOCKED rows)
router.delete("/blocks/:id", requireAdmin, async (req, res) => {
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


module.exports = router;
