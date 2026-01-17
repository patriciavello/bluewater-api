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



const app = express();

console.log("SERVER BOOT:", __filename, "PID:", process.pid);

app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));

app.use(cookieParser());



// ---- CORS (MUST be before routes) ----
const allowedOrigins = ["http://localhost:5173","https://bluewater-scheduler.onrender.com",];

const corsOptions = {
    origin: function (origin, cb) {
      // allow requests with no origin (curl/postman)
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS","PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));

// handle preflight for all routes
app.options("*", cors(corsOptions));

// Helpful for debugging (optional)
app.use((req, _res, next) => {
  console.log("Origin:", req.headers.origin);
  next();
});

// ---- Admin auth helpers (optional: keep for debugging) ----
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

// Temporary admin hit logger (optional)
app.use("/api/admin", (req, _res, next) => {
  console.log("HIT /api/admin:", req.method, req.path, "auth?", !!req.headers.authorization);
  next();
});

// ---- Admin login route (now AFTER CORS) ----
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};

  if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Invalid credentials" });
  }

  const token = jwt.sign(
    { role: "admin", username },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({ ok: true, token });
});

// Routes
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

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "bluewater-api" });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`✅ Bluewater API listening on port ${port}`);
  console.log(`✅ Allowed CORS origins: ${allowedOrigins.length ? allowedOrigins.join(", ") : "(any)"}`);
});
