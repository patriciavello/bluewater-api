const jwt = require("jsonwebtoken");

module.exports = function requireUser(req, res, next) {
  // 1) Try Bearer token (optional support)
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;

  // 2) Try HttpOnly cookie session
  const cookieToken = req.cookies?.session;

  const token = bearer || cookieToken;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { userId, email, ... }
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
};
