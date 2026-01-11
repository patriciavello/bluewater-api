const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.session;
    if (!token) return res.status(401).json({ error: "Not authenticated" });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { userId, isAdmin }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid session" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "Admin only" });
  next();
}

module.exports = { requireAuth, requireAdmin };
