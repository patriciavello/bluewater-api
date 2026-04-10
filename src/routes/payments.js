const express = require("express");
const router = express.Router();
const { stripe } = require("../lib/stripe");
const pool = require("../db/pool");
const { requireUser } = require("../middleware/auth"); // adjust to your project

router.post("/create-checkout-session", requireUser, async (req, res) => {
  const { boatId, startDate, durationDays, notes } = req.body || {};

  if (!boatId || !startDate || !durationDays) {
    return res.status(400).json({
      ok: false,
      error: "boatId, startDate, and durationDays are required",
    });
  }

  try {
    const { rows: userRows } = await pool.query(
      `
      SELECT id, email, first_name, last_name, is_goldmember
      FROM users
      WHERE id = $1
      `,
      [req.user.userId]
    );

    const user = userRows[0];
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    if (user.is_goldmember) {
      return res.status(400).json({
        ok: false,
        error: "Gold members do not need card checkout for reservation requests.",
      });
    }

    const { rows: boatRows } = await pool.query(
      `
      SELECT id, name, price_per_day
      FROM boats
      WHERE id = $1
      `,
      [boatId]
    );

    const boat = boatRows[0];
    if (!boat) {
      return res.status(404).json({ ok: false, error: "Boat not found" });
    }

    const days = Math.max(1, Math.min(parseInt(durationDays, 10) || 1, 60));
    const unitAmount = Math.round(Number(boat.price_per_day || 0) * 100);
    const totalAmount = unitAmount * days;

    if (totalAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid reservation amount" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${process.env.VITE_APP_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.VITE_APP_URL}/payment-cancelled`,
      customer_email: user.email,
      line_items: [
        {
          quantity: days,
          price_data: {
            currency: "usd",
            unit_amount: unitAmount,
            product_data: {
              name: `${boat.name} reservation`,
              description: `${startDate} • ${days} day(s)`,
            },
          },
        },
      ],
      metadata: {
        userId: String(user.id),
        boatId: String(boat.id),
        startDate: String(startDate),
        durationDays: String(days),
        notes: String(notes || ""),
      },
    });

    return res.json({
      ok: true,
      url: session.url,
    });
  } catch (e) {
    console.error("POST /api/payments/create-checkout-session error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;