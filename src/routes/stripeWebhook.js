const express = require("express");
const router = express.Router();
const { stripe } = require("../lib/stripe");
const pool = require("../db/pool");
const { sendReservationCreatedEmail } = require("../lib/mailer"); // adjust if needed

router.post("/webhook",
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
        console.log("Checkout session completed:", session.id);
        console.log("Metadata:", session.metadata);
        const md = session.metadata || {};

        const userId = md.userId;
        const boatId = md.boatId;
        const startDate = md.startDate;
        const notes = md.notes || "";
        const days = Math.max(1, Math.min(parseInt(md.durationDays, 10) || 1, 60));

        const start = new Date(`${startDate}T00:00:00`);
        const end = new Date(start);
        end.setDate(end.getDate() + days);
        const endExclusive = end.toISOString().slice(0, 10);

        const { rows: urows } = await pool.query(
          `
          SELECT id, email, first_name, last_name
          FROM users
          WHERE id = $1
          `,
          [userId]
        );
        const u = urows[0];
        
        console.log("About to insert reservation", {
          userId,
          boatId,
          startDate,
          endExclusive,
          days,
          sessionId: session.id,
        });

        const requesterEmail = u?.email || null;
        const requesterName =
          `${u?.first_name || ""} ${u?.last_name || ""}`.trim() || null;

        // idempotency: do not insert twice for same Stripe session
        const { rows: existing } = await pool.query(
          `
          SELECT id
          FROM reservations
          WHERE stripe_checkout_session_id = $1
          `,
          [session.id]
        );
        console.log("Reservation inserted:", rows[0]);

        if (!existing.length) {
          const { rows } = await pool.query(
            `
            INSERT INTO reservations
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
                amount_paid
              )
            VALUES
              ($1, $2, $3::date, $4::date, 'PENDING', false, $5, $6, $7, $8, 'PAID', $9)
            RETURNING id, boat_id, start_date, end_exclusive, status
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
              (session.amount_total || 0) / 100,
            ]
          );

          try {
            const { rows: boatRows } = await pool.query(
              `SELECT name, location, price_per_day FROM boats WHERE id = $1`,
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
              });
            }
          } catch (mailErr) {
            console.error("sendReservationCreatedEmail error:", mailErr);
          }
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