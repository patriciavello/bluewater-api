const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // Gmail App Password
  },
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

module.exports = { sendResetEmail };
