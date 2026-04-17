const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const jwt = require("jsonwebtoken");

function requireSupervisor(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    req.supervisor = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

router.get("/maintenance/items", requireSupervisor, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        mri.id,
        mri.maintenance_request_id as "maintenanceRequestId",
        mr.status as "requestStatus",
        mr.boat_id as "boatId",
        b.name as "boatName",
        mri.problem_description as "problemDescription",
        mri.classification,
        mri.out_of_service_required as "outOfServiceRequired",
        mri.required_fix_date as "requiredFixDate",
        mri.priority,
        mri.status,
        mri.technician_user_id as "technicianUserId",
        mri.scheduled_start_date as "scheduledStartDate",
        mri.scheduled_end_date as "scheduledEndDate",
        mri.supervisor_note as "supervisorNote",
        mri.created_at as "createdAt",
        mri.updated_at as "updatedAt"
      FROM public.maintenance_request_items mri
      JOIN public.maintenance_requests mr ON mr.id = mri.maintenance_request_id
      JOIN public.boats b ON b.id = mr.boat_id
      ORDER BY
        CASE mri.priority
          WHEN 'HIGH' THEN 1
          WHEN 'MEDIUM' THEN 2
          ELSE 3
        END,
        mri.required_fix_date NULLS LAST,
        mri.created_at DESC
      `
    );

    return res.json({ ok: true, items: rows });
  } catch (e) {
    console.error("GET /api/supervisor/maintenance/items error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.patch("/maintenance/items/:id", requireSupervisor, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      technicianUserId,
      scheduledStartDate,
      scheduledEndDate,
      supervisorNote,
      status,
    } = req.body || {};
    const { rows: existingRows } = await pool.query(
      `
      SELECT
        mri.id,
        mri.maintenance_request_id as "maintenanceRequestId",
        mr.status as "requestStatus"
      FROM public.maintenance_request_items mri
      JOIN public.maintenance_requests mr
        ON mr.id = mri.maintenance_request_id
      WHERE mri.id = $1
      LIMIT 1
      `,
      [id]
    );

    const existing = existingRows[0];

    if (!existing) {
      return res.status(404).json({ ok: false, error: "Maintenance item not found" });
    }

    if (existing.requestStatus !== "APPROVED") {
      return res.status(400).json({
        ok: false,
        error: "Cannot assign technician or change item status until the maintenance request is approved",
      });
    }

    const { rows } = await pool.query(
      `
      UPDATE public.maintenance_request_items
      SET
        technician_user_id = COALESCE($2, technician_user_id),
        scheduled_start_date = COALESCE($3::date, scheduled_start_date),
        scheduled_end_date = COALESCE($4::date, scheduled_end_date),
        supervisor_note = COALESCE($5, supervisor_note),
        status = COALESCE($6, status),
        updated_at = NOW()
      WHERE id = $1
      RETURNING
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
      `,
      [
        id,
        technicianUserId ?? null,
        scheduledStartDate ?? null,
        scheduledEndDate ?? null,
        supervisorNote ?? null,
        status ?? null,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "Maintenance item not found" });
    }

    return res.json({ ok: true, item: rows[0] });
  } catch (e) {
    console.error("PATCH /api/supervisor/maintenance/items/:id error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;