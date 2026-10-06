const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { renderMarkdown } = require('../utils/markdown');
const { requireAuth } = require('../middleware/auth');

const commentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many comments submitted. Please try again later.'
});

function getVisitorId(req, res) {
  const visitorId = req.signedCookies.blog_visitor;
  if (visitorId) return visitorId;

  const newVisitorId = crypto.randomUUID();
  res.cookie('blog_visitor', newVisitorId, {
    signed: true,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 365 * 24 * 60 * 60 * 1000,
    path: '/'
  });
  return newVisitorId;
}

function requireVisitor(req, res, next) {
  if (typeof req.signedCookies.blog_visitor !== 'string') {
    return res.status(403).send('Please reload the post before interacting.');
  }
  next();
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

function buildFingerprint(req, extra = {}) {
  const browser = req.headers['sec-ch-ua'] || '';
  const platform = req.headers['sec-ch-ua-platform'] || '';
  const language = req.headers['accept-language'] || '';
  const userAgent = req.headers['user-agent'] || '';
  const referrer = req.headers.referer || '';
  const ip = getClientIp(req);
  const payload = { ip, userAgent, browser, platform, language, referrer, ...extra };

  const fingerprintHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');

  return {
    fingerprintHash,
    visitorIp: ip,
    ipHash: crypto.createHash('sha256').update(ip).digest('hex'),
    userAgent,
    browser,
    platform,
    language,
    referrer,
    timezone:         extra.timezone         || '',
    screenResolution: extra.screenResolution || '',
    viewport:         extra.viewport         || '',
    colorDepth:       extra.colorDepth       || '',
    deviceMemory:     extra.deviceMemory     || '',
    cpuCores:         extra.cpuCores         || '',
    pagePath:         extra.pagePath         || req.originalUrl || req.path || ''
  };
}

async function savePostVisitFingerprint(postId, visitorId, req, extra = {}) {
  const fingerprint = buildFingerprint(req, { ...extra, pagePath: extra.pagePath || req.path || '/' });

  await db.execute({
    sql: `
      INSERT INTO post_visit_fingerprints (
        post_id, visitor_id, fingerprint_hash, page_path, visitor_ip, ip_hash, user_agent,
        browser, platform, language, timezone, screen_resolution, viewport,
        color_depth, device_memory, cpu_cores, referrer, visited_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(post_id, visitor_id) DO UPDATE SET
        fingerprint_hash = excluded.fingerprint_hash,
        page_path        = excluded.page_path,
        visitor_ip       = excluded.visitor_ip,
        ip_hash          = excluded.ip_hash,
        user_agent       = excluded.user_agent,
        browser          = excluded.browser,
        platform         = excluded.platform,
        language         = excluded.language,
        timezone         = excluded.timezone,
        screen_resolution = excluded.screen_resolution,
        viewport         = excluded.viewport,
        color_depth      = excluded.color_depth,
        device_memory    = excluded.device_memory,
        cpu_cores        = excluded.cpu_cores,
        referrer         = excluded.referrer,
        updated_at       = CURRENT_TIMESTAMP
    `,
    args: [
      postId,
      visitorId,
      fingerprint.fingerprintHash,
      fingerprint.pagePath,
      fingerprint.visitorIp,
      fingerprint.ipHash,
      fingerprint.userAgent,
      fingerprint.browser,
      fingerprint.platform,
      fingerprint.language,
      fingerprint.timezone,
      fingerprint.screenResolution,
      fingerprint.viewport,
      fingerprint.colorDepth,
      fingerprint.deviceMemory,
      fingerprint.cpuCores,
      fingerprint.referrer
    ]
  });
}

function estimateReadingMinutes(content) {
  const wordCount = (content || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(wordCount / 200));
}

// ========== HOME ==========
router.get('/', async (req, res, next) => {
  try {
    const result = await db.execute(`
      SELECT p.*, c.name as category_name, c.slug as category_slug, c.color as category_color,
        (SELECT COUNT(*) FROM post_views v WHERE v.post_id = p.id) AS view_count,
        (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS like_count,
        (SELECT COUNT(*) FROM post_comments cm WHERE cm.post_id = p.id) AS comment_count
      FROM posts p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.status = 'published'
      ORDER BY p.published_at DESC
      LIMIT 12
    `);

    const posts = result.rows.map(post => ({
      ...post,
      reading_minutes: estimateReadingMinutes(post.content)
    }));

    res.render('home', { title: 'Home', posts, featured: posts[0] || null });
  } catch (err) { next(err); }
});

// ========== ALL POSTS ==========
router.get('/posts', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 12;
    const offset = (page - 1) * limit;

    const [totalResult, postsResult] = await Promise.all([
      db.execute("SELECT COUNT(*) as count FROM posts WHERE status = 'published'"),
      db.execute({
        sql: `
          SELECT p.*, c.name as category_name, c.slug as category_slug, c.color as category_color,
            (SELECT COUNT(*) FROM post_views v WHERE v.post_id = p.id) AS view_count,
            (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM post_comments cm WHERE cm.post_id = p.id) AS comment_count
          FROM posts p
          LEFT JOIN categories c ON p.category_id = c.id
          WHERE p.status = 'published'
          ORDER BY p.published_at DESC
          LIMIT ? OFFSET ?
        `,
        args: [limit, offset]
      })
    ]);

    const total = totalResult.rows[0].count;
    const totalPages = Math.ceil(total / limit);
    const posts = postsResult.rows.map(post => ({
      ...post,
      reading_minutes: estimateReadingMinutes(post.content)
    }));

    res.render('posts', { title: 'All Posts', posts, page, totalPages, total });
  } catch (err) { next(err); }
});

// ========== ARCHIVE ==========
router.get('/archive', async (req, res, next) => {
  try {
    const result = await db.execute(`
      SELECT title, slug, excerpt, published_at, created_at,
        strftime('%Y', COALESCE(published_at, created_at)) AS archive_year,
        strftime('%m', COALESCE(published_at, created_at)) AS archive_month
      FROM posts
      WHERE status = 'published'
      ORDER BY COALESCE(published_at, created_at) DESC
    `);
    const rows = result.rows;

    const archive = [];
    for (const post of rows) {
      const year = post.archive_year || 'Earlier';
      let yearGroup = archive.find(g => g.year === year);
      if (!yearGroup) {
        yearGroup = { year, months: [] };
        archive.push(yearGroup);
      }
      const month = post.archive_month || '00';
      let monthGroup = yearGroup.months.find(g => g.key === month);
      if (!monthGroup) {
        const date = new Date(`${year === 'Earlier' ? '2000' : year}-${month === '00' ? '01' : month}-01T00:00:00Z`);
        monthGroup = {
          key: month,
          name: month === '00' ? 'Undated' : date.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }),
          posts: []
        };
        yearGroup.months.push(monthGroup);
      }
      monthGroup.posts.push(post);
    }

    res.render('archive', { title: 'Archive', archive, total: rows.length });
  } catch (err) { next(err); }
});

// ========== SINGLE POST ==========
router.get('/post/:slug', async (req, res, next) => {
  try {
    const postResult = await db.execute({
      sql: `
        SELECT p.*, c.name as category_name, c.slug as category_slug, c.color as category_color
        FROM posts p
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE p.slug = ? AND p.status = 'published'
      `,
      args: [req.params.slug]
    });
    const post = postResult.rows[0];
    if (!post) return res.status(404).render('404', { title: 'Post Not Found' });

    const visitorId = getVisitorId(req, res);

    // Fire fingerprint + view insert in parallel, don't block render on errors
    await Promise.all([
      savePostVisitFingerprint(post.id, visitorId, req),
      db.execute({ sql: 'INSERT OR IGNORE INTO post_views (post_id, visitor_id) VALUES (?, ?)', args: [post.id, visitorId] })
    ]);

    const [viewResult, likeResult, likedResult, commentsResult, commentCountResult, recentResult] = await Promise.all([
      db.execute({ sql: 'SELECT COUNT(*) AS count FROM post_views WHERE post_id = ?',                             args: [post.id] }),
      db.execute({ sql: 'SELECT COUNT(*) AS count FROM post_likes WHERE post_id = ?',                             args: [post.id] }),
      db.execute({ sql: 'SELECT 1 FROM post_likes WHERE post_id = ? AND visitor_id = ?',                          args: [post.id, visitorId] }),
      db.execute({ sql: 'SELECT id, author, body, created_at FROM post_comments WHERE post_id = ? ORDER BY created_at DESC LIMIT 100', args: [post.id] }),
      db.execute({ sql: 'SELECT COUNT(*) AS count FROM post_comments WHERE post_id = ?',                          args: [post.id] }),
      db.execute({
        sql: `
          SELECT p.title, p.slug, p.published_at, c.name as category_name
          FROM posts p
          LEFT JOIN categories c ON p.category_id = c.id
          WHERE p.status = 'published' AND p.id != ?
          ORDER BY p.published_at DESC LIMIT 5
        `,
        args: [post.id]
      })
    ]);

    post.view_count        = viewResult.rows[0].count;
    post.like_count        = likeResult.rows[0].count;
    post.liked_by_visitor  = likedResult.rows.length > 0;

    res.render('post', {
      title: post.title,
      post,
      content:        renderMarkdown(post.content),
      recent:         recentResult.rows,
      comments:       commentsResult.rows,
      commentCount:   commentCountResult.rows[0].count,
      readingMinutes: estimateReadingMinutes(post.content)
    });
  } catch (err) { next(err); }
});

// ========== VISIT FINGERPRINT API ==========
router.post('/api/visit-fingerprint', async (req, res, next) => {
  try {
    const payload = req.body || {};
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    const visitorId = getVisitorId(req, res);

    if (!slug) return res.status(400).json({ success: false, message: 'Post slug is required.' });

    const postResult = await db.execute({
      sql: "SELECT id, slug FROM posts WHERE slug = ? AND status = 'published'",
      args: [slug]
    });
    const post = postResult.rows[0];
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });

    await savePostVisitFingerprint(post.id, visitorId, req, {
      timezone:         payload.timezone         || '',
      screenResolution: payload.screenResolution || '',
      viewport:         payload.viewport         || '',
      colorDepth:       payload.colorDepth       || '',
      deviceMemory:     payload.deviceMemory     || '',
      cpuCores:         payload.cpuCores         || ''
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ========== LIKE ==========
router.post('/post/:slug/like', requireVisitor, async (req, res, next) => {
  try {
    const postResult = await db.execute({
      sql: "SELECT id, slug FROM posts WHERE slug = ? AND status = 'published'",
      args: [req.params.slug]
    });
    const post = postResult.rows[0];
    if (!post) return res.status(404).render('404', { title: 'Post Not Found' });

    const visitorId = req.signedCookies.blog_visitor;
    const existing = await db.execute({
      sql: 'SELECT 1 FROM post_likes WHERE post_id = ? AND visitor_id = ?',
      args: [post.id, visitorId]
    });

    if (existing.rows.length > 0) {
      await db.execute({ sql: 'DELETE FROM post_likes WHERE post_id = ? AND visitor_id = ?', args: [post.id, visitorId] });
    } else {
      await db.execute({ sql: 'INSERT OR IGNORE INTO post_likes (post_id, visitor_id) VALUES (?, ?)', args: [post.id, visitorId] });
    }

    if (req.accepts('json')) {
      const [likedResult, likeCountResult] = await Promise.all([
        db.execute({ sql: 'SELECT 1 FROM post_likes WHERE post_id = ? AND visitor_id = ?', args: [post.id, visitorId] }),
        db.execute({ sql: 'SELECT COUNT(*) AS count FROM post_likes WHERE post_id = ?',    args: [post.id] })
      ]);
      return res.json({ liked: likedResult.rows.length > 0, likeCount: likeCountResult.rows[0].count });
    }

    res.redirect(`/post/${encodeURIComponent(post.slug)}#engagement`);
  } catch (err) { next(err); }
});

// ========== COMMENTS ==========
router.post('/post/:slug/comments', commentLimiter, requireVisitor, async (req, res, next) => {
  try {
    const postResult = await db.execute({
      sql: "SELECT id, slug FROM posts WHERE slug = ? AND status = 'published'",
      args: [req.params.slug]
    });
    const post = postResult.rows[0];
    if (!post) return res.status(404).render('404', { title: 'Post Not Found' });

    // Honeypot
    if (typeof req.body.website === 'string' && req.body.website.trim()) {
      return res.redirect(`/post/${encodeURIComponent(post.slug)}#engagement`);
    }

    const author = typeof req.body.name    === 'string' ? req.body.name.trim()    : '';
    const body   = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';

    if (!author || author.length > 60 || !body || body.length > 3000) {
      req.flash('error', 'Enter a name (up to 60 characters) and a comment (up to 3,000 characters).');
      return res.redirect(`/post/${encodeURIComponent(post.slug)}#comment-form`);
    }

    await db.execute({
      sql: 'INSERT INTO post_comments (post_id, author, body) VALUES (?, ?, ?)',
      args: [post.id, author, body]
    });

    req.flash('success', 'Your comment has been posted.');
    res.redirect(`/post/${encodeURIComponent(post.slug)}#engagement`);
  } catch (err) { next(err); }
});

router.post('/post/:slug/comments/:commentId/delete', requireAuth, async (req, res, next) => {
  try {
    const postResult = await db.execute({
      sql: "SELECT id, slug FROM posts WHERE slug = ? AND status = 'published'",
      args: [req.params.slug]
    });
    const post = postResult.rows[0];
    if (!post) return res.status(404).render('404', { title: 'Post Not Found' });

    const commentId = Number.parseInt(req.params.commentId, 10);
    if (!Number.isInteger(commentId)) {
      req.flash('error', 'Comment not found.');
      return res.redirect(`/post/${encodeURIComponent(post.slug)}#engagement`);
    }

    await db.execute({
      sql: 'DELETE FROM post_comments WHERE id = ? AND post_id = ?',
      args: [commentId, post.id]
    });

    req.flash('success', 'Comment deleted.');
    res.redirect(`/post/${encodeURIComponent(post.slug)}#engagement`);
  } catch (err) { next(err); }
});

// ========== CATEGORY ==========
router.get('/category/:slug', async (req, res, next) => {
  try {
    const categoryResult = await db.execute({
      sql: 'SELECT * FROM categories WHERE slug = ?',
      args: [req.params.slug]
    });
    const category = categoryResult.rows[0];
    if (!category) return res.status(404).render('404', { title: 'Category Not Found' });

    const page = parseInt(req.query.page) || 1;
    const limit = 12;
    const offset = (page - 1) * limit;

    const [totalResult, postsResult] = await Promise.all([
      db.execute({ sql: "SELECT COUNT(*) as count FROM posts WHERE status = 'published' AND category_id = ?", args: [category.id] }),
      db.execute({
        sql: `
          SELECT p.*, c.name as category_name, c.slug as category_slug, c.color as category_color
          FROM posts p
          LEFT JOIN categories c ON p.category_id = c.id
          WHERE p.status = 'published' AND p.category_id = ?
          ORDER BY p.published_at DESC
          LIMIT ? OFFSET ?
        `,
        args: [category.id, limit, offset]
      })
    ]);

    res.render('category', {
      title:      category.name,
      category,
      posts:      postsResult.rows,
      page,
      totalPages: Math.ceil(totalResult.rows[0].count / limit),
      total:      totalResult.rows[0].count
    });
  } catch (err) { next(err); }
});

// ========== SEARCH ==========
router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    let posts = [];

    if (q) {
      const result = await db.execute({
        sql: `
          SELECT p.*, c.name as category_name, c.slug as category_slug, c.color as category_color
          FROM posts p
          LEFT JOIN categories c ON p.category_id = c.id
          WHERE p.status = 'published' AND (p.title LIKE ? OR p.excerpt LIKE ? OR p.content LIKE ?)
          ORDER BY p.published_at DESC
          LIMIT 50
        `,
        args: [`%${q}%`, `%${q}%`, `%${q}%`]
      });
      posts = result.rows;
    }

    res.render('search', { title: q ? `Search: ${q}` : 'Search', query: q, posts });
  } catch (err) { next(err); }
});

// ========== ABOUT ==========
router.get('/about', async (req, res, next) => {
  try {
    const [projectsResult, certificatesResult] = await Promise.all([
      db.execute(`
        SELECT id, title, short_description, content, cover_image, tech_stack,
               github_url, demo_url, status, created_at
        FROM projects
        ORDER BY created_at DESC, id DESC
      `),
      db.execute(`
        SELECT id, title, issuer, obtained_date, image, description,
               verification_url, category
        FROM certificates
        ORDER BY obtained_date DESC, id DESC
      `)
    ]);

    res.render('about', {
      title:        'About',
      projects:     projectsResult.rows,
      certificates: certificatesResult.rows
    });
  } catch (err) { next(err); }
});

module.exports = router;