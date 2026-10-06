require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const flash = require('connect-flash');
const methodOverride = require('method-override');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { db, initDatabase } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;

if (isProduction && (!sessionSecret || sessionSecret.length < 32)) {
  throw new Error('Set SESSION_SECRET to a random value of at least 32 characters in production');
}
const appSecret = sessionSecret || crypto.randomBytes(32).toString('hex');

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Ensure uploads dirs exist (sync is fine)
const uploadsDir = path.join(__dirname, 'public', 'uploads');
const postUploadsDir = path.join(uploadsDir, 'posts');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(postUploadsDir, { recursive: true });

// ---------- async bootstrap (runs once) ----------
let bootstrapPromise = null;

async function initializePostUploadDirectories() {
  const result = await db.execute('SELECT id, cover_image FROM posts');
  const posts = result.rows;

  for (const post of posts) {
    const postDirectory = path.join(postUploadsDir, String(post.id));
    fs.mkdirSync(postDirectory, { recursive: true });

    if (typeof post.cover_image !== 'string' || !post.cover_image.startsWith('/uploads/')) continue;
    const filename = path.basename(post.cover_image);
    const legacyUrl = `/uploads/${filename}`;
    if (post.cover_image !== legacyUrl) continue;

    const sourcePath = path.join(uploadsDir, filename);
    const destinationPath = path.join(postDirectory, filename);
    const postCoverUrl = `/uploads/posts/${post.id}/${filename}`;

    try {
      if (fs.existsSync(sourcePath)) {
        if (!fs.existsSync(destinationPath)) fs.copyFileSync(sourcePath, destinationPath);
        await db.execute({ sql: 'UPDATE posts SET cover_image = ? WHERE id = ?', args: [postCoverUrl, post.id] });
        const countResult = await db.execute({
          sql: 'SELECT COUNT(*) AS count FROM posts WHERE cover_image = ?',
          args: [legacyUrl]
        });
        if (countResult.rows[0].count === 0) fs.unlinkSync(sourcePath);
      } else if (fs.existsSync(destinationPath)) {
        await db.execute({ sql: 'UPDATE posts SET cover_image = ? WHERE id = ?', args: [postCoverUrl, post.id] });
      }
    } catch (error) {
      console.error(`Could not migrate cover image for post ${post.id}:`, error);
    }
  }
}

function ensureBootstrapped() {
  if (!bootstrapPromise) {
    bootstrapPromise = initDatabase()
      .then(() => initializePostUploadDirectories())
      .catch(err => {
        console.error('Startup failed:', err);
        // Reset so a later request can retry
        bootstrapPromise = null;
        throw err;
      });
  }
  return bootstrapPromise;
}

// Kick off bootstrap early (non-blocking)
ensureBootstrapped().catch(() => {});

// ---------- helpers ----------
async function getSetting(key) {
  try {
    const result = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
    return result.rows[0] ? result.rows[0].value : null;
  } catch {
    return null;
  }
}

async function getCategories() {
  try {
    const result = await db.execute('SELECT * FROM categories ORDER BY name');
    return result.rows;
  } catch {
    return [];
  }
}

// ---------- Multer (sync config) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed[ext] === file.mimetype) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});
app.locals.upload = upload;

// ---------- Middleware ----------
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser(appSecret));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// Wait for DB init on every request (cheap after the first one)
app.use(async (req, res, next) => {
  try {
    await ensureBootstrapped();
    next();
  } catch (err) {
    next(err);
  }
});

// JWT → res.locals.admin
app.use((req, res, next) => {
  const token = req.cookies?.admin_token;
  if (token) {
    try {
      res.locals.admin = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      res.locals.admin = null;
    }
  } else {
    res.locals.admin = null;
  }
  next();
});

// Session (for flash only)
app.use(session({
  secret: appSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000
  }
}));
app.use(flash());

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Global locals
app.use(async (req, res, next) => {
  try {
    const [siteName, siteTagline, githubUrl, linkedinUrl, aboutContent, categories] = await Promise.all([
      getSetting('site_name'),
      getSetting('site_tagline'),
      getSetting('github_url'),
      getSetting('linkedin_url'),
      getSetting('about_content'),
      getCategories()
    ]);

    res.locals.success      = req.flash('success');
    res.locals.error        = req.flash('error');
    res.locals.currentPath  = req.path;
    res.locals.siteName     = siteName     || 'sahermØhamed';
    res.locals.siteTagline  = siteTagline  || 'Cybersecurity Blog';
    res.locals.githubUrl    = githubUrl    || '#';
    res.locals.linkedinUrl  = linkedinUrl  || '#';
    res.locals.aboutContent = aboutContent || '';
    res.locals.categories   = categories;
    next();
  } catch (err) {
    next(err);
  }
});

// Routes
const indexRoutes = require('./routes/index');
const adminRoutes = require('./routes/admin');
app.use('/', indexRoutes);
app.use('/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).render('404', { title: 'Page Not Found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', {
    title: 'Error',
    message: isProduction ? 'Something went wrong' : (err.message || 'Something went wrong')
  });
});

// Local only
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`sahermØhamed blog running at http://localhost:${PORT}`);
    console.log(`sahermØhamed Admin:         http://localhost:${PORT}/admin`);
  });
}

// ★ This must be at the top level for Vercel
module.exports = app;