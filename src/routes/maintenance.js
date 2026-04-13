const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const requireUser = require("../middleware/requireUser");

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

const ALLOWED_CLASSIFICATIONS = [
  "MECHANICAL",
  "ELECTRICAL",
  "PLUMBING",
  "AC",
  "OTHER",
];

const ALLOWED_PRIORITIES = ["HIGH", "MEDIUM", "LOW"];

router.post("/requests", requireUser, async (req, res) => {
  const { boatId, notes, items } = req.body || {};

  if (!boatId) {
    return res.status(400).json({ ok: false, error: "boatId is required" });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: "At least one maintenance item is required" });
  }

  const cleanedItems = items.map((item) => ({
    problemDescription: String(item?.problemDescription || "").trim(),
    classification: String(item?.classification || "").toUpperCase(),
    outOfServiceRequired: !!item?.outOfServiceRequired,
    requiredFixDate: item?.requiredFixDate ? String(item.requiredFixDate) : null,
    priority: String(item?.priority || "MEDIUM").toUpperCase(),
  }));

  for (const item of cleanedItems) {
    if (!item.problemDescription) {
      return res.status(400).json({ ok: false, error: "Each item needs a problemDescription" });
    }
    if (!ALLOWED_CLASSIFICATIONS.includes(item.classification)) {
      return res.status(400).json({ ok: false, error: `Invalid classification: ${item.classification}` });
    }
    if (!ALLOWED_PRIORITIES.includes(item.priority)) {
      return res.status(400).json({ ok: false, error: `Invalid priority: ${item.priority}` });
    }
    if (item.requiredFixDate && !isIsoDate(item.requiredFixDate)) {
      return res.status(400).json({ ok: false, error: "requiredFixDate must be YYYY-MM-DD" });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: userRows } = await client.query(
      `
      SELECT id, email, first_name, last_name, is_goldmember, is_captain
      FROM public.users
      WHERE id = $1
      `,
      [req.user.userId]
    );

    const user = userRows[0];
    if (!user) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "User not found" });
    }
    if (!user.is_goldmember && !user.is_captain) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        error: "ask captains to submit maintenance requests",
      });
    }

    const submittedByName =
      `${user.first_name || ""} ${user.last_name || ""}`.trim() || null;

    const { rows: reqRows } = await client.query(
      `
      INSERT INTO public.maintenance_requests
        (
          boat_id,
          submitted_by_user_id,
          submitted_by_name,
          submitted_by_email,
          notes,
          status
        )
      VALUES
        ($1, $2, $3, $4, $5, 'PENDING_APPROVAL')
      RETURNING *
      `,
      [boatId, user.id, submittedByName, user.email || null, notes || null]
    );

    const requestRow = reqRows[0];

    const insertedItems = [];
    for (const item of cleanedItems) {
      const { rows } = await client.query(
        `
        INSERT INTO public.maintenance_request_items
          (
            maintenance_request_id,
            problem_description,
            classification,
            out_of_service_required,
            required_fix_date,
            priority,
            status
          )
        VALUES
          ($1, $2, $3, $4, $5::date, $6, 'OPEN')
        RETURNING *
        `,
        [
          requestRow.id,
          item.problemDescription,
          item.classification,
          item.outOfServiceRequired,
          item.requiredFixDate,
          item.priority,
        ]
      );
      insertedItems.push(rows[0]);
    }

    await client.query("COMMIT");

    return res.json({
      ok: true,
      request: requestRow,
      items: insertedItems,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/maintenance/requests error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    client.release();
  }
});

module.exports = router;