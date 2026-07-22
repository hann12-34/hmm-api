const jwt = require('jsonwebtoken');
const { User } = require('./models');

function signToken(user) {
  return jwt.sign(
    { uid: user.uid, role: user.role, email: user.email, tv: user.tokenVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    const live = await User.findOne({ uid: req.user.uid });
    if (!live) return res.status(401).json({ error: 'Account no longer exists' });
    // Reject tokens issued before the account's version was bumped
    // (e.g. after a password change), which invalidates old sessions.
    if ((req.user.tv ?? 0) !== (live.tokenVersion ?? 0)) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    req.user.role = live.role;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

const STAFF_ROLES = ['admin', 'manager'];
const DASHBOARD_ROLES = ['admin', 'manager', 'worker'];

function isStaffRole(role) {
  return STAFF_ROLES.includes(role);
}

module.exports = {
  signToken,
  authMiddleware,
  requireRole,
  STAFF_ROLES,
  DASHBOARD_ROLES,
  isStaffRole,
};
