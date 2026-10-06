require('dotenv').config();
const { createClient } = require('@libsql/client');
const bcrypt = require('bcrypt');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDatabase() {
  // Users
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Categories
  await db.execute(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      color TEXT DEFAULT '#6b7280',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Posts
  await db.execute(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      excerpt TEXT,
      content TEXT,
      cover_image TEXT,
      category_id INTEGER,
      author TEXT DEFAULT 'Admin',
      published_at DATETIME,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS post_views (
      post_id INTEGER NOT NULL,
      visitor_id TEXT NOT NULL,
      viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (post_id, visitor_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS post_visit_fingerprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      visitor_id TEXT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      page_path TEXT,
      visitor_ip TEXT,
      ip_hash TEXT,
      user_agent TEXT,
      browser TEXT,
      platform TEXT,
      language TEXT,
      timezone TEXT,
      screen_resolution TEXT,
      viewport TEXT,
      color_depth TEXT,
      device_memory TEXT,
      cpu_cores INTEGER,
      referrer TEXT,
      visited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, visitor_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_post_visit_fingerprints_post_visitor
      ON post_visit_fingerprints(post_id, visitor_id)
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL,
      visitor_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (post_id, visitor_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS post_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      author TEXT NOT NULL CHECK(length(author) BETWEEN 1 AND 60),
      body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 3000),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_post_comments_post_created
      ON post_comments(post_id, created_at DESC)
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      issuer TEXT,
      obtained_date DATE,
      image TEXT,
      description TEXT,
      verification_url TEXT,
      category TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      short_description TEXT,
      content TEXT,
      cover_image TEXT,
      tech_stack TEXT,
      github_url TEXT,
      demo_url TEXT,
      status TEXT DEFAULT 'completed' CHECK(status IN ('completed', 'in-progress')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Seed admin
  const userCount = await db.execute('SELECT COUNT(*) as count FROM users');
  if (userCount.rows[0].count === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'change-me-immediately', 10);
    await db.execute({
      sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      args: [process.env.ADMIN_USERNAME || 'admin', hash],
    });
    console.log('Default admin created from .env');
  }

  // Seed categories
  const catCount = await db.execute('SELECT COUNT(*) as count FROM categories');
  if (catCount.rows[0].count === 0) {
    const cats = [
      { name: 'Certifications', slug: 'certifications', color: '#ec4899' },
      { name: 'Mobile Pentesting', slug: 'mobile-pentesting', color: '#22c55e' },
      { name: 'Linux', slug: 'linux', color: '#f59e0b' },
      { name: 'Wi-Fi Pentesting', slug: 'wi-fi-pentesting', color: '#3b82f6' },
      { name: 'Windows', slug: 'windows', color: '#06b6d4' },
      { name: 'Active Directory', slug: 'active-directory', color: '#ef4444' },
      { name: 'Web Pentesting', slug: 'web-pentesting', color: '#14b8a6' },
      { name: 'Miscellaneous', slug: 'miscellaneous', color: '#6b7280' },
      { name: 'CTFs', slug: 'ctfs', color: '#4ee0bc' },
    ];
    for (const c of cats) {
      await db.execute({
        sql: 'INSERT INTO categories (name, slug, color) VALUES (?, ?, ?)',
        args: [c.name, c.slug, c.color],
      });
    }
    console.log('Default categories seeded');
  }

  // Seed settings
  const settings = [
    ['site_name', 'sahermØhamed'],
    ['site_tagline', 'Cybersecurity & Ethical Hacking Blog'],
    ['linkedin_url', 'https://www.linkedin.com/in/sahermhmed/'],
    ['github_url', 'https://github.com/saherm0hamed'],
    ['about_content', 'Welcome to my personal cybersecurity blog.'],
  ];
  for (const [k, v] of settings) {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
      args: [k, v],
    });
  }

  console.log('Database initialized');
}

module.exports = { db, initDatabase };