require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const authRoutes = require("./routes/auth");
const meRoutes = require("./routes/me");
const healthRoutes = require("./routes/health");
const boatsRoutes = require("./routes/boats");
const scheduleRoutes = require("./routes/schedule");




const app = express();

// ---- CORS (allow your frontend domain) ----
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server or curl/no-origin requests
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
  })
);


app.use("/api/boats", boatsRoutes);
app.use("/api/schedule", scheduleRoutes);


app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Routes
app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/me", meRoutes);

app.get("/", (req, res) => {
  res.json({ ok: true, service: "bluewater-api" });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`✅ Bluewater API listening on port ${port}`);
  console.log(`✅ CORS origin: ${allowedOrigin}`);
});
