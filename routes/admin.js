require('dotenv').config();
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const slugify = require('slugify');
const path = require('path');
const fs = require('fs');
const { db } = require('../db/database');
const { requireAuth, redirectIfAuth } = require('../middleware/auth');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinary');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many login attempts. Try again in 15 minutes.'
});

// Multer
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
const postUploadsDir = path.join(uploadsDir, 'posts');
const postUploadDirectory = (postId) => path.join(postUploadsDir, String(postId));
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const imageFileFilter = (req, file, cb) => {
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
};

const uploadOptions = {
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFileFilter
};
const upload = multer({ storage, ...uploadOptions });
const postUpload = multer({ storage: multer.memoryStorage(), ...uploadOptions });

// async function savePostCover(postId, file) {
//   const directory = postUploadDirectory(postId);
//   await fs.promises.mkdir(directory, { recursive: true });
//   const extension = path.extname(file.originalname).toLowerCase();
//   const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
//   await fs.promises.writeFile(path.join(directory, filename), file.buffer, { flag: 'wx' });
//   return `/uploads/posts/${postId}/${filename}`;
// }

// ========== AUTH ==========
router.get('/login', redirectIfAuth, (req, res) => {
  res.render('admin/login', { error: req.flash('error') });
});

router.post('/login', loginLimiter, redirectIfAuth, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.render('admin/login', { error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000
    });

    return res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, (req, res) => {
  res.clearCookie('admin_token');
  return res.redirect('/admin/login');
});

// ========== DASHBOARD ==========
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [posts, published, drafts, certificates, projects, categories, recentPosts] = await Promise.all([
      db.execute("SELECT COUNT(*) as c FROM posts"),
      db.execute("SELECT COUNT(*) as c FROM posts WHERE status = 'published'"),
      db.execute("SELECT COUNT(*) as c FROM posts WHERE status = 'draft'"),
      db.execute("SELECT COUNT(*) as c FROM certificates"),
      db.execute("SELECT COUNT(*) as c FROM projects"),
      db.execute("SELECT COUNT(*) as c FROM categories"),
      db.execute("SELECT id, title, status, updated_at FROM posts ORDER BY updated_at DESC LIMIT 5")
    ]);

    const stats = {
      posts:        posts.rows[0].c,
      published:    published.rows[0].c,
      drafts:       drafts.rows[0].c,
      certificates: certificates.rows[0].c,
      projects:     projects.rows[0].c,
      categories:   categories.rows[0].c,
    };

    res.render('admin/dashboard', { title: 'Dashboard', stats, recentPosts: recentPosts.rows });
  } catch (err) { next(err); }
});

// ========== FINGERPRINTS ==========
router.get('/fingerprints', requireAuth, async (req, res, next) => {
  try {
    const postRows = await db.execute(`
      SELECT p.id, p.title, p.slug,
        COUNT(f.id) AS fingerprint_count,
        MAX(f.visited_at) AS last_seen
      FROM posts p
      LEFT JOIN post_visit_fingerprints f ON f.post_id = p.id
      WHERE p.status = 'published'
      GROUP BY p.id
      ORDER BY last_seen DESC, p.title ASC
    `);
    const posts = postRows.rows;

    const selectedPostId = Number.parseInt(req.query.post_id || (posts[0] && posts[0].id) || '0', 10);
    const selectedPost = posts.find(p => p.id === selectedPostId) || posts[0] || null;

    let fingerprints = [];
    if (selectedPost) {
      const fp = await db.execute({
        sql: 'SELECT * FROM post_visit_fingerprints WHERE post_id = ? ORDER BY visited_at DESC LIMIT 50',
        args: [selectedPost.id]
      });
      fingerprints = fp.rows;
    }

    res.render('admin/fingerprints/index', { title: 'Post Fingerprints', posts, selectedPost, fingerprints });
  } catch (err) { next(err); }
});

router.get('/fingerprints/export', requireAuth, async (req, res, next) => {
  try {
    const postId = Number.parseInt(req.query.post_id, 10);
    if (!Number.isInteger(postId)) {
      req.flash('error', 'Please select a post to export.');
      return res.redirect('/admin/fingerprints');
    }

    const postResult = await db.execute({
      sql: "SELECT id, title FROM posts WHERE id = ? AND status = 'published'",
      args: [postId]
    });
    const post = postResult.rows[0];
    if (!post) {
      req.flash('error', 'Post not found.');
      return res.redirect('/admin/fingerprints');
    }

    const recordsResult = await db.execute({
      sql: `SELECT visitor_id, fingerprint_hash, page_path, visitor_ip, ip_hash, user_agent, browser, platform,
               language, timezone, screen_resolution, viewport, color_depth, device_memory,
               cpu_cores, referrer, visited_at, updated_at
            FROM post_visit_fingerprints WHERE post_id = ? ORDER BY visited_at DESC`,
      args: [post.id]
    });

    const columns = [
      'visitor_id','fingerprint_hash','page_path','visitor_ip','ip_hash','user_agent','browser','platform',
      'language','timezone','screen_resolution','viewport','color_depth','device_memory',
      'cpu_cores','referrer','visited_at','updated_at'
    ];
    const escapeCsv = (value) => {
      const s = value === null || typeof value === 'undefined' ? '' : String(value);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csv = [
      columns.join(','),
      ...recordsResult.rows.map(row => columns.map(col => escapeCsv(row[col])).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${post.title.replace(/[^a-z0-9-_ ]/gi,'').replace(/\s+/g,'-').toLowerCase()}-fingerprints.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

router.post('/fingerprints/:id/delete', requireAuth, async (req, res, next) => {
  try {
    const fingerprintId = Number.parseInt(req.params.id, 10);
    const recordResult = await db.execute({
      sql: 'SELECT post_id FROM post_visit_fingerprints WHERE id = ?',
      args: [fingerprintId]
    });
    const record = recordResult.rows[0];
    if (!record) {
      req.flash('error', 'Fingerprint record not found.');
      return res.redirect('/admin/fingerprints');
    }

    await db.execute({ sql: 'DELETE FROM post_visit_fingerprints WHERE id = ?', args: [fingerprintId] });
    req.flash('success', 'Fingerprint record deleted.');
    res.redirect(`/admin/fingerprints?post_id=${record.post_id}`);
  } catch (err) { next(err); }
});

router.post('/fingerprints/post/:postId/delete-all', requireAuth, async (req, res, next) => {
  try {
    const postId = Number.parseInt(req.params.postId, 10);
    const postResult = await db.execute({
      sql: "SELECT id FROM posts WHERE id = ? AND status = 'published'",
      args: [postId]
    });
    if (!postResult.rows[0]) {
      req.flash('error', 'Post not found.');
      return res.redirect('/admin/fingerprints');
    }

    const del = await db.execute({ sql: 'DELETE FROM post_visit_fingerprints WHERE post_id = ?', args: [postId] });
    req.flash('success', `Deleted ${del.rowsAffected} fingerprint record(s).`);
    res.redirect(`/admin/fingerprints?post_id=${postId}`);
  } catch (err) { next(err); }
});

// ========== CATEGORIES ==========
router.get('/categories', requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute(`
      SELECT c.*, COUNT(p.id) AS post_count
      FROM categories c LEFT JOIN posts p ON p.category_id = c.id
      GROUP BY c.id ORDER BY c.name
    `);
    res.render('admin/categories/index', { title: 'Manage Categories', categories: result.rows });
  } catch (err) { next(err); }
});

router.post('/categories', requireAuth, async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const color = (req.body.color || '').trim();
    const slug = slugify(name, { lower: true, strict: true });

    if (!name || name.length > 40 || !slug || !/^#[0-9a-f]{6}$/i.test(color)) {
      req.flash('error', 'Enter a category name (1-40 characters) and a valid color.');
      return res.redirect('/admin/categories');
    }

    await db.execute({ sql: 'INSERT INTO categories (name, slug, color) VALUES (?, ?, ?)', args: [name, slug, color] });
    req.flash('success', 'Category added.');
  } catch (err) {
    req.flash('error', err.message?.includes('UNIQUE') ? 'A category with that name already exists.' : 'Could not add the category.');
  }
  res.redirect('/admin/categories');
});

router.post('/categories/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const name = (req.body.name || '').trim();
    const color = (req.body.color || '').trim();
    const slug = slugify(name, { lower: true, strict: true });

    if (!Number.isInteger(id) || !name || name.length > 40 || !slug || !/^#[0-9a-f]{6}$/i.test(color)) {
      req.flash('error', 'Enter a category name (1-40 characters) and a valid color.');
      return res.redirect('/admin/categories');
    }

    await db.execute({ sql: 'UPDATE categories SET name = ?, slug = ?, color = ? WHERE id = ?', args: [name, slug, color, id] });
    req.flash('success', 'Category updated.');
  } catch (err) {
    req.flash('error', err.message?.includes('UNIQUE') ? 'A category with that name already exists.' : 'Could not update the category.');
  }
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', requireAuth, async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM categories WHERE id = ?', args: [req.params.id] });
    req.flash('success', 'Category deleted. Posts in it are now uncategorized.');
  } catch (err) {
    req.flash('error', 'Could not delete category.');
  }
  res.redirect('/admin/categories');
});

// ========== POSTS ==========
router.get('/posts', requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute(`
      SELECT p.*, c.name as category_name
      FROM posts p LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.updated_at DESC
    `);
    res.render('admin/posts/index', { title: 'Manage Posts', posts: result.rows });
  } catch (err) { next(err); }
});

router.get('/posts/new', requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute('SELECT * FROM categories ORDER BY name');
    res.render('admin/posts/form', { title: 'New Post', post: null, categories: result.rows });
  } catch (err) { next(err); }
});

router.post('/posts', requireAuth, postUpload.single('cover_image'), async (req, res, next) => {
  let createdPostId;
  try {
    const { title, excerpt, content, category_id, author, status, published_at } = req.body;
    let slug = slugify(title, { lower: true, strict: true });

    // Ensure unique slug
    let existing = (await db.execute({ sql: 'SELECT id FROM posts WHERE slug = ?', args: [slug] })).rows[0];
    let counter = 1;
    while (existing) {
      slug = `${slugify(title, { lower: true, strict: true })}-${counter++}`;
      existing = (await db.execute({ sql: 'SELECT id FROM posts WHERE slug = ?', args: [slug] })).rows[0];
    }

    const pubDate = status === 'published' ? (published_at || new Date().toISOString()) : null;

    const result = await db.execute({
      sql: `INSERT INTO posts (title, slug, excerpt, content, cover_image, category_id, author, published_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [title, slug, excerpt, content, null, category_id || null, author || 'Admin', pubDate, status || 'draft']
    });
    createdPostId = Number(result.lastInsertRowid);

    await fs.promises.mkdir(postUploadDirectory(createdPostId), { recursive: true });
    if (req.file) {
      const { url } = await uploadToCloudinary(req.file.buffer, `blog/posts/${createdPostId}`);
      await db.execute({ sql: 'UPDATE posts SET cover_image = ? WHERE id = ?', args: [url, createdPostId] });
    }

    req.flash('success', 'Post created successfully');
    res.redirect('/admin/posts');
  } catch (err) {
    console.error(err);
    if (createdPostId) {
      req.flash('error', `Post created, but its upload could not be saved: ${err.message}`);
      return res.redirect(`/admin/posts/${createdPostId}/edit`);
    }
    req.flash('error', err.message);
    res.redirect('/admin/posts/new');
  }
});

router.get('/posts/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const [postResult, catsResult] = await Promise.all([
      db.execute({ sql: 'SELECT * FROM posts WHERE id = ?', args: [req.params.id] }),
      db.execute('SELECT * FROM categories ORDER BY name')
    ]);
    const post = postResult.rows[0];
    if (!post) return res.redirect('/admin/posts');
    res.render('admin/posts/form', { title: 'Edit Post', post, categories: catsResult.rows });
  } catch (err) { next(err); }
});

router.post('/posts/:id', requireAuth, postUpload.single('cover_image'), async (req, res, next) => {
  try {
    const { title, excerpt, content, category_id, author, status, published_at, existing_cover } = req.body;
    const postResult = await db.execute({ sql: 'SELECT * FROM posts WHERE id = ?', args: [req.params.id] });
    const post = postResult.rows[0];
    if (!post) return res.redirect('/admin/posts');

    await fs.promises.mkdir(postUploadDirectory(post.id), { recursive: true });

    let slug = post.slug;
    if (title !== post.title) {
      slug = slugify(title, { lower: true, strict: true });
      let existing = (await db.execute({ sql: 'SELECT id FROM posts WHERE slug = ? AND id != ?', args: [slug, post.id] })).rows[0];
      let counter = 1;
      while (existing) {
        slug = `${slugify(title, { lower: true, strict: true })}-${counter++}`;
        existing = (await db.execute({ sql: 'SELECT id FROM posts WHERE slug = ? AND id != ?', args: [slug, post.id] })).rows[0];
      }
    }

    // let cover = existing_cover || post.cover_image;
    // if (req.file) cover = await savePostCover(post.id, req.file);
    let cover = existing_cover || post.cover_image;
    if (req.file) {
      // Delete old cover from Cloudinary if it exists
      if (post.cover_image) await deleteFromCloudinary(post.cover_image);
      const { url } = await uploadToCloudinary(req.file.buffer, `blog/posts/${post.id}`);
      cover = url;
    }

    let pubDate = post.published_at;
    if (status === 'published' && !pubDate) pubDate = published_at || new Date().toISOString();
    else if (status === 'draft') pubDate = null;

    await db.execute({
      sql: `UPDATE posts SET title=?, slug=?, excerpt=?, content=?, cover_image=?, category_id=?, author=?,
              published_at=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      args: [title, slug, excerpt, content, cover, category_id || null, author || 'Admin', pubDate, status || 'draft', post.id]
    });

    req.flash('success', 'Post updated successfully');
    res.redirect('/admin/posts');
  } catch (err) {
    console.error(err);
    req.flash('error', err.message);
    res.redirect(`/admin/posts/${req.params.id}/edit`);
  }
});

router.post('/posts/:id/delete', requireAuth, async (req, res, next) => {
  try {
    const postId = Number.parseInt(req.params.id, 10);
    // await db.execute({ sql: 'DELETE FROM posts WHERE id = ?', args: [postId] });
    // await fs.promises.rm(postUploadDirectory(postId), { recursive: true, force: true });
    // Fetch cover before deleting
    const postResult = await db.execute({ sql: 'SELECT cover_image FROM posts WHERE id = ?', args: [postId] });
    const coverImage = postResult.rows[0]?.cover_image;

    await db.execute({ sql: 'DELETE FROM posts WHERE id = ?', args: [postId] });

    if (coverImage) await deleteFromCloudinary(coverImage);
    req.flash('success', 'Post deleted.');
  } catch (err) {
    req.flash('error', 'Post not found or already deleted.');
  }
  res.redirect('/admin/posts');
});

// ========== CERTIFICATES ==========
router.get('/certificates', requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute('SELECT * FROM certificates ORDER BY obtained_date DESC');
    res.render('admin/certificates/index', { title: 'Manage Certificates', certificates: result.rows });
  } catch (err) { next(err); }
});

router.get('/certificates/new', requireAuth, (req, res) => {
  res.render('admin/certificates/form', { title: 'New Certificate', cert: null });
});

router.post('/certificates', requireAuth, upload.single('image'), async (req, res, next) => {
  try {
    const { title, issuer, obtained_date, description, verification_url, category } = req.body;
    // const image = req.file ? '/uploads/' + req.file.filename : null;
    let image = null;
    if (req.file) {
      const { url } = await uploadToCloudinary(req.file.buffer, 'blog/certificates');
      image = url;
    }
    await db.execute({
      sql: `INSERT INTO certificates (title, issuer, obtained_date, image, description, verification_url, category)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [title, issuer, obtained_date, image, description, verification_url, category]
    });
    req.flash('success', 'Certificate added');
    res.redirect('/admin/certificates');
  } catch (err) { next(err); }
});

router.get('/certificates/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM certificates WHERE id = ?', args: [req.params.id] });
    const cert = result.rows[0];
    if (!cert) return res.redirect('/admin/certificates');
    res.render('admin/certificates/form', { title: 'Edit Certificate', cert });
  } catch (err) { next(err); }
});

router.post('/certificates/:id', requireAuth, upload.single('image'), async (req, res, next) => {
  try {
    const { title, issuer, obtained_date, description, verification_url, category, existing_image } = req.body;
    // const image = req.file ? '/uploads/' + req.file.filename : existing_image;
    let image = existing_image;
    if (req.file) {
      if (existing_image) await deleteFromCloudinary(existing_image);
      const { url } = await uploadToCloudinary(req.file.buffer, 'blog/certificates');
      image = url;
    }
    await db.execute({
      sql: `UPDATE certificates SET title=?, issuer=?, obtained_date=?, image=?, description=?, verification_url=?, category=? WHERE id=?`,
      args: [title, issuer, obtained_date, image, description, verification_url, category, req.params.id]
    });
    req.flash('success', 'Certificate updated');
    res.redirect('/admin/certificates');
  } catch (err) { next(err); }
});

router.post('/certificates/:id/delete', requireAuth, async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM certificates WHERE id = ?', args: [req.params.id] });
    req.flash('success', 'Certificate deleted');
  } catch (err) {
    req.flash('error', 'Could not delete certificate.');
  }
  res.redirect('/admin/certificates');
});

// ========== PROJECTS ==========
router.get('/projects', requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute('SELECT * FROM projects ORDER BY created_at DESC');
    res.render('admin/projects/index', { title: 'Manage Projects', projects: result.rows });
  } catch (err) { next(err); }
});

router.get('/projects/new', requireAuth, (req, res) => {
  res.render('admin/projects/form', { title: 'New Project', project: null });
});

router.post('/projects', requireAuth, upload.single('cover_image'), async (req, res, next) => {
  try {
    const { title, short_description, content, tech_stack, github_url, demo_url, status } = req.body;

    let cover = null;
    if (req.file) {
      const { url } = await uploadToCloudinary(req.file.buffer, 'blog/projects');
      cover = url;
    }

    await db.execute({
      sql: `INSERT INTO projects (title, short_description, content, cover_image, tech_stack, github_url, demo_url, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [title, short_description, content, cover, tech_stack, github_url, demo_url, status || 'completed']
    });
    req.flash('success', 'Project added');
    res.redirect('/admin/projects');
  } catch (err) { next(err); }
});

router.get('/projects/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM projects WHERE id = ?', args: [req.params.id] });
    const project = result.rows[0];
    if (!project) return res.redirect('/admin/projects');
    res.render('admin/projects/form', { title: 'Edit Project', project });
  } catch (err) { next(err); }
});

router.post('/projects/:id', requireAuth, upload.single('cover_image'), async (req, res, next) => {
  try {
    const { title, short_description, content, tech_stack, github_url, demo_url, status, existing_cover } = req.body;

    let cover = existing_cover || null;
    if (req.file) {
      if (existing_cover) await deleteFromCloudinary(existing_cover);
      const { url } = await uploadToCloudinary(req.file.buffer, 'blog/projects');
      cover = url;
    }

    await db.execute({
      sql: `UPDATE projects SET title=?, short_description=?, content=?, cover_image=?, tech_stack=?, github_url=?, demo_url=?, status=? WHERE id=?`,
      args: [title, short_description, content, cover, tech_stack, github_url, demo_url, status || 'completed', req.params.id]
    });
    req.flash('success', 'Project updated');
    res.redirect('/admin/projects');
  } catch (err) { next(err); }
});

router.post('/projects/:id/delete', requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: 'SELECT cover_image FROM projects WHERE id = ?',
      args: [req.params.id]
    });
    const project = result.rows[0];

    await db.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [req.params.id] });

    if (project?.cover_image) await deleteFromCloudinary(project.cover_image);

    req.flash('success', 'Project deleted');
  } catch (err) {
    req.flash('error', 'Could not delete project.');
  }
  res.redirect('/admin/projects');
});

// ========== CHANGE PASSWORD ==========
router.get('/change-password', requireAuth, (req, res) => {
  res.render('admin/change-password', { title: 'Change Password', error: req.flash('error'), success: req.flash('success') });
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { current, new_password, confirm } = req.body;
    if (new_password !== confirm) {
      req.flash('error', 'Passwords do not match');
      return res.redirect('/admin/change-password');
    }

    // req.user comes from the JWT payload set by requireAuth
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.user.id] });
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(current, user.password_hash))) {
      req.flash('error', 'Current password is incorrect');
      return res.redirect('/admin/change-password');
    }

    const hash = await bcrypt.hash(new_password, 10);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [hash, user.id] });
    req.flash('success', 'Password changed successfully');
    res.redirect('/admin');
  } catch (err) { next(err); }
});

module.exports = router;