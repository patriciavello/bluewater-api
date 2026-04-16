const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const requireTechnician = require("../middleware/requireTechnician");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const uploadsRoot = path.join(__dirname, "..", "uploads", "maintenance");

fs.mkdirSync(uploadsRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, uploadsRoot);
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safeBase = path
      .basename(file.originalname || "photo", ext)
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 60);

    cb(null, `${Date.now()}-${safeBase}${ext}`);
  },
});

function imageFileFilter(_req, file, cb) {
  if (file.mimetype && file.mimetype.startsWith("image/")) {
    return cb(null, true);
  }
  cb(new Error("Only image uploads are allowed"));
}

const uploadPhoto = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

// GET /api/technician/maintenance/items
router.get("/maintenance/items", requireTechnician, async (req, res) => {
  try {
    const isTechnicianOnly =
      req.user.isTechnician && !req.user.isSupervisor && !req.user.isAdmin;

    const params = [];
    let whereSql = `
      WHERE mr.status = 'APPROVED'
    `;

    if (isTechnicianOnly) {
      params.push(req.user.userId);
      whereSql += ` AND mri.technician_user_id = $1 `;
    }

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
        tu.first_name as "technicianFirstName",
        tu.last_name as "technicianLastName",
        tu.email as "technicianEmail",
        mri.scheduled_start_date as "scheduledStartDate",
        mri.scheduled_end_date as "scheduledEndDate",
        mri.actual_start_date as "actualStartDate",
        mri.actual_end_date as "actualEndDate",
        mri.completed_at as "completedAt",
        mri.completion_note as "completionNote",
        mri.supervisor_note as "supervisorNote",
        mri.created_at as "createdAt",
        mri.updated_at as "updatedAt"
      FROM public.maintenance_request_items mri
      JOIN public.maintenance_requests mr
        ON mr.id = mri.maintenance_request_id
      JOIN public.boats b
        ON b.id = mr.boat_id
      LEFT JOIN public.users tu
        ON tu.id = mri.technician_user_id
      ${whereSql}
      ORDER BY
        CASE mri.status
          WHEN 'IN_PROGRESS' THEN 1
          WHEN 'ASSIGNED' THEN 2
          WHEN 'WAITING_SUPERVISOR' THEN 3
          WHEN 'OPEN' THEN 4
          WHEN 'DONE_PENDING_REVIEW' THEN 5
          WHEN 'DONE' THEN 6
          ELSE 7
        END,
        CASE mri.priority
          WHEN 'HIGH' THEN 1
          WHEN 'MEDIUM' THEN 2
          ELSE 3
        END,
        mri.required_fix_date NULLS LAST,
        mri.created_at DESC
      `,
      params
    );

    return res.json({ ok: true, items: rows });
  } catch (e) {
    console.error("GET /api/technician/maintenance/items error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// GET /api/technician/maintenance/items/:id
router.get("/maintenance/items/:id", requireTechnician, async (req, res) => {
  try {
    const { id } = req.params;

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
        tu.first_name as "technicianFirstName",
        tu.last_name as "technicianLastName",
        tu.email as "technicianEmail",
        mri.scheduled_start_date as "scheduledStartDate",
        mri.scheduled_end_date as "scheduledEndDate",
        mri.actual_start_date as "actualStartDate",
        mri.actual_end_date as "actualEndDate",
        mri.completed_at as "completedAt",
        mri.completion_note as "completionNote",
        mri.supervisor_note as "supervisorNote",
        mri.created_at as "createdAt",
        mri.updated_at as "updatedAt"
      FROM public.maintenance_request_items mri
      JOIN public.maintenance_requests mr
        ON mr.id = mri.maintenance_request_id
      JOIN public.boats b
        ON b.id = mr.boat_id
      LEFT JOIN public.users tu
        ON tu.id = mri.technician_user_id
      WHERE mri.id = $1
      LIMIT 1
      `,
      [id]
    );

    const item = rows[0];
    if (!item) {
      return res.status(404).json({ ok: false, error: "Maintenance item not found" });
    }

    const isTechnicianOnly =
      req.user.isTechnician && !req.user.isSupervisor && !req.user.isAdmin;

    if (isTechnicianOnly && item.technicianUserId !== req.user.userId) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const { rows: updates } = await pool.query(
      `
      SELECT
        u.id,
        u.maintenance_item_id as "maintenanceItemId",
        u.author_user_id as "authorUserId",
        u.author_role as "authorRole",
        u.update_type as "updateType",
        u.message,
        u.created_at as "createdAt",
        usr.first_name as "authorFirstName",
        usr.last_name as "authorLastName",
        usr.email as "authorEmail"
      FROM public.maintenance_item_updates u
      LEFT JOIN public.users usr
        ON usr.id = u.author_user_id
      WHERE u.maintenance_item_id = $1
      ORDER BY u.created_at ASC
      `,
      [id]
    );

    const { rows: attachments } = await pool.query(
      `
      SELECT
        a.id,
        a.maintenance_item_id as "maintenanceItemId",
        a.uploaded_by_user_id as "uploadedByUserId",
        a.attachment_type as "attachmentType",
        a.file_url as "fileUrl",
        a.file_name as "fileName",
        a.mime_type as "mimeType",
        a.transcript_text as "transcriptText",
        a.created_at as "createdAt"
      FROM public.maintenance_item_attachments a
      WHERE a.maintenance_item_id = $1
      ORDER BY a.created_at ASC
      `,
      [id]
    );

    const { rows: scheduleRequests } = await pool.query(
      `
      SELECT
        sr.id,
        sr.maintenance_item_id as "maintenanceItemId",
        sr.requested_by_user_id as "requestedByUserId",
        sr.requested_start_date as "requestedStartDate",
        sr.requested_end_date as "requestedEndDate",
        sr.justification,
        sr.status,
        sr.reviewed_by_user_id as "reviewedByUserId",
        sr.reviewed_at as "reviewedAt",
        sr.created_at as "createdAt"
      FROM public.maintenance_item_schedule_requests sr
      WHERE sr.maintenance_item_id = $1
      ORDER BY sr.created_at DESC
      `,
      [id]
    );

    return res.json({
      ok: true,
      item,
      updates,
      attachments,
      scheduleRequests,
    });
  } catch (e) {
    console.error("GET /api/technician/maintenance/items/:id error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// POST /api/technician/maintenance/items/:id/start
router.post("/maintenance/items/:id/start", requireTechnician, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT id, technician_user_id as "technicianUserId", status
      FROM public.maintenance_request_items
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    );

    const item = rows[0];
    if (!item) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Maintenance item not found" });
    }

    const isTechnicianOnly =
      req.user.isTechnician && !req.user.isSupervisor && !req.user.isAdmin;

    if (isTechnicianOnly && item.technicianUserId !== req.user.userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const { rows: updatedRows } = await client.query(
      `
      UPDATE public.maintenance_request_items
      SET
        status = 'IN_PROGRESS',
        actual_start_date = COALESCE(actual_start_date, CURRENT_DATE),
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        status,
        actual_start_date as "actualStartDate",
        updated_at as "updatedAt"
      `,
      [id]
    );

    await client.query(
      `
      INSERT INTO public.maintenance_item_updates
        (maintenance_item_id, author_user_id, author_role, update_type, message)
      VALUES
        ($1, $2, $3, 'STATUS_CHANGE', 'Work started')
      `,
      [
        id,
        req.user.userId,
        req.user.isSupervisor ? "SUPERVISOR" : req.user.isAdmin ? "ADMIN" : "TECHNICIAN",
      ]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, item: updatedRows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/technician/maintenance/items/:id/start error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    client.release();
  }
});

// POST /api/technician/maintenance/items/:id/note
router.post("/maintenance/items/:id/note", requireTechnician, async (req, res) => {
  try {
    const { id } = req.params;
    const message = String(req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({ ok: false, error: "Message is required" });
    }

    const { rows } = await pool.query(
      `
      SELECT id, technician_user_id as "technicianUserId"
      FROM public.maintenance_request_items
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const item = rows[0];
    if (!item) {
      return res.status(404).json({ ok: false, error: "Maintenance item not found" });
    }

    const isTechnicianOnly =
      req.user.isTechnician && !req.user.isSupervisor && !req.user.isAdmin;

    if (isTechnicianOnly && item.technicianUserId !== req.user.userId) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const { rows: inserted } = await pool.query(
      `
      INSERT INTO public.maintenance_item_updates
        (maintenance_item_id, author_user_id, author_role, update_type, message)
      VALUES
        ($1, $2, $3, 'NOTE', $4)
      RETURNING
        id,
        maintenance_item_id as "maintenanceItemId",
        author_user_id as "authorUserId",
        author_role as "authorRole",
        update_type as "updateType",
        message,
        created_at as "createdAt"
      `,
      [
        id,
        req.user.userId,
        req.user.isSupervisor ? "SUPERVISOR" : req.user.isAdmin ? "ADMIN" : "TECHNICIAN",
        message,
      ]
    );

    await pool.query(
      `
      UPDATE public.maintenance_request_items
      SET updated_at = NOW()
      WHERE id = $1
      `,
      [id]
    );

    return res.json({ ok: true, update: inserted[0] });
  } catch (e) {
    console.error("POST /api/technician/maintenance/items/:id/note error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// POST /api/technician/maintenance/items/:id/request-schedule-change
router.post("/maintenance/items/:id/request-schedule-change", requireTechnician, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const requestedStartDate = req.body?.requestedStartDate || null;
    const requestedEndDate = req.body?.requestedEndDate || null;
    const justification = String(req.body?.justification || "").trim();

    if (!justification) {
      return res.status(400).json({ ok: false, error: "Justification is required" });
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT id, technician_user_id as "technicianUserId"
      FROM public.maintenance_request_items
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    );

    const item = rows[0];
    if (!item) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Maintenance item not found" });
    }

    const isTechnicianOnly =
      req.user.isTechnician && !req.user.isSupervisor && !req.user.isAdmin;

    if (isTechnicianOnly && item.technicianUserId !== req.user.userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const { rows: requestRows } = await client.query(
      `
      INSERT INTO public.maintenance_item_schedule_requests
        (maintenance_item_id, requested_by_user_id, requested_start_date, requested_end_date, justification, status)
      VALUES
        ($1, $2, $3::date, $4::date, $5, 'PENDING')
      RETURNING
        id,
        maintenance_item_id as "maintenanceItemId",
        requested_by_user_id as "requestedByUserId",
        requested_start_date as "requestedStartDate",
        requested_end_date as "requestedEndDate",
        justification,
        status,
        created_at as "createdAt"
      `,
      [id, req.user.userId, requestedStartDate, requestedEndDate, justification]
    );

    await client.query(
      `
      UPDATE public.maintenance_request_items
      SET
        status = 'WAITING_SUPERVISOR',
        updated_at = NOW()
      WHERE id = $1
      `,
      [id]
    );

    await client.query(
      `
      INSERT INTO public.maintenance_item_updates
        (maintenance_item_id, author_user_id, author_role, update_type, message)
      VALUES
        ($1, $2, $3, 'DATE_CHANGE_REQUEST', $4)
      `,
      [
        id,
        req.user.userId,
        req.user.isSupervisor ? "SUPERVISOR" : req.user.isAdmin ? "ADMIN" : "TECHNICIAN",
        justification,
      ]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, scheduleRequest: requestRows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/technician/maintenance/items/:id/request-schedule-change error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    client.release();
  }
});

// POST /api/technician/maintenance/items/:id/complete
router.post("/maintenance/items/:id/complete", requireTechnician, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const completionNote = String(req.body?.completionNote || "").trim();

    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT id, technician_user_id as "technicianUserId"
      FROM public.maintenance_request_items
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    );

    const item = rows[0];
    if (!item) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Maintenance item not found" });
    }

    const isTechnicianOnly =
      req.user.isTechnician && !req.user.isSupervisor && !req.user.isAdmin;

    if (isTechnicianOnly && item.technicianUserId !== req.user.userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const { rows: updatedRows } = await client.query(
      `
      UPDATE public.maintenance_request_items
      SET
        status = 'DONE_PENDING_REVIEW',
        actual_end_date = CURRENT_DATE,
        completed_at = NOW(),
        completion_note = $2,
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        status,
        actual_end_date as "actualEndDate",
        completed_at as "completedAt",
        completion_note as "completionNote",
        updated_at as "updatedAt"
      `,
      [id, completionNote || null]
    );

    await client.query(
      `
      INSERT INTO public.maintenance_item_updates
        (maintenance_item_id, author_user_id, author_role, update_type, message)
      VALUES
        ($1, $2, $3, 'COMPLETE', $4)
      `,
      [
        id,
        req.user.userId,
        req.user.isSupervisor ? "SUPERVISOR" : req.user.isAdmin ? "ADMIN" : "TECHNICIAN",
        completionNote || "Work marked complete",
      ]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, item: updatedRows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/technician/maintenance/items/:id/complete error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    client.release();
  }
});

// POST /api/technician/maintenance/items/:id/photo
router.post(
  "/maintenance/items/:id/photo",
  requireTechnician,
  uploadPhoto.single("photo"),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!req.file) {
        return res.status(400).json({ ok: false, error: "Photo file is required" });
      }

      const { rows } = await pool.query(
        `
        SELECT id, technician_user_id as "technicianUserId"
        FROM public.maintenance_request_items
        WHERE id = $1
        LIMIT 1
        `,
        [id]
      );

      const item = rows[0];
      if (!item) {
        return res.status(404).json({ ok: false, error: "Maintenance item not found" });
      }

      const isTechnicianOnly =
        req.user.isTechnician && !req.user.isSupervisor && !req.user.isAdmin;

      if (isTechnicianOnly && item.technicianUserId !== req.user.userId) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      const fileUrl = `${req.protocol}://${req.get("host")}/uploads/maintenance/${req.file.filename}`;

      const { rows: inserted } = await pool.query(
        `
        INSERT INTO public.maintenance_item_attachments
          (
            maintenance_item_id,
            uploaded_by_user_id,
            attachment_type,
            file_url,
            file_name,
            mime_type
          )
        VALUES
          ($1, $2, 'PHOTO', $3, $4, $5)
        RETURNING
          id,
          maintenance_item_id as "maintenanceItemId",
          uploaded_by_user_id as "uploadedByUserId",
          attachment_type as "attachmentType",
          file_url as "fileUrl",
          file_name as "fileName",
          mime_type as "mimeType",
          transcript_text as "transcriptText",
          created_at as "createdAt"
        `,
        [
          id,
          req.user.userId,
          fileUrl,
          req.file.originalname || req.file.filename,
          req.file.mimetype || null,
        ]
      );

      await pool.query(
        `
        INSERT INTO public.maintenance_item_updates
          (maintenance_item_id, author_user_id, author_role, update_type, message)
        VALUES
          ($1, $2, $3, 'PHOTO', $4)
        `,
        [
          id,
          req.user.userId,
          req.user.isSupervisor ? "SUPERVISOR" : req.user.isAdmin ? "ADMIN" : "TECHNICIAN",
          req.file.originalname || "Photo uploaded",
        ]
      );

      await pool.query(
        `
        UPDATE public.maintenance_request_items
        SET updated_at = NOW()
        WHERE id = $1
        `,
        [id]
      );

      return res.json({ ok: true, attachment: inserted[0] });
    } catch (e) {
      console.error("POST /api/technician/maintenance/items/:id/photo error:", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  }
);

module.exports = router;