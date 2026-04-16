const jwt = require("jsonwebtoken");
const pool = require("../db/pool");

module.exports = async function requireTechnician(req, res, next) {
  try {
    const bearer =
      req.headers.authorization && req.headers.authorization.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null;

    const token =
      bearer ||
      (req.cookies && req.cookies.session) ||
      null;

    if (!token) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const payload = jwt.verify(
      token,
      process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET
    );

    const userId = payload?.userId || payload?.id || null;
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { rows } = await pool.query(
      `
      SELECT
        id,
        email,
        first_name,
        last_name,
        is_technician,
        is_supervisor,
        is_admin
      FROM public.users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    const user = rows[0];
    if (!user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (!user.is_technician && !user.is_supervisor && !user.is_admin) {
      return res.status(403).json({ ok: false, error: "Technician access required" });
    }

    req.user = {
      userId: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      isTechnician: !!user.is_technician,
      isSupervisor: !!user.is_supervisor,
      isAdmin: !!user.is_admin,
    };

    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
};