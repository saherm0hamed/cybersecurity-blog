const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) {
    req.flash('error', 'Please log in to access the admin panel');
    return res.redirect('/admin/login');
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    res.clearCookie('admin_token');
    req.flash('error', 'Session expired, please log in again');
    return res.redirect('/admin/login');
  }
}

function redirectIfAuth(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return next();
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    return res.redirect('/admin');
  } catch {
    res.clearCookie('admin_token');
    return next();
  }
}

module.exports = { requireAuth, redirectIfAuth };