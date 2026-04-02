const express = require("express");
const pool = require("../db/pool"); // adjust if your pool path differs

const router = express.Router();

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

function toYmd(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

router.get("/", async (req, res) => {
  try {
    const start = String(req.query.start || "");
    const days = Math.max(1, Math.min(31, parseInt(String(req.query.days || "14"), 10) || 14));

    if (!isIsoDate(start)) {
      return res.status(400).json({ ok: false, error: "start must be YYYY-MM-DD" });
    }

    const endExclusive = await pool.query(`select ($1::date + $2::int) as end_exclusive`, [start, days]);
    const end = endExclusive.rows[0].end_exclusive;

    // statuses that block dates for normal users
    const blockingStatuses = [
      "PENDING",
      "APPROVED",
      "BLOCKED", 
      "MAINTENANCE",
      "CHANGE_REQUESTED"
    ];

    // return per boat: list of reservation ranges (no user info)
    const r = await pool.query(
      `select id, boat_id, start_date, end_exclusive, status
       FROM reservations
       WHERE status = any($1::reservation_status[])
         and daterange(start_date, end_exclusive, '[)') && daterange($2::date, $3::date, '[)')
       order by boat_id, start_date`,
      [blockingStatuses, start, end]
    );

    res.json({
      ok: true,
      start,
      days,
      reservations: r.rows.map((x) => ({
        id: x.id,
        boatId: x.boat_id,
        startDate: toYmd(x.start_date),
        endExclusive: toYmd(x.end_exclusive),
        status: x.status
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
