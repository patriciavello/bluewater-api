const jwt = require("jsonwebtoken");

module.exports = function requireAdmin(req, res, next) {
  try {
    const bearer =
      req.headers.authorization && req.headers.authorization.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null;

    const token =
      bearer ||
      (req.cookies && req.cookies.session) ||
      null;


    if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });



    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET);


    const isAdmin = payload?.isAdmin === true || payload?.role === "admin";
    if (!isAdmin) return res.status(403).json({ ok: false, error: "Forbidden" });
    

    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
};
