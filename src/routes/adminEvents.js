const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const jwt = require("jsonwebtoken");

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

function requireAdminOrSupervisor(req, res, next) {
  if (!req.admin?.isAdmin && !req.admin?.isSupervisor) {
    return res.status(403).json({ ok: false, error: "Admin or supervisor access required" });
  }
  next();
}

function requireFullAdmin(req, res, next) {
  if (!req.admin?.isAdmin) {
    return res.status(403).json({ ok: false, error: "Admin access required" });
  }
  next();
}

async function findExistingEventBlock(client, eventId) {
  const { rows } = await client.query(
    `
    SELECT id
    FROM public.reservations
    WHERE event_id = $1
    LIMIT 1
    `,
    [eventId]
  );
  return rows[0] || null;
}

async function createEventBlock(client, event) {
  const existing = await findExistingEventBlock(client, event.id);
  if (existing) return existing;

  const { rows } = await client.query(
    `
    INSERT INTO public.reservations
      (
        boat_id,
        user_id,
        start_date,
        end_exclusive,
        status,
        requester_name,
        requester_email,
        notes,
        event_id,
        created_at,
        updated_at
      )
    VALUES
      (
        $1,
        NULL,
        $2::date,
        $3::date,
        'BLOCKED',
        'EVENT',
        'events@bluewater.local',
        $4,
        $5,
        NOW(),
        NOW()
      )
    RETURNING
      id,
      boat_id as "boatId",
      start_date as "startDate",
      end_exclusive as "endExclusive",
      status,
      event_id as "eventId"
    `,
    [
      event.boatId,
      event.startDate,
      event.endExclusive,
      `Event block: ${event.title}`,
      event.id,
    ]
  );

  return rows[0];
}

async function removeEventBlock(client, eventId) {
  await client.query(
    `
    DELETE FROM public.reservations
    WHERE event_id = $1
    `,
    [eventId]
  );
}

async function eventHasBookings(client, eventId) {
  const { rows } = await client.query(
    `
    SELECT COUNT(*)::int as count
    FROM public.event_bookings
    WHERE event_id = $1
      AND status IN ('PENDING', 'PAID', 'PENDING_RESPONSE', 'ACCEPTED_CHANGE')
    `,
    [eventId]
  );

  return (rows[0]?.count || 0) > 0;
}

async function checkEventBoatOverlap(client, boatId, startDate, endExclusive, excludeEventId = null) {
  const params = [boatId, startDate, endExclusive];
  let excludeSql = "";

  if (excludeEventId) {
    params.push(excludeEventId);
    excludeSql = `AND (r.event_id IS NULL OR r.event_id <> $4)`;
  }

  const { rows } = await client.query(
    `
    SELECT r.id
    FROM public.reservations r
    WHERE r.boat_id = $1
      AND r.status IN ('PENDING', 'APPROVED', 'BLOCKED', 'MAINTENANCE')
      ${excludeSql}
      AND daterange(r.start_date, r.end_exclusive, '[)')
          && daterange($2::date, $3::date, '[)')
    LIMIT 1
    `,
    params
  );

  return rows.length > 0;
}

// GET /api/admin/events
router.get("/events", requireAdmin, requireAdminOrSupervisor, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        e.id,
        e.parent_event_id as "parentEventId",
        e.boat_id as "boatId",
        b.name as "boatName",
        e.title,
        e.event_type as "eventType",
        e.description,
        e.image_url as "imageUrl",
        e.start_date as "startDate",
        e.end_exclusive as "endExclusive",
        e.status,
        e.max_participants as "maxParticipants",
        e.current_participants as "currentParticipants",
        e.change_notice as "changeNotice",
        e.cancelled_at as "cancelledAt",
        e.created_by_user_id as "createdByUserId",
        e.created_at as "createdAt",
        e.updated_at as "updatedAt"
      FROM public.events e
      JOIN public.boats b ON b.id = e.boat_id
      ORDER BY e.start_date DESC, e.created_at DESC
      `
    );

    return res.json({ ok: true, events: rows });
  } catch (e) {
    console.error("GET /api/admin/events error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// GET /api/admin/events/:id
router.get("/events/:id", requireAdmin, requireAdminOrSupervisor, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: eventRows } = await pool.query(
      `
      SELECT
        e.id,
        e.parent_event_id as "parentEventId",
        e.boat_id as "boatId",
        b.name as "boatName",
        e.title,
        e.event_type as "eventType",
        e.description,
        e.image_url as "imageUrl",
        e.start_date as "startDate",
        e.end_exclusive as "endExclusive",
        e.status,
        e.max_participants as "maxParticipants",
        e.current_participants as "currentParticipants",
        e.change_notice as "changeNotice",
        e.cancelled_at as "cancelledAt",
        e.created_by_user_id as "createdByUserId",
        e.created_at as "createdAt",
        e.updated_at as "updatedAt"
      FROM public.events e
      JOIN public.boats b ON b.id = e.boat_id
      WHERE e.id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!eventRows.length) {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    const { rows: variationRows } = await pool.query(
      `
      SELECT
        id,
        event_id as "eventId",
        name,
        description,
        price,
        capacity,
        participants_count as "participantsCount",
        sort_order as "sortOrder",
        created_at as "createdAt"
      FROM public.event_variations
      WHERE event_id = $1
      ORDER BY sort_order ASC, created_at ASC
      `,
      [id]
    );

    const { rows: bookingRows } = await pool.query(
      `
      SELECT
        eb.id,
        eb.event_id as "eventId",
        eb.variation_id as "variationId",
        eb.user_id as "userId",
        eb.participants_count as "participantsCount",
        eb.status,
        eb.amount_paid as "amountPaid",
        eb.created_at as "createdAt",
        eb.updated_at as "updatedAt",
        ev.name as "variationName",
        u.email as "userEmail",
        u.first_name as "userFirstName",
        u.last_name as "userLastName"
      FROM public.event_bookings eb
      JOIN public.event_variations ev ON ev.id = eb.variation_id
      LEFT JOIN public.users u ON u.id = eb.user_id
      WHERE eb.event_id = $1
      ORDER BY eb.created_at DESC
      `,
      [id]
    );

    return res.json({
      ok: true,
      event: eventRows[0],
      variations: variationRows,
      bookings: bookingRows,
    });
  } catch (e) {
    console.error("GET /api/admin/events/:id error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// POST /api/admin/events
router.post("/events", requireAdmin, requireFullAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      boatId,
      title,
      eventType,
      description = null,
      imageUrl = null,
      startDate,
      endExclusive,
      status = "DRAFT",
      maxParticipants,
      variations = [],
    } = req.body || {};

    if (!boatId || !title || !eventType || !startDate || !endExclusive || !maxParticipants) {
      return res.status(400).json({
        ok: false,
        error: "boatId, title, eventType, startDate, endExclusive, and maxParticipants are required",
      });
    }

    if (!Array.isArray(variations) || !variations.length) {
      return res.status(400).json({
        ok: false,
        error: "At least one variation is required",
      });
    }

    const normalizedStatus = String(status).toUpperCase();
    if (!["DRAFT", "PUBLISHED", "CANCELLED", "CLOSED"].includes(normalizedStatus)) {
      return res.status(400).json({ ok: false, error: "Invalid event status" });
    }

    const normalizedType = String(eventType).toUpperCase();
    if (!["TRAINING", "FLOTILLA"].includes(normalizedType)) {
      return res.status(400).json({ ok: false, error: "Invalid event type" });
    }

    const overlap = await checkEventBoatOverlap(client, boatId, startDate, endExclusive, null);
    if (overlap) {
      return res.status(409).json({
        ok: false,
        error: "Boat is not available for those event dates",
      });
    }

    await client.query("BEGIN");

    const { rows: eventRows } = await client.query(
      `
      INSERT INTO public.events
        (
          boat_id,
          title,
          event_type,
          description,
          image_url,
          start_date,
          end_exclusive,
          status,
          max_participants,
          current_participants,
          created_by_user_id,
          created_at,
          updated_at
        )
      VALUES
        ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, 0, $10, NOW(), NOW())
      RETURNING
        id,
        parent_event_id as "parentEventId",
        boat_id as "boatId",
        title,
        event_type as "eventType",
        description,
        image_url as "imageUrl",
        start_date as "startDate",
        end_exclusive as "endExclusive",
        status,
        max_participants as "maxParticipants",
        current_participants as "currentParticipants",
        created_by_user_id as "createdByUserId",
        created_at as "createdAt",
        updated_at as "updatedAt"
      `,
      [
        boatId,
        title,
        normalizedType,
        description,
        imageUrl,
        startDate,
        endExclusive,
        normalizedStatus,
        Number(maxParticipants),
        req.admin.userId || null,
      ]
    );

    const event = eventRows[0];

    const insertedVariations = [];
    for (const [index, v] of variations.entries()) {
      if (!v?.name || v?.price == null || v?.capacity == null || v?.participantsCount == null) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: `Variation ${index + 1} is missing required fields`,
        });
      }

      const { rows } = await client.query(
        `
        INSERT INTO public.event_variations
          (
            event_id,
            name,
            description,
            price,
            capacity,
            participants_count,
            sort_order,
            created_at
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING
          id,
          event_id as "eventId",
          name,
          description,
          price,
          capacity,
          participants_count as "participantsCount",
          sort_order as "sortOrder",
          created_at as "createdAt"
        `,
        [
          event.id,
          v.name,
          v.description || null,
          Number(v.price),
          Number(v.capacity),
          Number(v.participantsCount),
          Number(v.sortOrder ?? index + 1),
        ]
      );

      insertedVariations.push(rows[0]);
    }

    let block = null;
    if (normalizedStatus === "PUBLISHED") {
      block = await createEventBlock(client, event);
    }

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      event,
      variations: insertedVariations,
      block,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/admin/events error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  } finally {
    client.release();
  }
});

// PATCH /api/admin/events/:id
router.patch("/events/:id", requireAdmin, requireFullAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const {
      boatId,
      title,
      eventType,
      description,
      imageUrl,
      startDate,
      endExclusive,
      status,
      maxParticipants,
      changeNotice,
    } = req.body || {};

    const { rows: existingRows } = await client.query(
      `
      SELECT
        id,
        boat_id as "boatId",
        title,
        event_type as "eventType",
        description,
        image_url as "imageUrl",
        start_date as "startDate",
        end_exclusive as "endExclusive",
        status,
        max_participants as "maxParticipants"
      FROM public.events
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const existing = existingRows[0];
    if (!existing) {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    const hasBookings = await eventHasBookings(client, id);

    const nextBoatId = boatId ?? existing.boatId;
    const nextStartDate = startDate ?? existing.startDate;
    const nextEndExclusive = endExclusive ?? existing.endExclusive;

    const materialChange =
      String(nextBoatId) !== String(existing.boatId) ||
      String(nextStartDate) !== String(existing.startDate) ||
      String(nextEndExclusive) !== String(existing.endExclusive);

    if (hasBookings && materialChange) {
      return res.status(409).json({
        ok: false,
        error: "This event already has bookings. Date/boat changes must go through the event change workflow.",
      });
    }

    const overlap = await checkEventBoatOverlap(
      client,
      nextBoatId,
      nextStartDate,
      nextEndExclusive,
      id
    );

    if (overlap) {
      return res.status(409).json({
        ok: false,
        error: "Boat is not available for those event dates",
      });
    }

    await client.query("BEGIN");

    const { rows: updatedRows } = await client.query(
      `
      UPDATE public.events
      SET
        boat_id = COALESCE($2, boat_id),
        title = COALESCE($3, title),
        event_type = COALESCE($4, event_type),
        description = COALESCE($5, description),
        image_url = COALESCE($6, image_url),
        start_date = COALESCE($7::date, start_date),
        end_exclusive = COALESCE($8::date, end_exclusive),
        status = COALESCE($9, status),
        max_participants = COALESCE($10, max_participants),
        change_notice = COALESCE($11, change_notice),
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        parent_event_id as "parentEventId",
        boat_id as "boatId",
        title,
        event_type as "eventType",
        description,
        image_url as "imageUrl",
        start_date as "startDate",
        end_exclusive as "endExclusive",
        status,
        max_participants as "maxParticipants",
        current_participants as "currentParticipants",
        change_notice as "changeNotice",
        created_by_user_id as "createdByUserId",
        created_at as "createdAt",
        updated_at as "updatedAt"
      `,
      [
        id,
        boatId || null,
        title || null,
        eventType ? String(eventType).toUpperCase() : null,
        description ?? null,
        imageUrl ?? null,
        startDate || null,
        endExclusive || null,
        status ? String(status).toUpperCase() : null,
        maxParticipants != null ? Number(maxParticipants) : null,
        changeNotice ?? null,
      ]
    );

    const updatedEvent = updatedRows[0];

    if (updatedEvent.status === "PUBLISHED") {
      await removeEventBlock(client, id);
      await createEventBlock(client, updatedEvent);
    } else {
      await removeEventBlock(client, id);
    }

    await client.query("COMMIT");

    return res.json({ ok: true, event: updatedEvent });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("PATCH /api/admin/events/:id error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  } finally {
    client.release();
  }
});

// POST /api/admin/events/:id/publish
router.post("/events/:id/publish", requireAdmin, requireFullAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    const { rows: eventRows } = await client.query(
      `
      SELECT
        id,
        boat_id as "boatId",
        title,
        start_date as "startDate",
        end_exclusive as "endExclusive",
        status
      FROM public.events
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const event = eventRows[0];
    if (!event) {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    const overlap = await checkEventBoatOverlap(
      client,
      event.boatId,
      event.startDate,
      event.endExclusive,
      event.id
    );

    if (overlap) {
      return res.status(409).json({
        ok: false,
        error: "Boat is not available for those event dates",
      });
    }

    await client.query("BEGIN");

    const { rows: updatedRows } = await client.query(
      `
      UPDATE public.events
      SET
        status = 'PUBLISHED',
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        boat_id as "boatId",
        title,
        start_date as "startDate",
        end_exclusive as "endExclusive",
        status
      `,
      [id]
    );

    const updated = updatedRows[0];
    const block = await createEventBlock(client, updated);

    await client.query("COMMIT");

    return res.json({ ok: true, event: updated, block });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/admin/events/:id/publish error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  } finally {
    client.release();
  }
});

// POST /api/admin/events/:id/clone
router.post("/events/:id/clone", requireAdmin, requireFullAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const {
      boatId,
      startDate,
      endExclusive,
      status = "DRAFT",
      title,
    } = req.body || {};

    if (!boatId || !startDate || !endExclusive) {
      return res.status(400).json({
        ok: false,
        error: "boatId, startDate, and endExclusive are required to clone an event",
      });
    }

    const { rows: eventRows } = await client.query(
      `
      SELECT
        id,
        boat_id as "boatId",
        title,
        event_type as "eventType",
        description,
        image_url as "imageUrl",
        max_participants as "maxParticipants"
      FROM public.events
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const source = eventRows[0];
    if (!source) {
      return res.status(404).json({ ok: false, error: "Source event not found" });
    }

    const { rows: variationRows } = await client.query(
      `
      SELECT
        name,
        description,
        price,
        capacity,
        participants_count as "participantsCount",
        sort_order as "sortOrder"
      FROM public.event_variations
      WHERE event_id = $1
      ORDER BY sort_order ASC, created_at ASC
      `,
      [id]
    );

    const overlap = await checkEventBoatOverlap(client, boatId, startDate, endExclusive, null);
    if (overlap) {
      return res.status(409).json({
        ok: false,
        error: "Boat is not available for those cloned event dates",
      });
    }

    await client.query("BEGIN");

    const { rows: clonedRows } = await client.query(
      `
      INSERT INTO public.events
        (
          parent_event_id,
          boat_id,
          title,
          event_type,
          description,
          image_url,
          start_date,
          end_exclusive,
          status,
          max_participants,
          current_participants,
          created_by_user_id,
          created_at,
          updated_at
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, 0, $11, NOW(), NOW())
      RETURNING
        id,
        parent_event_id as "parentEventId",
        boat_id as "boatId",
        title,
        event_type as "eventType",
        description,
        image_url as "imageUrl",
        start_date as "startDate",
        end_exclusive as "endExclusive",
        status,
        max_participants as "maxParticipants",
        current_participants as "currentParticipants",
        created_by_user_id as "createdByUserId",
        created_at as "createdAt",
        updated_at as "updatedAt"
      `,
      [
        source.id,
        boatId,
        title || source.title,
        source.eventType,
        source.description,
        source.imageUrl,
        startDate,
        endExclusive,
        String(status).toUpperCase(),
        source.maxParticipants,
        req.admin.userId || null,
      ]
    );

    const clonedEvent = clonedRows[0];
    const clonedVariations = [];

    for (const v of variationRows) {
      const { rows } = await client.query(
        `
        INSERT INTO public.event_variations
          (
            event_id,
            name,
            description,
            price,
            capacity,
            participants_count,
            sort_order,
            created_at
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING
          id,
          event_id as "eventId",
          name,
          description,
          price,
          capacity,
          participants_count as "participantsCount",
          sort_order as "sortOrder",
          created_at as "createdAt"
        `,
        [
          clonedEvent.id,
          v.name,
          v.description,
          v.price,
          v.capacity,
          v.participantsCount,
          v.sortOrder,
        ]
      );

      clonedVariations.push(rows[0]);
    }

    let block = null;
    if (clonedEvent.status === "PUBLISHED") {
      block = await createEventBlock(client, clonedEvent);
    }

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      event: clonedEvent,
      variations: clonedVariations,
      block,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/admin/events/:id/clone error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  } finally {
    client.release();
  }
});

// POST /api/admin/events/:id/cancel
router.post("/events/:id/cancel", requireAdmin, requireFullAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const {
      refundMode = "FULL_REFUND",
      message = null,
    } = req.body || {};

    if (!["FULL_REFUND", "USER_CONFIRMATION_REQUIRED"].includes(refundMode)) {
      return res.status(400).json({ ok: false, error: "Invalid refundMode" });
    }

    await client.query("BEGIN");

    const { rows: eventRows } = await client.query(
      `
      UPDATE public.events
      SET
        status = 'CANCELLED',
        change_notice = COALESCE($2, change_notice),
        cancelled_at = NOW(),
        cancelled_by_user_id = $3,
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        title,
        status,
        cancelled_at as "cancelledAt",
        cancelled_by_user_id as "cancelledByUserId",
        change_notice as "changeNotice"
      `,
      [id, message, req.admin.userId || null]
    );

    if (!eventRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    await removeEventBlock(client, id);

    const { rows: bookingRows } = await client.query(
      `
      SELECT
        id,
        event_id as "eventId",
        variation_id as "variationId",
        user_id as "userId",
        participants_count as "participantsCount",
        status,
        amount_paid as "amountPaid"
      FROM public.event_bookings
      WHERE event_id = $1
      ORDER BY created_at ASC
      `,
      [id]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      event: eventRows[0],
      refundMode,
      bookings: bookingRows,
      message:
        refundMode === "FULL_REFUND"
          ? "Event cancelled. Proceed with full refunds for paid bookings."
          : "Event cancelled. Users must confirm changes or request refund.",
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/admin/events/:id/cancel error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  } finally {
    client.release();
  }
});

module.exports = router;