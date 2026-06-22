/**
 * CellarTrek — Production Server
 * ─────────────────────────────────────────────────────────────────
 * No AWS. Local disk storage for label photos. PostgreSQL for data.
 *
 * Requires:  npm install pg bcrypt jsonwebtoken
 *
 * Environment variables (set in .env or process environment):
 *   ANTHROPIC_API_KEY   — Anthropic API key
 *   DATABASE_URL        — PostgreSQL connection string
 *   JWT_SECRET          — Random 256-bit string for signing tokens
 *   PAYPAL_CLIENT_ID    — PayPal app client ID
 *   PAYPAL_SECRET       — PayPal app secret
 *   PORT                — Server port (default 8081)
 *   NODE_ENV            — "production" | "development"
 */

'use strict';
require('dotenv').config();  // Load .env variables into process.env

console.log("The database connection string is:", process.env.DATABASE_URL);
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const zlib    = require('zlib');

// ── npm dependencies ─────────────────────────────────────────────
const { Pool }       = require('pg');
const bcrypt         = require('bcrypt');
const jwt            = require('jsonwebtoken');

// ── Configuration ────────────────────────────────────────────────
const PORT      = process.env.PORT      || 8081;
const HTML_FILE = 'cellartrek_v12.html';
const JWT_SECRET     = process.env.JWT_SECRET     || 'dev-secret-change-in-production';
const API_KEY        = process.env.ANTHROPIC_API_KEY;
const PAYPAL_BASE    = process.env.NODE_ENV === 'production'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const MIME = {
  '.html': 'text/html',   '.js':   'application/javascript',
  '.css':  'text/css',    '.json': 'application/json',
  '.png':  'image/png',   '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ════════════════════════════════════════════════════════════════
// DATABASE — PostgreSQL connection pool
// ════════════════════════════════════════════════════════════════

/**
 * pg.Pool maintains a pool of persistent connections.
 * Default pool size is 10 — fine for a single EC2/VPS instance.
 * All queries go through db.query() which borrows a connection,
 * runs the query, and returns it to the pool automatically.
 *
 * DATABASE_URL format:
 *   postgresql://USER:PASSWORD@HOST:PORT/DBNAME
 *   postgresql://wj_app:wine123@localhost:5432/cellartrek
 *   postgresql://wj_app:wine123@your-rds-endpoint.amazonaws.com:5432/cellartrek
 */
const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://user_app:PASS@localhost:5432/cellartrek',
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: true }  // Enforce SSL certificate in production
    : false,                        // No SSL for local development
  max: 10,                          // Maximum pool connections
  idleTimeoutMillis: 30000,         // Close idle connections after 30s
  connectionTimeoutMillis: 5000,    // Throw error if no connection in 5s
});

// Test connection on startup
db.connect((err, client, release) => {
  if (err) {
    console.error('❌  Database connection failed:', err.message);
    console.error('    Check DATABASE_URL and that PostgreSQL is running.');
  } else {
    release();
    console.log('✅  PostgreSQL connected');
  }
});

// Handle pool errors (don't crash on idle connection drop)
db.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

// ════════════════════════════════════════════════════════════════
// BLOB STORAGE — Local disk
// ════════════════════════════════════════════════════════════════

/**
 * Wine label photos uploaded by users are stored on local disk.
 * Each photo is stored at:   uploads/labels/{userId}/{wineId}.jpg
 * The path is saved in the wines.label_img database column.
 *
 * Works the same way on LYSITHEA, IONOS, or any Linux server —
 * no cloud dependency at all.
 */

// AWS removed — local disk storage only (IONOS / on-prem / LYSITHEA)
const USE_LOCAL_STORAGE = true;

// Create local uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads', 'labels');
fs.mkdirSync(uploadDir, { recursive: true });
const venueUploadDir = path.join(__dirname, 'uploads', 'venues');
fs.mkdirSync(venueUploadDir, { recursive: true });
console.log('✅  Local blob storage: ./uploads/labels/');

/**
 * Upload a label photo (base64 JPEG from the app)
 * Returns the public URL or local path
 */
async function uploadLabelPhoto(userId, wineId, base64Data) {
  // Strip data URI prefix if present
  const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(b64, 'base64');
  const filename = `labels/${userId}/${wineId}.jpg`;

  // Local disk storage only — no AWS
  const dir = path.join(__dirname, 'uploads', path.dirname(filename));
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(__dirname, 'uploads', filename);
  fs.writeFileSync(filepath, buffer);
  return `/uploads/${filename}`;  // Served by static file handler
}

/**
 * Delete a label photo when a wine is deleted
 */
async function deleteLabelPhoto(labelUrl) {
  if (!labelUrl) return;
  try {
    const filepath = path.join(__dirname, labelUrl.replace(/^\//, ''));
    fs.unlinkSync(filepath);
  } catch(e) {
    console.error('Error deleting label photo:', e.message);
    // Non-fatal — don't throw
  }
}

// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════

// Parse JSON request body
function parseBody(req, cb) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try { cb(null, JSON.parse(body)); }
    catch(e) { cb(new Error('Invalid JSON'), null); }
  });
}

// Send JSON response
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Send error response
function err(res, status, message) {
  json(res, status, { error: message });
}

// Authenticate JWT from Authorization header
function authenticate(req) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch(e) {
    return null;
  }
}

// White-label client ID from subdomain
function getClientId(req) {
  const host  = (req.headers.host || '').split(':')[0];
  const parts = host.split('.');
  return parts.length >= 3 ? parts[0] : 'default';
}

// Serve a static JSON file (used for venue files that haven't been migrated to DB yet)
function serveJsonFile(filePath, res) {
  fs.readFile(filePath, (e, data) => {
    if (e) return err(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(data);
  });
}

// ════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ════════════════════════════════════════════════════════════════

// ── POST /api/auth/signup ────────────────────────────────────────
async function handleSignup(req, res) {
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { email, password, name, lang } = body;
    if (!email || !password) return err(res, 400, 'Email and password required');
    if (password.length < 8)  return err(res, 400, 'Password must be at least 8 characters');

    try {
      // Check if email already exists
      const existing = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
      if (existing.rows.length) return err(res, 409, 'Email already registered');

      // Hash password (bcrypt, 12 rounds)
      const hash = await bcrypt.hash(password, 12);

      // Insert user with sensible profile/theme defaults
      const result = await db.query(
        `INSERT INTO users (email, password_hash, name, lang, avatar_emoji, theme_mode, profile_public)
         VALUES ($1, $2, $3, $4, '🍷', 'dark', true)
         RETURNING id, email, name, lang, plan, created_at,
                   avatar_emoji, avatar_img, bio, city, favorite_wines, favorite_spots,
                   theme_mode, theme_accent, profile_public`,
        [email.toLowerCase(), hash, name || null, lang || 'en']
      );
      const user = result.rows[0];

      // Sign JWT (30-day expiry)
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
      json(res, 201, { token, user });
    } catch(e) {
      console.error('Signup error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ── POST /api/auth/login ────────────────────────────────────────
async function handleLogin(req, res) {
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { email, password } = body;
    if (!email || !password) return err(res, 400, 'Email and password required');

    try {
      const result = await db.query(
        'SELECT * FROM users WHERE email=$1',
        [email.toLowerCase()]
      );
      const user = result.rows[0];
      if (!user) return err(res, 401, 'Invalid credentials');

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return err(res, 401, 'Invalid credentials');

      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
      json(res, 200, {
        token,
        user: {
          id: user.id, email: user.email, name: user.name, lang: user.lang, plan: user.plan,
          avatar_emoji: user.avatar_emoji, avatar_img: user.avatar_img, bio: user.bio,
          city: user.city, favorite_wines: user.favorite_wines, favorite_spots: user.favorite_spots,
          theme_mode: user.theme_mode, theme_accent: user.theme_accent, profile_public: user.profile_public,
        }
      });
    } catch(e) {
      console.error('Login error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ── POST /api/auth/forgot-password ───────────────────────────────
// Generates a reset token. No real email service is wired up yet —
// the resetUrl is returned directly in the response so the frontend
// can display it for testing. Replace this with an actual email send
// (SendGrid, Postmark, etc.) before going to production.
async function handleForgotPassword(req, res) {
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { email } = body;
    if (!email) return err(res, 400, 'Email is required');

    try {
      const result = await db.query('SELECT id, email FROM users WHERE email=$1', [email.toLowerCase()]);
      const user = result.rows[0];

      // Always return success even if the email doesn't exist —
      // prevents leaking which emails are registered.
      if (!user) {
        json(res, 200, { ok: true, message: 'If that email exists, a reset link has been generated.' });
        return;
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db.query(
        `INSERT INTO password_reset_tokens (account_type, account_id, token, expires_at)
         VALUES ('user', $1, $2, $3)`,
        [user.id, token, expiresAt]
      );

      const resetUrl = `${req.headers.origin || ''}/reset-password.html?token=${token}&type=user`;
      console.log(`[password reset] user ${user.email} → ${resetUrl}`);

      json(res, 200, {
        ok: true,
        message: 'Reset link generated.',
        // TEMPORARY: returned directly since no email service is configured.
        // Remove resetUrl from the response once real email sending is wired up.
        resetUrl,
      });
    } catch(e) {
      console.error('ForgotPassword error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ── POST /api/auth/reset-password ────────────────────────────────
async function handleResetPassword(req, res) {
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { token, newPassword } = body;
    if (!token || !newPassword) return err(res, 400, 'Token and new password are required');
    if (newPassword.length < 8) return err(res, 400, 'Password must be at least 8 characters');

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT * FROM password_reset_tokens
         WHERE token=$1 AND account_type='user' AND used_at IS NULL AND expires_at > NOW()`,
        [token]
      );
      const resetRow = result.rows[0];
      if (!resetRow) {
        await client.query('ROLLBACK');
        return err(res, 400, 'This reset link is invalid or has expired.');
      }

      const hash = await bcrypt.hash(newPassword, 12);
      await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, resetRow.account_id]);
      await client.query('UPDATE password_reset_tokens SET used_at=NOW() WHERE id=$1', [resetRow.id]);

      await client.query('COMMIT');
      json(res, 200, { ok: true, message: 'Password updated. You can now sign in.' });
    } catch(e) {
      await client.query('ROLLBACK');
      console.error('ResetPassword error:', e.message);
      err(res, 500, 'Server error');
    } finally {
      client.release();
    }
  });
}

// ── GET /api/user/profile ────────────────────────────────────────
async function handleProfile(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  try {
    const result = await db.query(
      `SELECT id, email, name, lang, plan, plan_expires_at, created_at,
              avatar_emoji, avatar_img, bio, city, favorite_wines, favorite_spots,
              theme_mode, theme_accent, profile_public
       FROM users WHERE id=$1`,
      [session.userId]
    );
    if (!result.rows.length) return err(res, 404, 'User not found');
    json(res, 200, result.rows[0]);
  } catch(e) {
    err(res, 500, 'Server error');
  }
}

// ── PUT /api/user/profile ────────────────────────────────────────
async function handleUpdateProfile(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const {
      name, bio, city, favoriteWines, favoriteSpots,
      avatarEmoji, avatarImg, themeMode, themeAccent, profilePublic,
    } = body;

    try {
      const result = await db.query(
        `UPDATE users SET
           name=$1, bio=$2, city=$3, favorite_wines=$4, favorite_spots=$5,
           avatar_emoji=$6, avatar_img=$7, theme_mode=$8, theme_accent=$9,
           profile_public=$10
         WHERE id=$11
         RETURNING id, email, name, lang, plan, avatar_emoji, avatar_img,
                   bio, city, favorite_wines, favorite_spots, theme_mode,
                   theme_accent, profile_public`,
        [
          name||null, bio||null, city||null,
          favoriteWines||[], favoriteSpots||[],
          avatarEmoji||null, avatarImg||null,
          themeMode||'dark', themeAccent||null,
          profilePublic!==false,
          session.userId
        ]
      );
      json(res, 200, result.rows[0]);
    } catch(e) {
      console.error('UpdateProfile error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ── GET /api/users/:id/public ────────────────────────────────────
// Public profile view — no auth required, but respects profile_public flag.
// Never exposes email, password_hash, or any other sensitive field.
async function handlePublicProfile(req, res, userId) {
  try {
    const result = await db.query(
      `SELECT id, name, city, bio, avatar_emoji, avatar_img,
              favorite_wines, favorite_spots, profile_public, created_at
       FROM users WHERE id=$1`,
      [userId]
    );
    if (!result.rows.length) return err(res, 404, 'User not found');
    const user = result.rows[0];
    if (!user.profile_public) return err(res, 403, 'This profile is private');

    // Pull a few public stats — total wines, total venues joined
    const wineCount = await db.query('SELECT COUNT(*) FROM wines WHERE user_id=$1', [userId]);
    const venueCount = await db.query('SELECT COUNT(*) FROM venue_members WHERE user_id=$1', [userId]);

    json(res, 200, {
      ...user,
      wineCount: parseInt(wineCount.rows[0].count),
      venueCount: parseInt(venueCount.rows[0].count),
    });
  } catch(e) {
    console.error('PublicProfile error:', e.message);
    err(res, 500, 'Server error');
  }
}

// ════════════════════════════════════════════════════════════════
// SOCIAL LAYER
// ════════════════════════════════════════════════════════════════

// ── GET /api/social/friends ───────────────────────────────────────
async function handleGetFriends(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    const result = await db.query(
      `SELECT f.id, f.status, f.created_at,
              CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END AS friend_id,
              u.name, u.avatar_emoji, u.city, u.bio, u.profile_public,
              CASE WHEN f.requester_id=$1 THEN 'sent' ELSE 'received' END AS direction
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END
       WHERE (f.requester_id=$1 OR f.addressee_id=$1) AND f.status != 'blocked'
       ORDER BY f.updated_at DESC`,
      [session.userId]
    );
    json(res, 200, result.rows);
  } catch(e) { console.error('GetFriends:', e.message); err(res, 500, 'Server error'); }
}

// ── POST /api/social/friends/request ─────────────────────────────
async function handleFriendRequest(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { addresseeId } = body;
    if (!addresseeId) return err(res, 400, 'addresseeId required');
    if (addresseeId === session.userId) return err(res, 400, 'Cannot friend yourself');
    try {
      await db.query(
        `INSERT INTO friendships (requester_id, addressee_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (requester_id, addressee_id) DO NOTHING`,
        [session.userId, addresseeId]
      );
      json(res, 200, { ok: true });
    } catch(e) { console.error('FriendRequest:', e.message); err(res, 500, 'Server error'); }
  });
}

// ── PUT /api/social/friends/:id ───────────────────────────────────
async function handleFriendAction(req, res, friendshipId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { action } = body; // 'accept' | 'decline' | 'remove'
    try {
      if (action === 'accept') {
        await db.query(
          `UPDATE friendships SET status='accepted', updated_at=NOW()
           WHERE id=$1 AND addressee_id=$2 AND status='pending'`,
          [friendshipId, session.userId]
        );
      } else {
        await db.query(
          `DELETE FROM friendships WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2)`,
          [friendshipId, session.userId]
        );
      }
      json(res, 200, { ok: true });
    } catch(e) { console.error('FriendAction:', e.message); err(res, 500, 'Server error'); }
  });
}

// ── GET /api/social/groups ────────────────────────────────────────
async function handleGetGroups(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    const result = await db.query(
      `SELECT g.*, 
              COUNT(DISTINCT gm.user_id) AS member_count,
              MAX(CASE WHEN gm.user_id=$1 THEN gm.role END) AS my_role
       FROM wine_groups g
       LEFT JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id=$1 OR g.created_by=$1
       GROUP BY g.id
       ORDER BY g.created_at DESC`,
      [session.userId]
    );
    json(res, 200, result.rows);
  } catch(e) { console.error('GetGroups:', e.message); err(res, 500, 'Server error'); }
}

// ── POST /api/social/groups ───────────────────────────────────────
async function handleCreateGroup(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { name, description, type, venueId, avatarEmoji, isPrivate } = body;
    if (!name) return err(res, 400, 'Group name required');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const g = await client.query(
        `INSERT INTO wine_groups (name, description, type, venue_id, created_by, avatar_emoji, is_private)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [name, description||null, type||'free', venueId||null, session.userId, avatarEmoji||'🍷', isPrivate||false]
      );
      // Creator automatically becomes admin member
      await client.query(
        `INSERT INTO group_members (group_id, user_id, role) VALUES ($1,$2,'admin')`,
        [g.rows[0].id, session.userId]
      );
      await client.query('COMMIT');
      json(res, 200, g.rows[0]);
    } catch(e) {
      await client.query('ROLLBACK');
      console.error('CreateGroup:', e.message); err(res, 500, 'Server error');
    } finally { client.release(); }
  });
}

// ── GET /api/social/groups/:id/members ───────────────────────────
async function handleGetGroupMembers(req, res, groupId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    const result = await db.query(
      `SELECT gm.user_id, gm.role, gm.joined_at, u.name, u.avatar_emoji, u.city
       FROM group_members gm JOIN users u ON u.id=gm.user_id
       WHERE gm.group_id=$1 ORDER BY gm.role DESC, gm.joined_at ASC`,
      [groupId]
    );
    json(res, 200, result.rows);
  } catch(e) { console.error('GetGroupMembers:', e.message); err(res, 500, 'Server error'); }
}

// ── POST /api/social/groups/:id/join ─────────────────────────────
async function handleJoinGroup(req, res, groupId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    await db.query(
      `INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [groupId, session.userId]
    );
    json(res, 200, { ok: true });
  } catch(e) { console.error('JoinGroup:', e.message); err(res, 500, 'Server error'); }
}

// ── GET /api/social/groups/:id/events ────────────────────────────
async function handleGetGroupEvents(req, res, groupId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    const result = await db.query(
      `SELECT ge.*,
              u.name AS creator_name,
              COUNT(DISTINCT ei.id) AS invite_count,
              COUNT(DISTINCT CASE WHEN ei.rsvp='yes' THEN ei.id END) AS yes_count,
              MAX(CASE WHEN ei.user_id=$2 THEN ei.rsvp END) AS my_rsvp,
              MAX(CASE WHEN ei.user_id=$2 THEN ei.checked_in::text END) AS my_checkin
       FROM group_events ge
       JOIN users u ON u.id=ge.created_by
       LEFT JOIN event_invitations ei ON ei.event_id=ge.id
       WHERE ge.group_id=$1
       GROUP BY ge.id, u.name
       ORDER BY ge.event_date ASC NULLS LAST, ge.created_at DESC`,
      [groupId, session.userId]
    );
    json(res, 200, result.rows);
  } catch(e) { console.error('GetGroupEvents:', e.message); err(res, 500, 'Server error'); }
}

// ── GET /api/social/events/:id/guests ────────────────────────────
// Returns full guest list for print production (name cards etc.)
async function handleGetEventGuests(req, res, eventId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    const result = await db.query(
      `SELECT ei.id, ei.rsvp, ei.checked_in,
              COALESCE(u.name, ei.guest_name) AS name,
              COALESCE(u.email, ei.guest_email) AS email,
              u.avatar_emoji,
              CASE WHEN ei.user_id IS NOT NULL THEN 'member' ELSE 'guest' END AS type
       FROM event_invitations ei
       LEFT JOIN users u ON u.id = ei.user_id
       WHERE ei.event_id = $1
       ORDER BY ei.rsvp ASC, name ASC`,
      [eventId]
    );
    json(res, 200, result.rows);
  } catch(e) { console.error('GetEventGuests:', e.message); err(res, 500, 'Server error'); }
}


// ── POST /api/social/groups/:id/events ───────────────────────────
async function handleCreateEvent(req, res, groupId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { title, description, eventDate, venueName, venueAddress, pairingMenu,
            invitationText, invitationDesign } = body;
    if (!title) return err(res, 400, 'Event title required');
    try {
      const token = crypto.randomBytes(24).toString('hex');
      const result = await db.query(
        `INSERT INTO group_events 
         (group_id, created_by, title, description, event_date, venue_name, venue_address,
          pairing_menu, invitation_text, invitation_design, shareable_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [groupId, session.userId, title, description||null,
         eventDate||null, venueName||null, venueAddress||null,
         pairingMenu ? JSON.stringify(pairingMenu) : null,
         invitationText||null, invitationDesign||null, token]
      );
      json(res, 200, result.rows[0]);
    } catch(e) { console.error('CreateEvent:', e.message); err(res, 500, 'Server error'); }
  });
}

// ── PUT /api/social/events/:id ────────────────────────────────────
async function handleUpdateEvent(req, res, eventId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { title, description, eventDate, venueName, venueAddress,
            pairingMenu, invitationText, invitationDesign } = body;
    if (!title) return err(res, 400, 'Event title required');
    try {
      const result = await db.query(
        `UPDATE group_events SET
           title=$1, description=$2, event_date=$3, venue_name=$4, venue_address=$5,
           pairing_menu=$6, invitation_text=$7, invitation_design=$8
         WHERE id=$9 AND created_by=$10 RETURNING *`,
        [title, description||null, eventDate||null, venueName||null, venueAddress||null,
         pairingMenu ? JSON.stringify(pairingMenu) : null,
         invitationText||null, invitationDesign||null,
         eventId, session.userId]
      );
      if (!result.rows.length) return err(res, 403, 'Not found or not your event');
      json(res, 200, result.rows[0]);
    } catch(e) { console.error('UpdateEvent:', e.message); err(res, 500, 'Server error'); }
  });
}

// ── DELETE /api/social/events/:id ────────────────────────────────
async function handleDeleteEvent(req, res, eventId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    const result = await db.query(
      `DELETE FROM group_events WHERE id=$1 AND created_by=$2 RETURNING id`,
      [eventId, session.userId]
    );
    if (!result.rows.length) return err(res, 403, 'Not found or not your event');
    json(res, 200, { ok: true });
  } catch(e) { console.error('DeleteEvent:', e.message); err(res, 500, 'Server error'); }
}


async function handleEventRSVP(req, res, eventId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { rsvp } = body; // yes | no | maybe
    try {
      await db.query(
        `INSERT INTO event_invitations (event_id, user_id, rsvp, rsvp_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (event_id, user_id) DO UPDATE SET rsvp=$3, rsvp_at=NOW()`,
        [eventId, session.userId, rsvp]
      );
      json(res, 200, { ok: true });
    } catch(e) { console.error('EventRSVP:', e.message); err(res, 500, 'Server error'); }
  });
}

// ── POST /api/social/events/:id/checkin ──────────────────────────
async function handleEventCheckin(req, res, eventId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    await db.query(
      `INSERT INTO event_invitations (event_id, user_id, rsvp, checked_in, checked_in_at)
       VALUES ($1,$2,'yes',true,NOW())
       ON CONFLICT (event_id, user_id) DO UPDATE SET checked_in=true, checked_in_at=NOW()`,
      [eventId, session.userId]
    );
    json(res, 200, { ok: true });
  } catch(e) { console.error('EventCheckin:', e.message); err(res, 500, 'Server error'); }
}

// ── GET /api/social/events/:token/public ─────────────────────────
// Public RSVP link — no auth required
async function handlePublicEvent(req, res, token) {
  try {
    const result = await db.query(
      `SELECT ge.id, ge.title, ge.description, ge.event_date, ge.venue_name,
              ge.venue_address, ge.invitation_text, ge.invitation_design,
              ge.pairing_menu, u.name AS host_name, u.avatar_emoji AS host_avatar,
              COUNT(DISTINCT CASE WHEN ei.rsvp='yes' THEN ei.id END) AS yes_count
       FROM group_events ge
       JOIN users u ON u.id=ge.created_by
       LEFT JOIN event_invitations ei ON ei.event_id=ge.id
       WHERE ge.shareable_token=$1
       GROUP BY ge.id, u.name, u.avatar_emoji`,
      [token]
    );
    if (!result.rows.length) return err(res, 404, 'Event not found');
    json(res, 200, result.rows[0]);
  } catch(e) { console.error('PublicEvent:', e.message); err(res, 500, 'Server error'); }
}

// ── POST /api/social/events/public/:token/rsvp ───────────────────
// Guest RSVP — no auth required
async function handlePublicEventRsvp(req, res, token) {
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { rsvp, guestName, guestEmail } = body;
    if (!rsvp || !['yes','no','maybe'].includes(rsvp)) return err(res, 400, 'Invalid rsvp value');
    if (!guestName) return err(res, 400, 'guestName required');
    try {
      const evRes = await db.query(
        `SELECT id FROM group_events WHERE shareable_token=$1`, [token]
      );
      if (!evRes.rows.length) return err(res, 404, 'Event not found');
      const eventId = evRes.rows[0].id;
      await db.query(
        `INSERT INTO event_invitations (event_id, user_id, guest_name, guest_email, rsvp, rsvp_at)
         VALUES ($1, NULL, $2, $3, $4, NOW())
         ON CONFLICT (event_id, user_id) DO NOTHING`,
        [eventId, guestName, guestEmail||null, rsvp]
      );
      json(res, 200, { ok: true });
    } catch(e) { console.error('PublicEventRsvp:', e.message); err(res, 500, 'Server error'); }
  });
}

// ── GET /api/social/groups/:id/trips ─────────────────────────────
async function handleGetTrips(req, res, groupId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    const result = await db.query(
      `SELECT gt.*, u.name AS creator_name,
              COUNT(DISTINCT tm.user_id) AS member_count,
              MAX(CASE WHEN tm.user_id=$2 THEN tm.rsvp END) AS my_rsvp
       FROM group_trips gt
       JOIN users u ON u.id=gt.created_by
       LEFT JOIN trip_members tm ON tm.trip_id=gt.id
       WHERE gt.group_id=$1
       GROUP BY gt.id, u.name
       ORDER BY gt.start_date ASC NULLS LAST, gt.created_at DESC`,
      [groupId, session.userId]
    );
    json(res, 200, result.rows);
  } catch(e) { console.error('GetTrips:', e.message); err(res, 500, 'Server error'); }
}

// ── POST /api/social/groups/:id/trips ────────────────────────────
async function handleCreateTrip(req, res, groupId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { title, regions, startDate, endDate, notes } = body;
    if (!title) return err(res, 400, 'Trip title required');
    try {
      const result = await db.query(
        `INSERT INTO group_trips (group_id, created_by, title, regions, start_date, end_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [groupId, session.userId, title, regions||[], startDate||null, endDate||null, notes||null]
      );
      // Auto-add creator as going
      await db.query(
        `INSERT INTO trip_members (trip_id, user_id, rsvp) VALUES ($1,$2,'yes') ON CONFLICT DO NOTHING`,
        [result.rows[0].id, session.userId]
      );
      json(res, 200, result.rows[0]);
    } catch(e) { console.error('CreateTrip:', e.message); err(res, 500, 'Server error'); }
  });
}

// ── PUT /api/social/trips/:id/rsvp ───────────────────────────────
async function handleTripRSVP(req, res, tripId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { rsvp } = body;
    try {
      await db.query(
        `INSERT INTO trip_members (trip_id, user_id, rsvp)
         VALUES ($1,$2,$3)
         ON CONFLICT (trip_id, user_id) DO UPDATE SET rsvp=$3`,
        [tripId, session.userId, rsvp]
      );
      json(res, 200, { ok: true });
    } catch(e) { console.error('TripRSVP:', e.message); err(res, 500, 'Server error'); }
  });
}

// ════════════════════════════════════════════════════════════════
// SHOP / MARKETPLACE
// ════════════════════════════════════════════════════════════════

// ── GET /api/shop/items ───────────────────────────────────────────
// Public browse — no auth required. Supports ?category=wine&featured=true
async function handleGetShopItems(req, res) {
  try {
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const category = params.get('category');
    const featured  = params.get('featured');
    const sellerId  = params.get('seller');

    let where = [`i.is_active = true`];
    const vals = [];
    if (category) { vals.push(category); where.push(`i.category = $${vals.length}`); }
    if (featured === 'true') where.push(`i.is_featured = true`);
    if (sellerId) { vals.push(sellerId); where.push(`i.seller_id = $${vals.length}`); }
    where.push(`(i.promotion_ends IS NULL OR i.promotion_ends > NOW())`);

    const result = await db.query(
      `SELECT i.*, s.business_name AS seller_name, s.logo_url AS seller_logo,
              s.contact_email AS seller_email, s.seller_type, s.venue_id AS seller_venue_id
       FROM shop_items i
       JOIN shop_sellers s ON s.id = i.seller_id AND s.status = 'active'
       WHERE ${where.join(' AND ')}
       ORDER BY i.is_featured DESC, i.sort_order ASC, i.created_at DESC`,
      vals
    );
    json(res, 200, result.rows);
  } catch(e) { console.error('GetShopItems:', e.message); err(res, 500, 'Server error'); }
}

// ── GET /api/shop/sellers ─────────────────────────────────────────
async function handleGetShopSellers(req, res) {
  try {
    const result = await db.query(
      `SELECT s.id, s.business_name, s.description, s.logo_url, s.website_url,
              s.seller_type, s.venue_id,
              COUNT(DISTINCT i.id) AS item_count
       FROM shop_sellers s
       LEFT JOIN shop_items i ON i.seller_id = s.id AND i.is_active = true
       WHERE s.status = 'active'
       GROUP BY s.id
       ORDER BY s.created_at ASC`,
    );
    json(res, 200, result.rows);
  } catch(e) { console.error('GetShopSellers:', e.message); err(res, 500, 'Server error'); }
}

// ── POST /api/shop/orders ─────────────────────────────────────────
async function handlePlaceOrder(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { itemId, qty, userName, userEmail, userPhone, deliveryNotes } = body;
    if (!itemId) return err(res, 400, 'itemId required');

    try {
      // Fetch item + seller
      const itemRes = await db.query(
        `SELECT i.*, s.id AS seller_id, s.commission_pct, s.contact_email AS seller_email, s.business_name AS seller_name
         FROM shop_items i JOIN shop_sellers s ON s.id = i.seller_id
         WHERE i.id = $1 AND i.is_active = true AND s.status = 'active'`,
        [itemId]
      );
      if (!itemRes.rows.length) return err(res, 404, 'Item not found or unavailable');
      const item = itemRes.rows[0];

      const quantity = parseInt(qty) || 1;
      const total = (item.price || 0) * quantity;
      const commission = total * (item.commission_pct || 10) / 100;

      const order = await db.query(
        `INSERT INTO shop_orders
         (item_id, seller_id, user_id, qty, unit_price, currency, total_price,
          user_name, user_email, user_phone, delivery_notes, commission_due)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [itemId, item.seller_id, session.userId, quantity,
         item.price||0, item.currency||'USD', total,
         userName||null, userEmail||null, userPhone||null,
         deliveryNotes||null, commission]
      );

      // Log order routed (in production this would email the seller)
      console.log(`[shop order] #${order.rows[0].id} — ${item.title} x${quantity} → ${item.seller_email}`);

      json(res, 200, { ok: true, orderId: order.rows[0].id, sellerName: item.seller_name });
    } catch(e) { console.error('PlaceOrder:', e.message); err(res, 500, 'Server error'); }
  });
}

// ── GET /api/shop/orders/mine ─────────────────────────────────────
async function handleGetMyOrders(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    const result = await db.query(
      `SELECT o.*, i.title AS item_title, i.category, i.image_url,
              s.business_name AS seller_name
       FROM shop_orders o
       JOIN shop_items i ON i.id = o.item_id
       JOIN shop_sellers s ON s.id = o.seller_id
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC`,
      [session.userId]
    );
    json(res, 200, result.rows);
  } catch(e) { console.error('GetMyOrders:', e.message); err(res, 500, 'Server error'); }
}

// ── Venue admin: manage their own shop items ──────────────────────

// GET /api/venue-admin/shop/items
// ════════════════════════════════════════════════════════════════
// VENUE BRANDING & SELF-SERVE SIGNUP
// ════════════════════════════════════════════════════════════════

// ── POST /api/venue/signup ────────────────────────────────────────
// Public self-serve venue registration — no auth required
async function handleVenueSignup(req, res) {
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { venueName, venueId, email, password, venueType, city, country, description } = body;
    if (!venueName || !venueId || !email || !password)
      return err(res, 400, 'venueName, venueId, email and password are required');

    // venueId must be lowercase alphanumeric + hyphens only
    const cleanId = venueId.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (cleanId.length < 3) return err(res, 400, 'venueId must be at least 3 characters');

    try {
      const existing = await db.query(
        'SELECT venue_id FROM venue_accounts WHERE venue_id=$1 OR email=$2',
        [cleanId, email.toLowerCase()]
      );
      if (existing.rows.length) return err(res, 409, 'A venue with that ID or email already exists');

      const hash = await bcrypt.hash(password, 12);
      const result = await db.query(
        `INSERT INTO venue_accounts
         (venue_id, venue_name, email, password_hash, venue_type, city, country, description, is_public)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING venue_id, venue_name, email, created_at`,
        [cleanId, venueName, email.toLowerCase(), hash,
         venueType||null, city||null, country||null, description||null]
      );
      const token = jwt.sign({ venueId: cleanId, type: 'venue' }, JWT_SECRET, { expiresIn: '30d' });
      json(res, 200, { token, venue: result.rows[0] });
    } catch(e) {
      console.error('VenueSignup:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ── GET /api/venue-admin/branding ────────────────────────────────
// ── POST /api/venue-admin/upload-image ───────────────────────────
// Accepts base64 image, saves to disk, returns public URL
async function handleVenueImageUpload(req, res) {
  const session = authenticate(req, 'venue');
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { imageData, imageType } = body; // imageType: 'logo' | 'cover'
    if (!imageData) return err(res, 400, 'imageData required');
    try {
      const b64 = imageData.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(b64, 'base64');
      const ext = imageData.includes('image/png') ? 'png' : 'jpg';
      const filename = `venues/${session.venueId}/${imageType||'image'}.${ext}`;
      const dir = path.join(__dirname, 'uploads', 'venues', session.venueId);
      fs.mkdirSync(dir, { recursive: true });
      const filepath = path.join(__dirname, 'uploads', filename);
      fs.writeFileSync(filepath, buffer);
      const url = `/uploads/${filename}`;
      json(res, 200, { url });
    } catch(e) {
      console.error('VenueImageUpload:', e.message);
      err(res, 500, 'Upload failed');
    }
  });
}

async function handleGetVenueBranding(req, res) {
  const session = authenticate(req, 'venue');
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    const result = await db.query(
      `SELECT venue_id, venue_name, email, logo_url, cover_url, brand_color,
              description, address, city, country, phone, website,
              instagram, facebook, opening_hours, venue_type, is_public, created_at
       FROM venue_accounts WHERE venue_id=$1`,
      [session.venueId]
    );
    if (!result.rows.length) return err(res, 404, 'Venue not found');
    json(res, 200, result.rows[0]);
  } catch(e) { console.error('GetVenueBranding:', e.message); err(res, 500, 'Server error'); }
}

// ── PUT /api/venue-admin/branding ────────────────────────────────
async function handleUpdateVenueBranding(req, res) {
  const session = authenticate(req, 'venue');
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { venueName, logoUrl, coverUrl, brandColor, description,
            address, city, country, phone, website, instagram,
            facebook, openingHours, venueType, isPublic } = body;
    try {
      const result = await db.query(
        `UPDATE venue_accounts SET
           venue_name=$1, logo_url=$2, cover_url=$3, brand_color=$4, description=$5,
           address=$6, city=$7, country=$8, phone=$9, website=$10,
           instagram=$11, facebook=$12, opening_hours=$13, venue_type=$14, is_public=$15
         WHERE venue_id=$16
         RETURNING venue_id, venue_name, logo_url, cover_url, brand_color, description,
                   address, city, country, phone, website, instagram, facebook,
                   opening_hours, venue_type, is_public`,
        [venueName||null, logoUrl||null, coverUrl||null, brandColor||null, description||null,
         address||null, city||null, country||null, phone||null, website||null,
         instagram||null, facebook||null, openingHours||null, venueType||null,
         isPublic!==false, session.venueId]
      );
      json(res, 200, result.rows[0]);
    } catch(e) { console.error('UpdateVenueBranding:', e.message); err(res, 500, 'Server error'); }
  });
}

// ── GET /api/venues/:id/public ────────────────────────────────────
// Public venue profile — no auth, respects is_public flag
async function handlePublicVenueProfile(req, res, venueId) {
  try {
    const result = await db.query(
      `SELECT va.venue_id, va.venue_name, va.logo_url, va.cover_url, va.brand_color,
              va.description, va.address, va.city, va.country, va.phone,
              va.website, va.instagram, va.facebook, va.opening_hours, va.venue_type,
              va.is_public, va.created_at,
              COUNT(DISTINCT vm.user_id) AS member_count,
              COUNT(DISTINCT si.id)      AS shop_item_count
       FROM venue_accounts va
       LEFT JOIN venue_members vm ON vm.venue_id = va.venue_id
       LEFT JOIN shop_sellers ss ON ss.venue_id = va.venue_id AND ss.status='active'
       LEFT JOIN shop_items si ON si.seller_id = ss.id AND si.is_active=true
       WHERE va.venue_id=$1
       GROUP BY va.venue_id`,
      [venueId]
    );
    if (!result.rows.length) return err(res, 404, 'Venue not found');
    const v = result.rows[0];
    if (!v.is_public) return err(res, 403, 'This venue profile is private');
    json(res, 200, v);
  } catch(e) { console.error('PublicVenueProfile:', e.message); err(res, 500, 'Server error'); }
}

async function handleVenueGetShopItems(req, res) {
  const session = authenticate(req, 'venue');
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    // Find or create seller record for this venue
    const sellerRes = await db.query(
      `SELECT * FROM shop_sellers WHERE venue_id = $1`, [session.venueId]
    );
    if (!sellerRes.rows.length) { json(res, 200, { seller: null, items: [] }); return; }
    const seller = sellerRes.rows[0];
    const items = await db.query(
      `SELECT * FROM shop_items WHERE seller_id = $1 ORDER BY sort_order ASC, created_at DESC`,
      [seller.id]
    );
    json(res, 200, { seller, items: items.rows });
  } catch(e) { console.error('VenueGetShopItems:', e.message); err(res, 500, 'Server error'); }
}

// POST /api/venue-admin/shop/setup  — create seller profile for venue
async function handleVenueShopSetup(req, res) {
  const session = authenticate(req, 'venue');
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    try {
      const va = await db.query(`SELECT * FROM venue_accounts WHERE venue_id=$1`, [session.venueId]);
      if (!va.rows.length) return err(res, 404, 'Venue not found');
      const v = va.rows[0];
      const result = await db.query(
        `INSERT INTO shop_sellers (seller_type, venue_id, business_name, contact_email, description, status)
         VALUES ('venue', $1, $2, $3, $4, 'active')
         ON CONFLICT (venue_id) DO UPDATE SET
           business_name = EXCLUDED.business_name,
           description   = EXCLUDED.description
         RETURNING *`,
        [session.venueId, body.businessName||v.venue_name, v.email, body.description||null]
      );
      json(res, 200, result.rows[0]);
    } catch(e) { console.error('VenueShopSetup:', e.message); err(res, 500, 'Server error'); }
  });
}

// POST /api/venue-admin/shop/items
async function handleVenueCreateShopItem(req, res) {
  const session = authenticate(req, 'venue');
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { category, title, description, price, currency, priceLabel,
            imageUrl, stockQty, promotionEnds, externalUrl, tags, isFeatured } = body;
    if (!title || !category) return err(res, 400, 'title and category required');
    try {
      const sellerRes = await db.query(`SELECT id FROM shop_sellers WHERE venue_id=$1`, [session.venueId]);
      if (!sellerRes.rows.length) return err(res, 400, 'Set up your shop profile first');
      const result = await db.query(
        `INSERT INTO shop_items
         (seller_id, category, title, description, price, currency, price_label,
          image_url, stock_qty, promotion_ends, external_url, tags, is_featured)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [sellerRes.rows[0].id, category, title, description||null,
         price||null, currency||'USD', priceLabel||null,
         imageUrl||null, stockQty||null, promotionEnds||null,
         externalUrl||null, tags||[], isFeatured||false]
      );
      json(res, 200, result.rows[0]);
    } catch(e) { console.error('VenueCreateShopItem:', e.message); err(res, 500, 'Server error'); }
  });
}

// PUT /api/venue-admin/shop/items/:id
async function handleVenueUpdateShopItem(req, res, itemId) {
  const session = authenticate(req, 'venue');
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    try {
      await db.query(
        `UPDATE shop_items SET
           title=$1, description=$2, price=$3, currency=$4, price_label=$5,
           image_url=$6, stock_qty=$7, is_active=$8, is_featured=$9,
           promotion_ends=$10, external_url=$11, tags=$12, updated_at=NOW()
         WHERE id=$13 AND seller_id IN (SELECT id FROM shop_sellers WHERE venue_id=$14)`,
        [body.title, body.description||null, body.price||null, body.currency||'USD',
         body.priceLabel||null, body.imageUrl||null, body.stockQty||null,
         body.isActive!==false, body.isFeatured||false,
         body.promotionEnds||null, body.externalUrl||null, body.tags||[],
         itemId, session.venueId]
      );
      json(res, 200, { ok: true });
    } catch(e) { console.error('VenueUpdateShopItem:', e.message); err(res, 500, 'Server error'); }
  });
}

// DELETE /api/venue-admin/shop/items/:id
async function handleVenueDeleteShopItem(req, res, itemId) {
  const session = authenticate(req, 'venue');
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    await db.query(
      `DELETE FROM shop_items WHERE id=$1 AND seller_id IN (SELECT id FROM shop_sellers WHERE venue_id=$2)`,
      [itemId, session.venueId]
    );
    json(res, 200, { ok: true });
  } catch(e) { console.error('VenueDeleteShopItem:', e.message); err(res, 500, 'Server error'); }
}

// GET /api/venue-admin/shop/orders
async function handleVenueGetOrders(req, res) {
  const session = authenticate(req, 'venue');
  if (!session) return err(res, 401, 'Unauthorized');
  try {
    const result = await db.query(
      `SELECT o.*, i.title AS item_title, i.category
       FROM shop_orders o JOIN shop_items i ON i.id=o.item_id
       WHERE o.seller_id IN (SELECT id FROM shop_sellers WHERE venue_id=$1)
       ORDER BY o.created_at DESC`,
      [session.venueId]
    );
    json(res, 200, result.rows);
  } catch(e) { console.error('VenueGetOrders:', e.message); err(res, 500, 'Server error'); }
}

// PUT /api/venue-admin/shop/orders/:id
async function handleVenueUpdateOrder(req, res, orderId) {
  const session = authenticate(req, 'venue');
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    try {
      await db.query(
        `UPDATE shop_orders SET status=$1, seller_notes=$2, updated_at=NOW()
         WHERE id=$3 AND seller_id IN (SELECT id FROM shop_sellers WHERE venue_id=$4)`,
        [body.status, body.sellerNotes||null, orderId, session.venueId]
      );
      json(res, 200, { ok: true });
    } catch(e) { console.error('VenueUpdateOrder:', e.message); err(res, 500, 'Server error'); }
  });
}

// ── DELETE /api/user ─────────────────────────────────────────────
async function handleDeleteUser(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  try {
    // Cascade deletes wines, inventory, memberships, requests, reviews
    await db.query('DELETE FROM users WHERE id=$1', [session.userId]);
    json(res, 200, { ok: true, message: 'Account deleted' });
  } catch(e) {
    err(res, 500, 'Server error');
  }
}

// ── GET /api/wines ───────────────────────────────────────────────
async function handleGetWines(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  try {
    const wines = await db.query(
      `SELECT w.*, 
        COALESCE(
          json_agg(json_build_object('ml', i.ml, 'qty', i.qty)) 
          FILTER (WHERE i.id IS NOT NULL), 
          '[]'
        ) AS inventory
       FROM wines w
       LEFT JOIN wine_inventory i ON i.wine_id = w.id
       WHERE w.user_id = $1
       GROUP BY w.id
       ORDER BY w.created_at DESC`,
      [session.userId]
    );
    json(res, 200, wines.rows);
  } catch(e) {
    console.error('GetWines error:', e.message);
    err(res, 500, 'Server error');
  }
}

// ── POST /api/wines ───────────────────────────────────────────────
async function handleCreateWine(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const {
      name, vintage, region, grapes, mode, rating, notes, story,
      aromas, flavors, body: wineBody, finish, occasion,
      bc, lc, tradeable, ai_enriched, articles,
      labelImg,     // base64 JPEG from label scan
      inventory,    // [{ml, qty}]
      venueId, source,
      purchaseType, pricePaid, priceMl, priceCurrency,
    } = body;

    if (!name) return err(res, 400, 'Wine name required');

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Upload label photo if provided
      let label_img = null;
      if (labelImg && labelImg.startsWith('data:image')) {
        const wineIdTemp = crypto.randomUUID();
        label_img = await uploadLabelPhoto(session.userId, wineIdTemp, labelImg);
      }

      // Insert wine
      const wineResult = await client.query(
        `INSERT INTO wines (
          user_id, name, vintage, region, grapes, mode, rating, notes,
          story, aromas, flavors, body, finish, occasion, bc, lc,
          tradeable, ai_enriched, articles, label_img, venue_id, source,
          purchase_type, price_paid, price_ml, price_currency
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        RETURNING id`,
        [
          session.userId, name, vintage||null, region||null,
          grapes||[], mode||'cellar', rating||null, notes||null,
          story||null, aromas||[], flavors||[], wineBody||null, finish||null,
          occasion||null, bc||null, lc||null,
          tradeable||false, ai_enriched||false,
          articles ? JSON.stringify(articles) : null,
          label_img, venueId||null, source||null,
          purchaseType||null, pricePaid||null, priceMl||null, priceCurrency||'USD'
        ]
      );
      const wineId = wineResult.rows[0].id;

      // Insert inventory lines
      const invLines = inventory && inventory.length ? inventory : [{ ml: 750, qty: 1 }];
      for (const line of invLines) {
        await client.query(
          'INSERT INTO wine_inventory (wine_id, ml, qty) VALUES ($1, $2, $3)',
          [wineId, line.ml, line.qty]
        );
      }

      await client.query('COMMIT');
      json(res, 201, { id: wineId, ok: true });
    } catch(e) {
      await client.query('ROLLBACK');
      console.error('CreateWine error:', e.message);
      err(res, 500, 'Server error');
    } finally {
      client.release();
    }
  });
}

// ── PUT /api/wines/:id ────────────────────────────────────────────
async function handleUpdateWine(req, res, wineId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');

    // Verify ownership
    const owned = await db.query(
      'SELECT id, label_img FROM wines WHERE id=$1 AND user_id=$2',
      [wineId, session.userId]
    );
    if (!owned.rows.length) return err(res, 404, 'Wine not found');

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Handle label photo update
      let label_img = owned.rows[0].label_img;
      if (body.labelImg && body.labelImg.startsWith('data:image')) {
        // Delete old photo
        if (label_img) await deleteLabelPhoto(label_img);
        label_img = await uploadLabelPhoto(session.userId, wineId, body.labelImg);
      }

      // Update wine record
      await client.query(
        `UPDATE wines SET
          name=$1, vintage=$2, region=$3, grapes=$4, mode=$5, rating=$6,
          notes=$7, story=$8, aromas=$9, flavors=$10, body=$11, finish=$12,
          occasion=$13, bc=$14, lc=$15, tradeable=$16, ai_enriched=$17,
          articles=$18, label_img=$19, purchase_type=$20, price_paid=$21,
          price_ml=$22, price_currency=$23
         WHERE id=$24 AND user_id=$25`,
        [
          body.name, body.vintage||null, body.region||null,
          body.grapes||[], body.mode||'cellar', body.rating||null,
          body.notes||null, body.story||null, body.aromas||[], body.flavors||[],
          body.body||null, body.finish||null, body.occasion||null,
          body.bc||null, body.lc||null, body.tradeable||false, body.ai_enriched||false,
          body.articles ? JSON.stringify(body.articles) : null,
          label_img,
          body.purchaseType||null, body.pricePaid||null, body.priceMl||null, body.priceCurrency||'USD',
          wineId, session.userId
        ]
      );

      // Replace inventory lines
      if (body.inventory) {
        await client.query('DELETE FROM wine_inventory WHERE wine_id=$1', [wineId]);
        for (const line of body.inventory) {
          await client.query(
            'INSERT INTO wine_inventory (wine_id, ml, qty) VALUES ($1,$2,$3)',
            [wineId, line.ml, line.qty]
          );
        }
      }

      await client.query('COMMIT');
      json(res, 200, { ok: true });
    } catch(e) {
      await client.query('ROLLBACK');
      console.error('UpdateWine error:', e.message);
      err(res, 500, 'Server error');
    } finally {
      client.release();
    }
  });
}

// ── POST /api/wines/:id/open-bottle ──────────────────────────────
// Decrement qty for a given format. If qty reaches 0, either remove
// that format line or move the whole wine to consumed (if last bottle).
// Creates a consumed copy of the wine when the last bottle is opened.
async function handleOpenBottle(req, res, wineId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { ml, addToConsumed } = body;
    const bottleMl = parseInt(ml) || 750;
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Get current inventory line
      const invRes = await client.query(
        `SELECT * FROM wine_inventory WHERE wine_id=$1 AND ml=$2`,
        [wineId, bottleMl]
      );
      if (!invRes.rows.length) {
        await client.query('ROLLBACK');
        return err(res, 404, 'Bottle format not found');
      }

      const line = invRes.rows[0];
      const newQty = (line.qty || 1) - 1;

      if (newQty <= 0) {
        // Remove this format line
        await client.query(
          `DELETE FROM wine_inventory WHERE wine_id=$1 AND ml=$2`,
          [wineId, bottleMl]
        );
        // Check if any inventory lines remain
        const remaining = await client.query(
          `SELECT COUNT(*) FROM wine_inventory WHERE wine_id=$1`, [wineId]
        );
        if (parseInt(remaining.rows[0].count) === 0) {
          // Last bottle — move wine to consumed
          await client.query(
            `UPDATE wines SET mode='consumed' WHERE id=$1 AND user_id=$2`,
            [wineId, session.userId]
          );
          // Re-add a single consumed inventory line
          await client.query(
            `INSERT INTO wine_inventory (wine_id, ml, qty) VALUES ($1,$2,1)`,
            [wineId, bottleMl]
          );
          await client.query('COMMIT');
          return json(res, 200, { action: 'moved_to_consumed', wineId });
        }
      } else {
        // Decrement qty
        await client.query(
          `UPDATE wine_inventory SET qty=$1 WHERE wine_id=$2 AND ml=$3`,
          [newQty, wineId, bottleMl]
        );
      }

      // Optionally create a consumed copy
      if (addToConsumed && newQty > 0) {
        const wineRes = await client.query(
          `SELECT * FROM wines WHERE id=$1 AND user_id=$2`, [wineId, session.userId]
        );
        if (wineRes.rows.length) {
          const w = wineRes.rows[0];
          const copyRes = await client.query(
            `INSERT INTO wines (user_id, name, vintage, region, grapes, mode, rating, notes,
              story, aromas, flavors, body, finish, occasion, bc, lc, tradeable,
              purchase_type, price_paid, price_ml, price_currency)
             VALUES ($1,$2,$3,$4,$5,'consumed',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
             RETURNING id`,
            [session.userId, w.name, w.vintage, w.region, w.grapes, w.rating, w.notes,
             w.story, w.aromas, w.flavors, w.body, w.finish, w.occasion,
             w.bc, w.lc, false, w.purchase_type, w.price_paid, bottleMl, w.price_currency]
          );
          await client.query(
            `INSERT INTO wine_inventory (wine_id, ml, qty) VALUES ($1,$2,1)`,
            [copyRes.rows[0].id, bottleMl]
          );
        }
      }

      await client.query('COMMIT');
      json(res, 200, { action: 'decremented', wineId, newQty: Math.max(0, newQty) });
    } catch(e) {
      await client.query('ROLLBACK');
      console.error('OpenBottle:', e.message);
      err(res, 500, 'Server error');
    } finally { client.release(); }
  });
}

// ── PATCH /api/wines/:id/qty ──────────────────────────────────────
// Quick qty update for a specific bottle format
async function handleUpdateQty(req, res, wineId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { ml, qty } = body;
    const bottleMl = parseInt(ml) || 750;
    const newQty = Math.max(0, parseInt(qty) || 0);
    try {
      if (newQty === 0) {
        await db.query(`DELETE FROM wine_inventory WHERE wine_id=$1 AND ml=$2 AND EXISTS (SELECT 1 FROM wines WHERE id=$1 AND user_id=$3)`,
          [wineId, bottleMl, session.userId]);
      } else {
        await db.query(
          `INSERT INTO wine_inventory (wine_id, ml, qty) VALUES ($1,$2,$3)
           ON CONFLICT (wine_id, ml) DO UPDATE SET qty=$3
           WHERE EXISTS (SELECT 1 FROM wines WHERE id=$1 AND user_id=$4)`,
          [wineId, bottleMl, newQty, session.userId]
        );
      }
      json(res, 200, { ok: true, newQty });
    } catch(e) { console.error('UpdateQty:', e.message); err(res, 500, 'Server error'); }
  });
}

// ── DELETE /api/wines/:id ─────────────────────────────────────────
async function handleDeleteWine(req, res, wineId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  try {
    // Verify ownership and get label_img for cleanup
    const owned = await db.query(
      'SELECT id, label_img FROM wines WHERE id=$1 AND user_id=$2',
      [wineId, session.userId]
    );
    if (!owned.rows.length) return err(res, 404, 'Wine not found');

    // Delete label photo from storage
    if (owned.rows[0].label_img) {
      await deleteLabelPhoto(owned.rows[0].label_img);
    }

    // Cascade deletes wine_inventory via FK
    await db.query('DELETE FROM wines WHERE id=$1 AND user_id=$2', [wineId, session.userId]);
    json(res, 200, { ok: true });
  } catch(e) {
    console.error('DeleteWine error:', e.message);
    err(res, 500, 'Server error');
  }
}

// ── POST /api/upload/label ────────────────────────────────────────
// Upload a label photo independently (before wine is saved)
async function handleLabelUpload(req, res) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { image, wineId } = body;
    if (!image) return err(res, 400, 'No image provided');

    try {
      const tempId = wineId || crypto.randomUUID();
      const url = await uploadLabelPhoto(session.userId, tempId, image);
      json(res, 200, { url, wineId: tempId });
    } catch(e) {
      console.error('Label upload error:', e.message);
      err(res, 500, 'Upload failed');
    }
  });
}

// ── POST /api/paypal/webhook ─────────────────────────────────────
async function handlePayPalWebhook(req, res) {
  parseBody(req, async (e, event) => {
    if (e) return err(res, 400, 'Invalid webhook');

    try {
      if (event.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
        const { id: subId, custom_id: userId } = event.resource;
        // Determine plan from PayPal plan ID
        const planId = event.resource.plan_id;
        const plan = planId === process.env.PAYPAL_EXCLUSIVE_PLAN_ID ? 'exclusive' : 'premium';
        const amount = plan === 'exclusive' ? 10.00 : 4.25;

        const client = await db.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `UPDATE users SET plan=$1, plan_expires_at=NOW()+INTERVAL '1 month',
             paypal_subscription_id=$2 WHERE id=$3`,
            [plan, subId, userId]
          );
          await client.query(
            `INSERT INTO subscriptions (user_id, paypal_subscription_id, plan, status, amount_usd, started_at)
             VALUES ($1,$2,$3,'active',$4,NOW())`,
            [userId, subId, plan, amount]
          );
          await client.query(
            `INSERT INTO payment_events (user_id, event_type, amount_usd, paypal_event_id)
             VALUES ($1,'subscription.activated',$2,$3)`,
            [userId, amount, event.id]
          );
          await client.query('COMMIT');
        } catch(e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      }

      if (event.event_type === 'BILLING.SUBSCRIPTION.CANCELLED') {
        const subId = event.resource.id;
        await db.query(
          "UPDATE users SET plan='free', plan_expires_at=NULL WHERE paypal_subscription_id=$1",
          [subId]
        );
        await db.query(
          "UPDATE subscriptions SET status='cancelled' WHERE paypal_subscription_id=$1",
          [subId]
        );
      }

      if (event.event_type === 'PAYMENT.SALE.COMPLETED') {
        // Monthly recurring payment — record for QuickBooks sync
        const subId = event.resource.billing_agreement_id;
        const result = await db.query(
          'SELECT user_id, plan, amount_usd FROM subscriptions WHERE paypal_subscription_id=$1',
          [subId]
        );
        if (result.rows.length) {
          const sub = result.rows[0];
          await db.query(
            `INSERT INTO payment_events (user_id, subscription_id, event_type, amount_usd, paypal_event_id)
             SELECT id, $1, 'payment.completed', $2, $3 FROM subscriptions WHERE paypal_subscription_id=$4`,
            [sub.id, sub.amount_usd, event.id, subId]
          );
          // Extend plan by 1 month
          await db.query(
            "UPDATE users SET plan_expires_at=GREATEST(plan_expires_at,NOW())+INTERVAL '1 month' WHERE paypal_subscription_id=$1",
            [subId]
          );
        }
      }

      res.writeHead(200);
      res.end('OK');
    } catch(e) {
      console.error('PayPal webhook error:', e.message);
      res.writeHead(500);
      res.end('Error');
    }
  });
}

// ── Venue API (DB-backed) ────────────────────────────────────────

// GET /api/venue/:id
async function handleGetVenue(req, res, venueId) {
  // Still reads from flat JSON files — migrate to DB in a future phase
  serveJsonFile(path.join(__dirname, 'clients', venueId, 'venue.json'), res);
}

// GET /api/venue/:id/feed
async function handleGetFeed(req, res, venueId) {
  serveJsonFile(path.join(__dirname, 'clients', venueId, 'feed.json'), res);
}

// POST /api/venue/:id/request
async function handleVenueRequest(req, res, venueId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    try {
      const result = await db.query(
        `INSERT INTO bottle_requests (user_id, venue_id, wine_name, producer, vintage, notes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [session.userId, venueId, body.wineName, body.producer||null, body.vintage||null, body.notes||null]
      );
      json(res, 201, { id: result.rows[0].id, ok: true });
    } catch(e) {
      console.error('VenueRequest error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// POST /api/venue/:id/review
async function handleVenueReview(req, res, venueId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    try {
      const result = await db.query(
        `INSERT INTO member_reviews (user_id, venue_id, wine_name, rating, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [session.userId, venueId, body.wineName, body.rating||90, body.notes||null]
      );
      json(res, 201, { id: result.rows[0].id, ok: true });
    } catch(e) {
      console.error('VenueReview error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// POST /api/venue/:id/member/join
async function handleVenueJoin(req, res, venueId) {
  const session = authenticate(req);
  if (!session) return err(res, 401, 'Unauthorized');

  try {
    await db.query(
      `INSERT INTO venue_members (user_id, venue_id)
       VALUES ($1,$2)
       ON CONFLICT (user_id, venue_id) DO NOTHING`,
      [session.userId, venueId]
    );
    json(res, 200, { ok: true });
  } catch(e) {
    console.error('VenueJoin error:', e.message);
    err(res, 500, 'Server error');
  }
}

// ════════════════════════════════════════════════════════════════
// VENUE ADMIN — authentication, members, feed, requests, reviews
// ════════════════════════════════════════════════════════════════

// Authenticate a venue admin session (separate JWT scope from user sessions)
function authenticateVenue(req) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'venue') return null;  // Reject user tokens here
    return decoded;
  } catch(e) {
    return null;
  }
}

// ── POST /api/venue-admin/login ──────────────────────────────────
async function handleVenueAdminLogin(req, res) {
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { email, password } = body;
    if (!email || !password) return err(res, 400, 'Email and password required');

    try {
      const result = await db.query(
        'SELECT * FROM venue_accounts WHERE email=$1',
        [email.toLowerCase()]
      );
      const account = result.rows[0];
      if (!account) return err(res, 401, 'Invalid credentials');

      const valid = await bcrypt.compare(password, account.password_hash);
      if (!valid) return err(res, 401, 'Invalid credentials');

      const token = jwt.sign(
        { type: 'venue', venueId: account.venue_id, accountId: account.id },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      json(res, 200, {
        token,
        venue: { id: account.venue_id, name: account.venue_name, email: account.email }
      });
    } catch(e) {
      console.error('VenueAdminLogin error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ── POST /api/venue-admin/forgot-password ────────────────────────
async function handleVenueForgotPassword(req, res) {
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { email } = body;
    if (!email) return err(res, 400, 'Email is required');

    try {
      const result = await db.query('SELECT id, email, venue_name FROM venue_accounts WHERE email=$1', [email.toLowerCase()]);
      const account = result.rows[0];

      if (!account) {
        json(res, 200, { ok: true, message: 'If that email exists, a reset link has been generated.' });
        return;
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db.query(
        `INSERT INTO password_reset_tokens (account_type, account_id, token, expires_at)
         VALUES ('venue', $1, $2, $3)`,
        [account.id, token, expiresAt]
      );

      const resetUrl = `${req.headers.origin || ''}/reset-password.html?token=${token}&type=venue`;
      console.log(`[password reset] venue ${account.venue_name} (${account.email}) → ${resetUrl}`);

      json(res, 200, {
        ok: true,
        message: 'Reset link generated.',
        // TEMPORARY: returned directly since no email service is configured.
        resetUrl,
      });
    } catch(e) {
      console.error('VenueForgotPassword error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ── POST /api/venue-admin/reset-password ─────────────────────────
async function handleVenueResetPassword(req, res) {
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { token, newPassword } = body;
    if (!token || !newPassword) return err(res, 400, 'Token and new password are required');
    if (newPassword.length < 8) return err(res, 400, 'Password must be at least 8 characters');

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT * FROM password_reset_tokens
         WHERE token=$1 AND account_type='venue' AND used_at IS NULL AND expires_at > NOW()`,
        [token]
      );
      const resetRow = result.rows[0];
      if (!resetRow) {
        await client.query('ROLLBACK');
        return err(res, 400, 'This reset link is invalid or has expired.');
      }

      const hash = await bcrypt.hash(newPassword, 12);
      await client.query('UPDATE venue_accounts SET password_hash=$1 WHERE id=$2', [hash, resetRow.account_id]);
      await client.query('UPDATE password_reset_tokens SET used_at=NOW() WHERE id=$1', [resetRow.id]);

      await client.query('COMMIT');
      json(res, 200, { ok: true, message: 'Password updated. You can now sign in.' });
    } catch(e) {
      await client.query('ROLLBACK');
      console.error('VenueResetPassword error:', e.message);
      err(res, 500, 'Server error');
    } finally {
      client.release();
    }
  });
}

// ── POST /api/venue-admin/signup ─────────────────────────────────
// Creates a new venue account. In production this would be gated by ChikPea staff,
// not self-serve — but useful for onboarding new white-label clients during setup.
async function handleVenueAdminSignup(req, res) {
  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { venueId, venueName, email, password } = body;
    if (!venueId || !venueName || !email || !password) {
      return err(res, 400, 'venueId, venueName, email, and password are all required');
    }
    if (password.length < 8) return err(res, 400, 'Password must be at least 8 characters');

    try {
      const existing = await db.query(
        'SELECT id FROM venue_accounts WHERE email=$1 OR venue_id=$2',
        [email.toLowerCase(), venueId]
      );
      if (existing.rows.length) return err(res, 409, 'Venue ID or email already registered');

      const hash = await bcrypt.hash(password, 12);
      const result = await db.query(
        `INSERT INTO venue_accounts (venue_id, venue_name, email, password_hash)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [venueId, venueName, email.toLowerCase(), hash]
      );

      const token = jwt.sign(
        { type: 'venue', venueId, accountId: result.rows[0].id },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      json(res, 201, { token, venue: { id: venueId, name: venueName, email } });
    } catch(e) {
      console.error('VenueAdminSignup error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ── GET /api/venue-admin/members ─────────────────────────────────
async function handleVenueAdminMembers(req, res) {
  const session = authenticateVenue(req);
  if (!session) return err(res, 401, 'Unauthorized');

  try {
    const result = await db.query(
      `SELECT vm.id, vm.user_id, vm.joined_at, vm.is_select_reviewer, vm.status,
              u.name, u.email,
              COUNT(DISTINCT mr.id)  AS review_count,
              COUNT(DISTINCT br.id)  AS request_count
       FROM venue_members vm
       JOIN users u           ON u.id = vm.user_id
       LEFT JOIN member_reviews mr ON mr.user_id = vm.user_id AND mr.venue_id = vm.venue_id
       LEFT JOIN bottle_requests br ON br.user_id = vm.user_id AND br.venue_id = vm.venue_id
       WHERE vm.venue_id = $1
       GROUP BY vm.id, u.name, u.email
       ORDER BY vm.joined_at DESC`,
      [session.venueId]
    );
    json(res, 200, result.rows);
  } catch(e) {
    console.error('VenueAdminMembers error:', e.message);
    err(res, 500, 'Server error');
  }
}

// ── PATCH /api/venue-admin/members/:userId ───────────────────────
// Promote or demote a member's Select Reviewer status
async function handleVenueAdminUpdateMember(req, res, userId) {
  const session = authenticateVenue(req);
  if (!session) return err(res, 401, 'Unauthorized');

  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    try {
      const result = await db.query(
        `UPDATE venue_members
         SET is_select_reviewer = $1
         WHERE user_id = $2 AND venue_id = $3
         RETURNING id`,
        [!!body.isSelectReviewer, userId, session.venueId]
      );
      if (!result.rows.length) return err(res, 404, 'Member not found');
      json(res, 200, { ok: true });
    } catch(e) {
      console.error('VenueAdminUpdateMember error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ── GET /api/venue-admin/feed ─────────────────────────────────────
async function handleVenueAdminGetFeed(req, res) {
  const session = authenticateVenue(req);
  if (!session) return err(res, 401, 'Unauthorized');

  try {
    const result = await db.query(
      `SELECT * FROM venue_feed WHERE venue_id=$1 ORDER BY published_at DESC`,
      [session.venueId]
    );
    json(res, 200, result.rows);
  } catch(e) {
    err(res, 500, 'Server error');
  }
}

// ── POST /api/venue-admin/feed ─────────────────────────────────────
async function handleVenueAdminCreateFeed(req, res) {
  const session = authenticateVenue(req);
  if (!session) return err(res, 401, 'Unauthorized');

  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { type, title, bodyText, ctaLabel, ctaUrl, wineRef, expiresAt } = body;
    if (!type || !title) return err(res, 400, 'type and title are required');

    try {
      const result = await db.query(
        `INSERT INTO venue_feed (venue_id, type, title, body, cta_label, cta_url, wine_ref, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, published_at`,
        [session.venueId, type, title, bodyText||null, ctaLabel||null, ctaUrl||null, wineRef||null, expiresAt||null]
      );
      json(res, 201, result.rows[0]);
    } catch(e) {
      console.error('VenueAdminCreateFeed error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ── DELETE /api/venue-admin/feed/:id ────────────────────────────────
async function handleVenueAdminDeleteFeed(req, res, feedId) {
  const session = authenticateVenue(req);
  if (!session) return err(res, 401, 'Unauthorized');

  try {
    await db.query(
      'DELETE FROM venue_feed WHERE id=$1 AND venue_id=$2',
      [feedId, session.venueId]
    );
    json(res, 200, { ok: true });
  } catch(e) {
    err(res, 500, 'Server error');
  }
}

// ── GET /api/venue-admin/requests ───────────────────────────────────
async function handleVenueAdminGetRequests(req, res) {
  const session = authenticateVenue(req);
  if (!session) return err(res, 401, 'Unauthorized');

  try {
    const result = await db.query(
      `SELECT br.*, u.name AS user_name, u.email AS user_email
       FROM bottle_requests br
       JOIN users u ON u.id = br.user_id
       WHERE br.venue_id = $1
       ORDER BY br.created_at DESC`,
      [session.venueId]
    );
    json(res, 200, result.rows);
  } catch(e) {
    err(res, 500, 'Server error');
  }
}

// ── PATCH /api/venue-admin/requests/:id ──────────────────────────────
// Acknowledge, mark added, or decline a bottle request, with optional reply
async function handleVenueAdminUpdateRequest(req, res, requestId) {
  const session = authenticateVenue(req);
  if (!session) return err(res, 401, 'Unauthorized');

  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    const { status, venueReply } = body;
    const validStatuses = ['pending', 'acknowledged', 'added', 'declined'];
    if (!validStatuses.includes(status)) return err(res, 400, 'Invalid status');

    try {
      const result = await db.query(
        `UPDATE bottle_requests
         SET status=$1, venue_reply=$2
         WHERE id=$3 AND venue_id=$4
         RETURNING id`,
        [status, venueReply||null, requestId, session.venueId]
      );
      if (!result.rows.length) return err(res, 404, 'Request not found');
      json(res, 200, { ok: true });
    } catch(e) {
      console.error('VenueAdminUpdateRequest error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ── GET /api/venue-admin/reviews ─────────────────────────────────────
async function handleVenueAdminGetReviews(req, res) {
  const session = authenticateVenue(req);
  if (!session) return err(res, 401, 'Unauthorized');

  try {
    const result = await db.query(
      `SELECT mr.*, u.name AS user_name, u.email AS user_email
       FROM member_reviews mr
       JOIN users u ON u.id = mr.user_id
       WHERE mr.venue_id = $1
       ORDER BY mr.created_at DESC`,
      [session.venueId]
    );
    json(res, 200, result.rows);
  } catch(e) {
    err(res, 500, 'Server error');
  }
}

// ── PATCH /api/venue-admin/reviews/:id ───────────────────────────────
// Approve (publish) or reject a member review
async function handleVenueAdminUpdateReview(req, res, reviewId) {
  const session = authenticateVenue(req);
  if (!session) return err(res, 401, 'Unauthorized');

  parseBody(req, async (e, body) => {
    if (e) return err(res, 400, 'Invalid request');
    try {
      const result = await db.query(
        `UPDATE member_reviews
         SET is_published=$1, published_at=CASE WHEN $1 THEN NOW() ELSE NULL END
         WHERE id=$2 AND venue_id=$3
         RETURNING id`,
        [!!body.isPublished, reviewId, session.venueId]
      );
      if (!result.rows.length) return err(res, 404, 'Review not found');
      json(res, 200, { ok: true });
    } catch(e) {
      console.error('VenueAdminUpdateReview error:', e.message);
      err(res, 500, 'Server error');
    }
  });
}

// ════════════════════════════════════════════════════════════════
// MAIN SERVER
// ════════════════════════════════════════════════════════════════

const requestHandler = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url    = req.url.split('?')[0];
  const method = req.method;

  // ── Anthropic proxy ────────────────────────────────────────────
  if (url === '/api/anthropic' && method === 'POST') {
    parseBody(req, (e, body) => {
      if (e) return err(res, 400, 'Invalid request');
      if (!API_KEY) return err(res, 500, 'ANTHROPIC_API_KEY not set');
      const bodyStr = JSON.stringify(body);
      const options = {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(bodyStr),
        }
      };
      const proxy = https.request(options, apiRes => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
          if (apiRes.statusCode !== 200) {
            console.error(`Anthropic API error: ${apiRes.statusCode} ${body}`);
          }
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(body);
        });
      });
      proxy.on('error', e => {
        console.error('Anthropic proxy connection error:', e.message, e.code);
        err(res, 502, e.message || 'Proxy connection failed');
      });
      proxy.write(bodyStr); proxy.end();
    });
    return;
  }

  // ── Auth routes ────────────────────────────────────────────────
  if (url === '/api/auth/signup'  && method === 'POST') return handleSignup(req, res);
  if (url === '/api/auth/login'   && method === 'POST') return handleLogin(req, res);
  if (url === '/api/auth/forgot-password' && method === 'POST') return handleForgotPassword(req, res);
  if (url === '/api/auth/reset-password'  && method === 'POST') return handleResetPassword(req, res);
  if (url === '/api/user/profile' && method === 'GET')  return handleProfile(req, res);
  if (url === '/api/user/profile' && method === 'PUT')  return handleUpdateProfile(req, res);

  // ── Social layer routes ──────────────────────────────────────────
  if (url === '/api/social/friends' && method === 'GET')  return handleGetFriends(req, res);
  if (url === '/api/social/friends/request' && method === 'POST') return handleFriendRequest(req, res);

  const friendMatch = url.match(/^\/api\/social\/friends\/([^/]+)$/);
  if (friendMatch && method === 'PUT')   return handleFriendAction(req, res, friendMatch[1]);
  if (friendMatch && method === 'DELETE') return handleFriendAction(req, res, friendMatch[1]);

  if (url === '/api/social/groups' && method === 'GET')  return handleGetGroups(req, res);
  if (url === '/api/social/groups' && method === 'POST') return handleCreateGroup(req, res);

  const groupMatch = url.match(/^\/api\/social\/groups\/([^/]+)$/);
  if (groupMatch) {
    if (method === 'GET') return handleGetGroups(req, res);
  }

  const groupMembersMatch = url.match(/^\/api\/social\/groups\/([^/]+)\/members$/);
  if (groupMembersMatch && method === 'GET')  return handleGetGroupMembers(req, res, groupMembersMatch[1]);

  const groupJoinMatch = url.match(/^\/api\/social\/groups\/([^/]+)\/join$/);
  if (groupJoinMatch && method === 'POST') return handleJoinGroup(req, res, groupJoinMatch[1]);

  const groupEventsMatch = url.match(/^\/api\/social\/groups\/([^/]+)\/events$/);
  if (groupEventsMatch && method === 'GET')  return handleGetGroupEvents(req, res, groupEventsMatch[1]);
  if (groupEventsMatch && method === 'POST') return handleCreateEvent(req, res, groupEventsMatch[1]);

  const eventRSVPMatch = url.match(/^\/api\/social\/events\/([^/]+)\/rsvp$/);
  if (eventRSVPMatch && method === 'PUT') return handleEventRSVP(req, res, eventRSVPMatch[1]);

  const eventCheckinMatch = url.match(/^\/api\/social\/events\/([^/]+)\/checkin$/);
  if (eventCheckinMatch && method === 'POST') return handleEventCheckin(req, res, eventCheckinMatch[1]);

  const eventGuestsMatch = url.match(/^\/api\/social\/events\/([^/]+)\/guests$/);
  if (eventGuestsMatch && method === 'GET') return handleGetEventGuests(req, res, eventGuestsMatch[1]);

  const eventMatch = url.match(/^\/api\/social\/events\/([^/]+)$/);
  if (eventMatch && method === 'PUT')    return handleUpdateEvent(req, res, eventMatch[1]);
  if (eventMatch && method === 'DELETE') return handleDeleteEvent(req, res, eventMatch[1]);

  const publicEventMatch = url.match(/^\/api\/social\/events\/public\/([^/]+)$/);
  if (publicEventMatch && method === 'GET') return handlePublicEvent(req, res, publicEventMatch[1]);

  const publicEventRsvpMatch = url.match(/^\/api\/social\/events\/public\/([^/]+)\/rsvp$/);
  if (publicEventRsvpMatch && method === 'POST') return handlePublicEventRsvp(req, res, publicEventRsvpMatch[1]);

  // Public event RSVP page — /event/:token serves event.html
  if (url.match(/^\/event\/[^/]+$/)) {
    fs.readFile(path.join(__dirname, 'event.html'), (e, data) => {
      if (e) return err(res, 500, 'Event page not found');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  const groupTripsMatch = url.match(/^\/api\/social\/groups\/([^/]+)\/trips$/);
  if (groupTripsMatch && method === 'GET')  return handleGetTrips(req, res, groupTripsMatch[1]);
  if (groupTripsMatch && method === 'POST') return handleCreateTrip(req, res, groupTripsMatch[1]);

  const tripRSVPMatch = url.match(/^\/api\/social\/trips\/([^/]+)\/rsvp$/);
  if (tripRSVPMatch && method === 'PUT') return handleTripRSVP(req, res, tripRSVPMatch[1]);

  // ── Shop / marketplace routes ────────────────────────────────────
  if (url.startsWith('/api/shop/items') && method === 'GET')  return handleGetShopItems(req, res);
  if (url === '/api/shop/sellers' && method === 'GET')         return handleGetShopSellers(req, res);
  if (url === '/api/shop/orders' && method === 'POST')         return handlePlaceOrder(req, res);
  if (url === '/api/shop/orders/mine' && method === 'GET')     return handleGetMyOrders(req, res);

  // Venue admin shop routes
  // Venue branding & public signup
  if (url === '/api/venue/signup' && method === 'POST')           return handleVenueSignup(req, res);
  if (url === '/api/venue-admin/branding' && method === 'GET')    return handleGetVenueBranding(req, res);
  if (url === '/api/venue-admin/branding' && method === 'PUT')    return handleUpdateVenueBranding(req, res);
  if (url === '/api/venue-admin/upload-image' && method === 'POST') return handleVenueImageUpload(req, res);

  const pubVenueMatch = url.match(/^\/api\/venues\/([^/]+)\/public$/);
  if (pubVenueMatch && method === 'GET') return handlePublicVenueProfile(req, res, pubVenueMatch[1]);

  if (url === '/api/venue-admin/shop/items' && method === 'GET')    return handleVenueGetShopItems(req, res);
  if (url === '/api/venue-admin/shop/items' && method === 'POST')   return handleVenueCreateShopItem(req, res);
  if (url === '/api/venue-admin/shop/setup' && method === 'POST')   return handleVenueShopSetup(req, res);
  if (url === '/api/venue-admin/shop/orders' && method === 'GET')   return handleVenueGetOrders(req, res);

  const venueShopItemMatch = url.match(/^\/api\/venue-admin\/shop\/items\/([^/]+)$/);
  if (venueShopItemMatch && method === 'PUT')    return handleVenueUpdateShopItem(req, res, venueShopItemMatch[1]);
  if (venueShopItemMatch && method === 'DELETE') return handleVenueDeleteShopItem(req, res, venueShopItemMatch[1]);

  const venueOrderMatch = url.match(/^\/api\/venue-admin\/shop\/orders\/([^/]+)$/);
  if (venueOrderMatch && method === 'PUT') return handleVenueUpdateOrder(req, res, venueOrderMatch[1]);

  const publicProfileMatch = url.match(/^\/api\/users\/([^/]+)\/public$/);
  if (publicProfileMatch && method === 'GET') return handlePublicProfile(req, res, publicProfileMatch[1]);
  if (url === '/api/user'         && method === 'DELETE') return handleDeleteUser(req, res);

  // ── Wine CRUD ──────────────────────────────────────────────────
  if (url === '/api/wines'        && method === 'GET')    return handleGetWines(req, res);
  if (url === '/api/wines'        && method === 'POST')   return handleCreateWine(req, res);
  const wineMatch = url.match(/^\/api\/wines\/([^/]+)$/);
  if (wineMatch && method === 'PUT')    return handleUpdateWine(req, res, wineMatch[1]);
  if (wineMatch && method === 'DELETE') return handleDeleteWine(req, res, wineMatch[1]);

  const openBottleMatch = url.match(/^\/api\/wines\/([^/]+)\/open-bottle$/);
  if (openBottleMatch && method === 'POST') return handleOpenBottle(req, res, openBottleMatch[1]);

  const updateQtyMatch = url.match(/^\/api\/wines\/([^/]+)\/qty$/);
  if (updateQtyMatch && method === 'PATCH') return handleUpdateQty(req, res, updateQtyMatch[1]);

  // ── Blob storage ───────────────────────────────────────────────
  if (url === '/api/upload/label' && method === 'POST') return handleLabelUpload(req, res);

  // ── PayPal ─────────────────────────────────────────────────────
  if (url === '/api/paypal/webhook' && method === 'POST') return handlePayPalWebhook(req, res);

  // ── White-label config ─────────────────────────────────────────
  if (url === '/config.js') {
    const clientId = getClientId(req);
    const clientCfg = path.join(__dirname, 'clients', clientId, 'config.js');
    const defaultCfg = path.join(__dirname, 'clients', 'default', 'config.js');
    fs.access(clientCfg, fs.constants.F_OK, e => {
      const fp = e ? defaultCfg : clientCfg;
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      fs.createReadStream(fp).pipe(res);
    });
    return;
  }

  // ── Venue API ──────────────────────────────────────────────────
  const venueBase    = url.match(/^\/api\/venue\/([^/]+)$/);
  const venueFeed    = url.match(/^\/api\/venue\/([^/]+)\/feed$/);
  const venueRequest = url.match(/^\/api\/venue\/([^/]+)\/request$/);
  const venueReview  = url.match(/^\/api\/venue\/([^/]+)\/review$/);
  const venueJoin    = url.match(/^\/api\/venue\/([^/]+)\/member\/join$/);

  if (venueBase    && method === 'GET')  return handleGetVenue(req, res, venueBase[1]);
  if (venueFeed    && method === 'GET')  return handleGetFeed(req, res, venueFeed[1]);
  if (venueRequest && method === 'POST') return handleVenueRequest(req, res, venueRequest[1]);
  if (venueReview  && method === 'POST') return handleVenueReview(req, res, venueReview[1]);
  if (venueJoin    && method === 'POST') return handleVenueJoin(req, res, venueJoin[1]);

  // ── Venue Admin routes ──────────────────────────────────────────
  if (url === '/api/venue-admin/login'  && method === 'POST') return handleVenueAdminLogin(req, res);
  if (url === '/api/venue-admin/forgot-password' && method === 'POST') return handleVenueForgotPassword(req, res);
  if (url === '/api/venue-admin/reset-password'  && method === 'POST') return handleVenueResetPassword(req, res);
  if (url === '/api/venue-admin/signup' && method === 'POST') return handleVenueAdminSignup(req, res);
  if (url === '/api/venue-admin/members' && method === 'GET') return handleVenueAdminMembers(req, res);

  const memberMatch = url.match(/^\/api\/venue-admin\/members\/([^/]+)$/);
  if (memberMatch && method === 'PATCH') return handleVenueAdminUpdateMember(req, res, memberMatch[1]);

  if (url === '/api/venue-admin/feed' && method === 'GET')  return handleVenueAdminGetFeed(req, res);
  if (url === '/api/venue-admin/feed' && method === 'POST') return handleVenueAdminCreateFeed(req, res);

  const feedDelMatch = url.match(/^\/api\/venue-admin\/feed\/([^/]+)$/);
  if (feedDelMatch && method === 'DELETE') return handleVenueAdminDeleteFeed(req, res, feedDelMatch[1]);

  if (url === '/api/venue-admin/requests' && method === 'GET') return handleVenueAdminGetRequests(req, res);

  const reqMatch = url.match(/^\/api\/venue-admin\/requests\/([^/]+)$/);
  if (reqMatch && method === 'PATCH') return handleVenueAdminUpdateRequest(req, res, reqMatch[1]);

  if (url === '/api/venue-admin/reviews' && method === 'GET') return handleVenueAdminGetReviews(req, res);

  const reviewMatch = url.match(/^\/api\/venue-admin\/reviews\/([^/]+)$/);
  if (reviewMatch && method === 'PATCH') return handleVenueAdminUpdateReview(req, res, reviewMatch[1]);

  // ── Venue admin panel page ───────────────────────────────────────
  if (url === '/admin') {
    fs.readFile(path.join(__dirname, 'venue-admin.html'), (e, data) => {
      if (e) return err(res, 500, 'Admin panel not found');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }


  // Venue marketing material templates
  const matMatch = url.match(/^\/(venue-material-[\w-]+\.html)$/);
  if (matMatch) {
    fs.readFile(path.join(__dirname, matMatch[1]), (e, data) => {
      if (e) return err(res, 404, 'Template not found');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  if (url === '/print-engine.js') {
    fs.readFile(path.join(__dirname, 'print-engine.js'), (e, data) => {
      if (e) return err(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(data);
    });
    return;
  }


  if (url === '/venues') {
    fs.readFile(path.join(__dirname, 'venue-landing.html'), (e, data) => {
      if (e) return err(res, 500, 'Page not found');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  if (url === '/venue-signup') {
    fs.readFile(path.join(__dirname, 'venue-signup.html'), (e, data) => {
      if (e) return err(res, 500, 'Signup page not found');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // ── QR join deep link ──────────────────────────────────────────
  if (url === '/join') {
    fs.readFile(path.join(__dirname, HTML_FILE), (e, data) => {
      if (e) return err(res, 500, 'Server error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // ── Local uploads (IONOS / development only) ───────────────────
  if (url.startsWith('/uploads/') && USE_LOCAL_STORAGE) {
    const filePath = path.join(__dirname, url);
    fs.readFile(filePath, (e, data) => {
      if (e) return err(res, 404, 'Not found');
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }

  // ── Static files ───────────────────────────────────────────────
  const filePath    = url === '/' ? HTML_FILE : url.slice(1);
  const ext         = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'text/plain';

  fs.readFile(path.join(__dirname, filePath), (e, data) => {
    if (e) { res.writeHead(404); res.end('Not found: ' + filePath); return; }

    const compressible = ['text/html','text/javascript','application/javascript',
                          'text/css','application/json'].includes(contentType);
    const acceptsGzip  = (req.headers['accept-encoding']||'').includes('gzip');

    if (acceptsGzip && compressible) {
      zlib.gzip(data, (e2, compressed) => {
        if (e2) { res.writeHead(200,{'Content-Type':contentType}); res.end(data); return; }
        res.writeHead(200, {
          'Content-Type':     contentType,
          'Content-Encoding': 'gzip',
          'Content-Length':   compressed.length,
          'Vary':             'Accept-Encoding',
        });
        res.end(compressed);
      });
    } else {
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
      res.end(data);
    }
  });
};

// ════════════════════════════════════════════════════════════════
// HTTPS auto-detection
// ════════════════════════════════════════════════════════════════
// Camera access (QR scanner) requires a secure context — HTTPS, or localhost.
// If cert files exist (created via mkcert, see README), serve over HTTPS.
// Otherwise fall back to plain HTTP (fine for desktop testing, but the QR
// scanner will only work over localhost in that case, not a LAN IP).
//
// Generate certs with mkcert:
//   mkcert -install
//   mkcert <your-lan-ip> localhost 127.0.0.1
// Then set these env vars to point at the generated files:
//   SSL_CERT_PATH=./192.168.1.x+2.pem
//   SSL_KEY_PATH=./192.168.1.x+2-key.pem
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const SSL_KEY_PATH  = process.env.SSL_KEY_PATH;
let server, isHttps = false;

if (SSL_CERT_PATH && SSL_KEY_PATH && fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH)) {
  server = https.createServer({
    cert: fs.readFileSync(SSL_CERT_PATH),
    key:  fs.readFileSync(SSL_KEY_PATH),
  }, requestHandler);
  isHttps = true;
} else {
  server = http.createServer(requestHandler);
}

server.listen(PORT, () => {
  const proto = isHttps ? 'https' : 'http';
  console.log(`\n✅  CellarTrek Production Server — ${proto}://localhost:${PORT}`);
  if (!isHttps) {
    console.log('    ⚠️  Running on HTTP — camera access (QR scanner) only works on localhost,');
    console.log('       not a LAN IP. See README for HTTPS setup with mkcert.');
  }
  console.log(`    DB:      ${process.env.DATABASE_URL ? 'PostgreSQL connected' : 'Using local DATABASE_URL'}`);
  console.log('    Storage: Local ./uploads/ (AWS removed)');
  console.log(`    Mode:    ${process.env.NODE_ENV || 'development'}\n`);
});
