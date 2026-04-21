const express = require("express");
const router = express.Router();
const { stripe } = require("../lib/stripe");
const pool = require("../db/pool");
const { sendReservationCreatedEmail } = require("../lib/mailer");

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

router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("Webhook hit");
    console.log("Stripe event type:", event.type);

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const md = session.metadata || {};

        console.log("Checkout session completed:", session.id);
        console.log("Metadata:", md);

        if (md.kind === "event_booking") {
          const client = await pool.connect();

          try {
            await client.query("BEGIN");

            const eventId = md.eventId;
            const variationId = md.variationId;
            const userId = md.userId;
            const participantsCount = Number(md.participantsCount || 0);
            const amountPaid = Number(md.amountPaid || 0);

            const { rows: eventRows } = await client.query(
              `
              SELECT
                id,
                max_participants as "maxParticipants",
                current_participants as "currentParticipants",
                status
              FROM public.events
              WHERE id = $1
              LIMIT 1
              FOR UPDATE
              `,
              [eventId]
            );

            const eventBooking = eventRows[0];
            if (!eventBooking || eventBooking.status !== "PUBLISHED") {
              throw new Error("Event no longer available");
            }

            const { rows: variationRows } = await client.query(
              `
              SELECT
                id,
                capacity,
                participants_count as "participantsCount"
              FROM public.event_variations
              WHERE id = $1
                AND event_id = $2
              LIMIT 1
              FOR UPDATE
              `,
              [variationId, eventId]
            );

            const variation = variationRows[0];
            if (!variation) {
              throw new Error("Variation not found");
            }

            const { rows: existingRows } = await client.query(
              `
              SELECT id
              FROM public.event_bookings
              WHERE event_id = $1
                AND variation_id = $2
                AND user_id = $3
                AND status IN ('PAID', 'PENDING', 'ACCEPTED_CHANGE')
              LIMIT 1
              `,
              [eventId, variationId, userId]
            );

            if (!existingRows.length) {
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
              const remainingVariationCapacity =
                Number(variation.capacity || 0) - usedVariationSlots;
              const remainingEventParticipants =
                Number(eventBooking.maxParticipants || 0) -
                Number(eventBooking.currentParticipants || 0);

              if (remainingVariationCapacity < 1) {
                throw new Error("Variation sold out before payment confirmation");
              }

              if (remainingEventParticipants < Number(variation.participantsCount || 0)) {
                throw new Error("Event sold out before payment confirmation");
              }

              await client.query(
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
                  ($1, $2, $3, $4, 'PAID', $5, NOW(), NOW())
                `,
                [eventId, variationId, userId, participantsCount, amountPaid]
              );
            }

            await recalcEventParticipants(client, eventId);

            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK");
            console.error("event booking webhook error:", e);
          } finally {
            client.release();
          }

          return res.json({ received: true });
        }

        const userId = md.userId;
        const boatId = md.boatId;
        const startDate = md.startDate;
        const notes = md.notes || "";
        const days = Math.max(1, Math.min(parseInt(md.durationDays, 10) || 1, 60));
        const paymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id || null;

        if (!userId || !boatId || !startDate) {
          console.error("Missing required Stripe metadata", {
            userId,
            boatId,
            startDate,
            durationDays: md.durationDays,
          });
          return res.status(400).json({
            ok: false,
            error: "Missing required Stripe metadata",
          });
        }

        const start = new Date(`${startDate}T00:00:00`);
        if (Number.isNaN(start.getTime())) {
          console.error("Invalid startDate in Stripe metadata:", startDate);
          return res.status(400).json({
            ok: false,
            error: "Invalid startDate in Stripe metadata",
          });
        }

        const end = new Date(start);
        end.setDate(end.getDate() + days);
        const endExclusive = end.toISOString().slice(0, 10);

        console.log("About to insert reservation", {
          userId,
          boatId,
          startDate,
          endExclusive,
          days,
          sessionId: session.id,
          paymentIntentId,
        });

        // idempotency: do not insert twice for same Stripe session
        const { rows: existing } = await pool.query(
          `
          SELECT id
          FROM public.reservations
          WHERE stripe_checkout_session_id = $1
          `,
          [session.id]
        );

        if (existing.length) {
          console.log("Reservation already exists for session:", session.id, existing[0]);
          return res.json({ received: true, duplicate: true });
        }

        const { rows: urows } = await pool.query(
          `
          SELECT id, email, first_name, last_name
          FROM public.users
          WHERE id = $1
          `,
          [userId]
        );

        const u = urows[0];
        const requesterEmail = u?.email || null;
        const requesterName =
          `${u?.first_name || ""} ${u?.last_name || ""}`.trim() || null;

        const amountPaid = Number(((session.amount_total || 0) / 100).toFixed(2));

        const { rows } = await pool.query(
          `
          INSERT INTO public.reservations
            (
              boat_id,
              user_id,
              start_date,
              end_exclusive,
              status,
              created_by_admin,
              notes,
              requester_email,
              requester_name,
              stripe_checkout_session_id,
              payment_status,
              amount_paid,
              paid_at,
              stripe_payment_intent_id
            )
          VALUES
            ($1, $2, $3::date, $4::date, 'PENDING', false, $5, $6, $7, $8, 'PAID', $9, NOW(), $10)
          RETURNING 
            id, 
            boat_id, 
            user_id, 
            start_date, 
            end_exclusive, 
            status, 
            payment_status, 
            amount_paid, 
            paid_at,
            stripe_payment_intent_id
          `,
          [
            boatId,
            userId,
            startDate,
            endExclusive,
            notes || null,
            requesterEmail,
            requesterName,
            session.id,
            amountPaid,
            paymentIntentId,
          ]
        );

        console.log("Reservation inserted:", rows[0]);

        try {
          const { rows: boatRows } = await pool.query(
            `
            SELECT name, location, price_per_day
            FROM public.boats
            WHERE id = $1
            `,
            [boatId]
          );

          const boat = boatRows[0] || {};

          if (requesterEmail) {
            await sendReservationCreatedEmail(requesterEmail, {
              boatName: boat.name || "Boat",
              location: boat.location || null,
              pricePerDay: boat.price_per_day || 0,
              startDate,
              endExclusive,
              paymentStatus: "PAID",
              amountPaid,
              paidAt: new Date().toISOString(),
            });
          }
        } catch (mailErr) {
          console.error("sendReservationCreatedEmail error:", mailErr);
        }
      }

      return res.json({ received: true });
    } catch (e) {
      console.error("Stripe webhook processing error:", e);
      return res.status(500).json({ ok: false, error: "Webhook processing failed" });
    }
  }
);

module.exports = router;
