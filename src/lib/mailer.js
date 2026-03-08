const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // Gmail App Password
  },
});

transporter.verify((err, success) => {
  if (err) {
    console.error("SMTP connection failed:", err);
  } else {
    console.log("SMTP server ready");
  }
});

async function sendResetEmail(to, link) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  const subject = "Reset your Bluewater Scheduler password";
  const text =
    `You requested a password reset.\n\n` +
    `Open this link to set a new password:\n${link}\n\n` +
    `If you didn’t request this, ignore this email.\n`;

  await transporter.sendMail({ from, to, subject, text });
}

function formatMoney(v) {
  const n = Number(v || 0);
  return `$${n.toFixed(2)}`;
}

function dayCount(startDate, endExclusive) {
  const s = new Date(`${String(startDate).slice(0, 10)}T00:00:00`);
  const e = new Date(`${String(endExclusive).slice(0, 10)}T00:00:00`);
  return Math.max(1, Math.round((e - s) / 86400000));
}

function visibleEndDate(endExclusive) {
  const d = new Date(`${String(endExclusive).slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function sendReservationCreatedEmail(to, payload) {
  if (!to) return;

  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const nights = dayCount(payload.startDate, payload.endExclusive);
  const total = Number(payload.pricePerDay || 0) * nights;

  const subject = `Reservation request received - ${payload.boatName}`;
  const text =
    `Your reservation request was received.\n\n` +
    `Boat: ${payload.boatName}\n` +
    `Location: ${payload.location || "—"}\n` +
    `Dates: ${payload.startDate} to ${visibleEndDate(payload.endExclusive)}\n` +
    `Days: ${nights}\n` +
    `Price per day: ${formatMoney(payload.pricePerDay)}\n` +
    `Estimated total: ${formatMoney(total)}\n\n` +
    `Status: PENDING\n`;

  await transporter.sendMail({ from, to, subject, text });
}

async function sendReservationApprovedEmail(to, payload) {
  if (!to) return;

  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const nights = dayCount(payload.startDate, payload.endExclusive);
  const total = Number(payload.pricePerDay || 0) * nights;

  const subject = `Reservation approved - ${payload.boatName}`;
  const text =
    `Good news — your reservation was approved.\n\n` +
    `Boat: ${payload.boatName}\n` +
    `Location: ${payload.location || "—"}\n` +
    `Dates: ${payload.startDate} to ${visibleEndDate(payload.endExclusive)}\n` +
    `Days: ${nights}\n` +
    `Price per day: ${formatMoney(payload.pricePerDay)}\n` +
    `Estimated total: ${formatMoney(total)}\n`;

  await transporter.sendMail({ from, to, subject, text });
}

async function sendCaptainAssignedEmails(userEmail, captainEmail, payload) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const nights = dayCount(payload.startDate, payload.endExclusive);
  const total = Number(payload.pricePerDay || 0) * nights;

  const userSubject = `Captain assigned - ${payload.boatName}`;
  const userText =
    `A captain has been assigned to your reservation.\n\n` +
    `Boat: ${payload.boatName}\n` +
    `Location: ${payload.location || "—"}\n` +
    `Dates: ${payload.startDate} to ${visibleEndDate(payload.endExclusive)}\n` +
    `Captain: ${payload.captainName || "—"}\n` +
    `Days: ${nights}\n` +
    `Price per day: ${formatMoney(payload.pricePerDay)}\n` +
    `Estimated total: ${formatMoney(total)}\n`;

  const captainSubject = `You were assigned as captain - ${payload.boatName}`;
  const captainText =
    `You were assigned as captain for a reservation.\n\n` +
    `Boat: ${payload.boatName}\n` +
    `Location: ${payload.location || "—"}\n` +
    `Dates: ${payload.startDate} to ${visibleEndDate(payload.endExclusive)}\n` +
    `Customer: ${payload.requesterName || "—"}\n` +
    `Customer email: ${payload.requesterEmail || "—"}\n`;

  const jobs = [];
  if (userEmail) jobs.push(transporter.sendMail({ from, to: userEmail, subject: userSubject, text: userText }));
  if (captainEmail) jobs.push(transporter.sendMail({ from, to: captainEmail, subject: captainSubject, text: captainText }));

  await Promise.all(jobs);
}

module.exports = {
  sendResetEmail,
  sendReservationCreatedEmail,
  sendReservationApprovedEmail,
  sendCaptainAssignedEmails,
};
