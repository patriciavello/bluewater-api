const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const requireUser = require("../middleware/requireUser");
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function recalcEventParticipants(client, eventId) {
  const { rows } = await client.query(
    `
    SELECT COALESCE(SUM(participants_count), 0)::int as total
    FROM public.event_bookings
    WHERE event_id = $1
      AND status IN ('PENDING', 'PAID', 'ACCEPTED_CHANGE')
    `,
    [eventId]
  );

  const total = rows[0]?.total || 0;

  await client.query(
    `
    UPDATE public.events
    SET
      current_participants = $2,
      updated_at = NOW()
    WHERE id = $1
    `,
    [eventId, total]
  );

  return total;
}

// GET /api/events
router.get("/events", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        e.id,
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
        (e.max_participants - e.current_participants) as "remainingParticipants"
      FROM public.events e
      JOIN public.boats b ON b.id = e.boat_id
      WHERE e.status = 'PUBLISHED'
      ORDER BY e.start_date ASC, e.created_at DESC
      `
    );

    return res.json({ ok: true, events: rows });
  } catch (e) {
    console.error("GET /api/events error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// GET /api/events/:id
router.get("/events/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: eventRows } = await pool.query(
      `
      SELECT
        e.id,
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
        (e.max_participants - e.current_participants) as "remainingParticipants"
      FROM public.events e
      JOIN public.boats b ON b.id = e.boat_id
      WHERE e.id = $1
        AND e.status = 'PUBLISHED'
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
        ev.id,
        ev.event_id as "eventId",
        ev.name,
        ev.description,
        ev.price,
        ev.capacity,
        ev.participants_count as "participantsCount",
        ev.sort_order as "sortOrder",
        COALESCE(used.used_slots, 0)::int as "usedSlots",
        (ev.capacity - COALESCE(used.used_slots, 0))::int as "remainingSlots"
      FROM public.event_variations ev
      LEFT JOIN (
        SELECT
          variation_id,
          COUNT(*)::int as used_slots
        FROM public.event_bookings
        WHERE status IN ('PENDING', 'PAID', 'ACCEPTED_CHANGE')
        GROUP BY variation_id
      ) used
        ON used.variation_id = ev.id
      WHERE ev.event_id = $1
      ORDER BY ev.sort_order ASC, ev.created_at ASC
      `,
      [id]
    );

    return res.json({
      ok: true,
      event: eventRows[0],
      variations: variationRows,
    });
  } catch (e) {
    console.error("GET /api/events/:id error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// GET /api/me/event-bookings
router.get("/me/event-bookings", requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
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
        e.title as "eventTitle",
        e.start_date as "startDate",
        e.end_exclusive as "endExclusive",
        e.event_type as "eventType",
        b.name as "boatName",
        ev.name as "variationName",
        ev.price
      FROM public.event_bookings eb
      JOIN public.events e ON e.id = eb.event_id
      JOIN public.boats b ON b.id = e.boat_id
      JOIN public.event_variations ev ON ev.id = eb.variation_id
      WHERE eb.user_id = $1
      ORDER BY eb.created_at DESC
      `,
      [req.user.userId]
    );

    return res.json({ ok: true, bookings: rows });
  } catch (e) {
    console.error("GET /api/me/event-bookings error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/events/:id/create-checkout-session", requireUser, async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { variationId } = req.body || {};

    if (!variationId) {
      return res.status(400).json({ ok: false, error: "variationId is required" });
    }

    const { rows: eventRows } = await client.query(
      `
      SELECT
        id,
        title,
        status,
        max_participants as "maxParticipants",
        current_participants as "currentParticipants"
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

    if (event.status !== "PUBLISHED") {
      return res.status(400).json({ ok: false, error: "Event is not open for booking" });
    }

    const { rows: variationRows } = await client.query(
      `
      SELECT
        id,
        event_id as "eventId",
        name,
        description,
        price,
        capacity,
        participants_count as "participantsCount"
      FROM public.event_variations
      WHERE id = $1
        AND event_id = $2
      LIMIT 1
      `,
      [variationId, id]
    );

    const variation = variationRows[0];
    if (!variation) {
      return res.status(404).json({ ok: false, error: "Variation not found" });
    }

    const { rows: existingBookingRows } = await client.query(
      `
      SELECT id
      FROM public.event_bookings
      WHERE event_id = $1
        AND variation_id = $2
        AND user_id = $3
        AND status IN ('PENDING', 'PAID', 'ACCEPTED_CHANGE')
      LIMIT 1
      `,
      [id, variationId, req.user.userId]
    );

    if (existingBookingRows.length) {
      return res.status(409).json({
        ok: false,
        error: "You already have a booking for this event variation",
      });
    }

    const { rows: variationUsageRows } = await client.query(
      `
      SELECT COUNT(*)::int as total
      FROM public.event_bookings
      WHERE variation_id = $1
        AND status IN ('PENDING', 'PAID', 'ACCEPTED_CHANGE')
      `,
      [variationId]
    );

    const usedVariationSlots = Number(variationUsageRows[0]?.total || 0);
    const variationCapacity = Number(variation.capacity || 0);
    const variationParticipantsCount = Number(variation.participantsCount || 0);

    const remainingVariationCapacity = variationCapacity - usedVariationSlots;
    if (remainingVariationCapacity < 1) {
      return res.status(409).json({
        ok: false,
        error: "This variation is sold out",
      });
    }

    const maxParticipants = Number(event.maxParticipants || 0);
    const currentParticipants = Number(event.currentParticipants || 0);
    const remainingEventParticipants = maxParticipants - currentParticipants;

    if (remainingEventParticipants < variationParticipantsCount) {
      return res.status(409).json({
        ok: false,
        error: "Not enough participant spots remain for this option",
      });
    }

    const unitAmount = Math.round(Number(variation.price || 0) * 100);
    if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid variation price",
      });
    }

    const successUrl = `${process.env.FRONTEND_URL}/payment-success?kind=event&eventId=${id}`;
    const cancelUrl = `${process.env.FRONTEND_URL}/events/${id}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: req.user.email || undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: unitAmount,
            product_data: {
              name: `${event.title} — ${variation.name}`,
              description: variation.description || undefined,
            },
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        kind: "event_booking",
        eventId: String(id),
        variationId: String(variationId),
        userId: String(req.user.userId),
        participantsCount: String(variationParticipantsCount),
        amountPaid: String(Number(variation.price)),
      },
    });

    return res.json({
      ok: true,
      url: session.url,
      sessionId: session.id,
    });
  } catch (e) {
    console.error("POST /api/events/:id/create-checkout-session error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  } finally {
    client.release();
  }
});

// POST /api/events/:id/book
router.post("/events/:id/book", requireUser, async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { variationId } = req.body || {};

    if (!variationId) {
      return res.status(400).json({ ok: false, error: "variationId is required" });
    }

    await client.query("BEGIN");

    const { rows: eventRows } = await client.query(
      `
      SELECT
        id,
        title,
        status,
        max_participants as "maxParticipants",
        current_participants as "currentParticipants"
      FROM public.events
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const event = eventRows[0];
    if (!event) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    if (event.status !== "PUBLISHED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Event is not open for booking" });
    }

    const { rows: variationRows } = await client.query(
      `
      SELECT
        id,
        event_id as "eventId",
        name,
        price,
        capacity,
        participants_count as "participantsCount"
      FROM public.event_variations
      WHERE id = $1
        AND event_id = $2
      LIMIT 1
      `,
      [variationId, id]
    );

    const variation = variationRows[0];
    if (!variation) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Variation not found" });
    }

    const { rows: existingBookingRows } = await client.query(
      `
      SELECT id
      FROM public.event_bookings
      WHERE event_id = $1
        AND variation_id = $2
        AND user_id = $3
        AND status IN ('PENDING', 'PAID', 'ACCEPTED_CHANGE')
      LIMIT 1
      `,
      [id, variationId, req.user.userId]
    );

    if (existingBookingRows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "You already have a booking for this event variation",
      });
    }

    const { rows: variationUsageRows } = await client.query(
      `
      SELECT COUNT(*)::int as total
      FROM public.event_bookings
      WHERE variation_id = $1
        AND status IN ('PENDING', 'PAID', 'ACCEPTED_CHANGE')
      `,
      [variationId]
    );

    const usedVariationSlots = Number(variationUsageRows[0]?.total || 0);
    const variationCapacity = Number(variation.capacity || 0);
    const variationParticipantsCount = Number(variation.participantsCount || 0);

    const remainingVariationCapacity = variationCapacity - usedVariationSlots;
    if (remainingVariationCapacity < 1) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "This variation is sold out",
      });
    }

    const maxParticipants = Number(event.maxParticipants || 0);
    const currentParticipants = Number(event.currentParticipants || 0);
    const remainingEventParticipants = maxParticipants - currentParticipants;

    if (remainingEventParticipants < variationParticipantsCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "Not enough participant spots remain for this option",
      });
    }

    const { rows: bookingRows } = await client.query(
      `
      INSERT INTO public.event_bookings
        (
          event_id,
          variation_id,
          user_id,
          participants_count,
          status,
          amount_paid,
          created_at,
          updated_at
        )
      VALUES
        ($1, $2, $3, $4, 'PENDING', $5, NOW(), NOW())
      RETURNING
        id,
        event_id as "eventId",
        variation_id as "variationId",
        user_id as "userId",
        participants_count as "participantsCount",
        status,
        amount_paid as "amountPaid",
        created_at as "createdAt",
        updated_at as "updatedAt"
      `,
      [
        id,
        variationId,
        req.user.userId,
        variationParticipantsCount,
        Number(variation.price),
      ]
    );

    const totalParticipants = await recalcEventParticipants(client, id);

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      booking: bookingRows[0],
      eventParticipants: totalParticipants,
      message: "Event booking created",
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/events/:id/book error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  } finally {
    client.release();
  }
});



module.exports = router;