require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const authRoutes = require("./routes/auth");
const meRoutes = require("./routes/me");
const healthRoutes = require("./routes/health");
const boatsRoutes = require("./routes/boats");
const scheduleRoutes = require("./routes/schedule");
const debugRoutes = require("./routes/debug");
const reservationsRoutes = require("./routes/reservations");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ---- CORS (allow your frontend domain) ----
const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/postman/server-to-server
      if (allowedOrigins.length === 0) return cb(null, true);
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  })
);

// Helpful for debugging
app.use((req, _res, next) => {
  console.log("Origin:", req.headers.origin);
  next();
});

// Routes
app.use("/api/debug", debugRoutes);
app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/me", meRoutes);

app.use("/api/boats", boatsRoutes);
app.use("/api/schedule", scheduleRoutes);
app.use("/api/reservations", reservationsRoutes);

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "bluewater-api" });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`✅ Bluewater API listening on port ${port}`);
  console.log(
    `✅ Allowed CORS origins: ${
      allowedOrigins.length ? allowedOrigins.join(", ") : "(any)"
    }`
  );
});
