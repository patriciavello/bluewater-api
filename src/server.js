require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

const authRoutes = require("./routes/auth");
const meRoutes = require("./routes/me");
const myReservationsRoutes = require("./routes/myReservations");

const healthRoutes = require("./routes/health");
const boatsRoutes = require("./routes/boats");
const scheduleRoutes = require("./routes/schedule");
const debugRoutes = require("./routes/debug");
const reservationsRoutes = require("./routes/reservations");
const adminRoutes = require("./routes/admin");
const adminUsersRoutes = require("./routes/adminUsers");
const stripeWebhookRoutes = require("./routes/stripeWebhook");
const paymentsRoutes = require("./routes/payments");
const maintenanceRoutes = require("./routes/maintenance");
const supervisorRoutes = require("./routes/supervisor");
const technicianRoutes = require("./routes/technician");
const bcrypt = require("bcryptjs");
const pool = require("./db/pool"); // or your correct pool import
const path = require("path");

const app = express();

console.log("SERVER BOOT:", __filename, "PID:", process.pid);

app.set("trust proxy", 1);



// ---- CORS (MUST be before routes) ----
const allowedOrigins = [
  "http://localhost:5173",
  "https://bluewater-scheduler.onrender.com",
];

const corsOptions = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use((req, _res, next) => {
  console.log("Origin:", req.headers.origin);
  next();
});

// mount webhook BEFORE express.json()
app.use("/api/stripe", stripeWebhookRoutes);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  console.log("AUTH HEADER:", auth);

  if (!auth) {
    console.log("❌ No Authorization header");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  console.log("TOKEN LEN:", token ? token.length : null);

  if (!token) {
    console.log("❌ No Bearer token");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    console.log("✅ VERIFIED payload:", payload);
    req.admin = payload;
    next();
  } catch (e) {
    console.log("❌ VERIFY FAILED:", e.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

function requireFullAdmin(req, res, next) {
  if (!req.admin?.isAdmin) {
    return res.status(403).json({ ok: false, error: "Admin access required" });
  }
  next();
}

app.use("/api/admin", (req, _res, next) => {buildMarker: "admin-login-v3",
  console.log("HIT /api/admin:", req.method, req.path, "auth?", !!req.headers.authorization);
  next();
});

app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};

  // 1) Full admin login using env vars
  if (
  username === process.env.ADMIN_USER &&
  password === process.env.ADMIN_PASSWORD
) {
  const { rows: adminRows } = await pool.query(
    `
    SELECT
      id,
      email,
      first_name,
      last_name,
      is_admin,
      is_supervisor,
      is_technician
    FROM public.users
    WHERE lower(email) = lower($1)
    LIMIT 1
    `,
    [username]
  );

  const adminUser = adminRows[0];

  if (!adminUser) {
    return res.status(500).json({
      ok: false,
      error: "Admin login is configured, but no matching admin user exists in users table",
    });
  }

  const token = jwt.sign(
    {
      role: "admin",
      userId: adminUser.id,
      username: adminUser.email,
      email: adminUser.email,
      isAdmin: true,
      isSupervisor: true,
    },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "12h" }
  );

  return res.json({
    ok: true,
    token,
    buildMarker: "admin-login-v2",
    user: {
      role: "admin",
      userId: adminUser.id,
      email: adminUser.email,
      name:
        `${adminUser.first_name || ""} ${adminUser.last_name || ""}`.trim() ||
        adminUser.email,
      isAdmin: true,
      isSupervisor: true,
    },
  });
}

  // 2) Supervisor login using real user account
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        email,
        password_hash,
        first_name,
        last_name,
        is_supervisor
      FROM public.users
      WHERE lower(email) = lower($1)
      LIMIT 1
      `,
      [username]
    );

    const user = rows[0];
    if (!user) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    if (!user.is_supervisor) {
      return res.status(403).json({
        ok: false,
        error: "This account does not have supervisor access",
      });
    }

    const ok = await bcrypt.compare(password || "", user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        role: "supervisor",
        userId: user.id,
        email: user.email,
        isAdmin: false,
        isSupervisor: true,
      },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({
      ok: true,
      token,
      buildMarker: "supervisor-login-v2",
      user: {
        role: "supervisor",
        userId: user.id,
        email: user.email,
        name:
          `${user.first_name || ""} ${user.last_name || ""}`.trim() || user.email,
        isAdmin: false,
        isSupervisor: true,
      },
    });
  } catch (e) {
    console.error("POST /api/admin/login error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.use("/api/debug", debugRoutes);
app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/me", meRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin", adminUsersRoutes);
app.use("/api/boats", boatsRoutes);
app.use("/api/schedule", scheduleRoutes);
app.use("/api/reservations", reservationsRoutes);
app.use("/api/me/reservations", myReservationsRoutes);
app.use("/api", require("./routes/boats"));
app.use("/api/payments", paymentsRoutes);
app.use("/api/maintenance", maintenanceRoutes);
app.use("/api/supervisor", supervisorRoutes);
app.use("/api/technician", technicianRoutes);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "bluewater-api" });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`✅ Bluewater API listening on port ${port}`);
  console.log(`✅ Allowed CORS origins: ${allowedOrigins.length ? allowedOrigins.join(", ") : "(any)"}`);
});