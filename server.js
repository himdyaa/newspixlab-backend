/* NewsPixLab Service — Backend (Node.js + Express)
   Flow: signup/login -> plan choose -> Razorpay payment (server par VERIFY)
         -> "Blogger Connect" (Google OAuth, password kabhi nahi manga jata)
         -> owner/service news post karta hai client ke blog par
*/
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { google } = require('googleapis');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

/* ---------- Database ---------- */
const db = new DatabaseSync('newspixlab.db');
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  plan TEXT DEFAULT NULL,
  paid_until TEXT DEFAULT NULL,
  categories TEXT DEFAULT '[]',
  blogger_refresh_token TEXT DEFAULT NULL,
  blog_id TEXT DEFAULT NULL,
  blog_url TEXT DEFAULT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

/* ---------- Plans (price paise me; 4 news/category/roz) ---------- */
const PLANS = {
  starter: { name: 'Starter', price: 49900,  per: 'mahina', categories: 1,  newsPerDay: 4 },
  growth:  { name: 'Growth',  price: 99900,  per: 'mahina', categories: 3,  newsPerDay: 4 },
  pro:     { name: 'Pro',     price: 199900, per: 'mahina', categories: 10, newsPerDay: 4 },
};

/* ---------- Razorpay ---------- */
const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ---------- Google OAuth (Blogger) ---------- */
const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/auth/google/callback`
);
const BLOGGER_SCOPE = 'https://www.googleapis.com/auth/blogger';

app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-badlo',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 3600 * 1000 },
}));

const needLogin = (req, res, next) =>
  req.session.userId ? next() : res.status(401).json({ error: 'login-required' });

/* ================= AUTH ================= */
app.post('/api/signup', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 6)
    return res.status(400).json({ error: 'email aur 6+ akshar ka password do' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare('INSERT INTO users (email, pass_hash) VALUES (?,?)').run(email.toLowerCase(), hash);
    req.session.userId = r.lastInsertRowid;
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'ye email pehle se registered hai' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get((email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.pass_hash))
    return res.status(401).json({ error: 'email ya password galat' });
  req.session.userId = u.id;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/me', needLogin, (req, res) => {
  const u = db.prepare('SELECT id,email,plan,paid_until,categories,blog_id,blog_url FROM users WHERE id=?').get(req.session.userId);
  u.categories = JSON.parse(u.categories || '[]');
  u.bloggerConnected = !!db.prepare('SELECT blogger_refresh_token FROM users WHERE id=?').get(u.id).blogger_refresh_token;
  res.json({ user: u, plans: PLANS, razorpayKey: process.env.RAZORPAY_KEY_ID });
});

/* ================= PAYMENT (Razorpay, server-side VERIFY) ================= */
// Step 1: order banao (server par — amount kabhi browser se mat lo)
app.post('/api/create-order', needLogin, async (req, res) => {
  const { plan } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: 'galat plan' });
  try {
    const order = await rzp.orders.create({
      amount: PLANS[plan].price, currency: 'INR',
      receipt: `npl_${req.session.userId}_${Date.now()}`,
      notes: { plan, user_id: String(req.session.userId) },
    });
    res.json({ orderId: order.id, amount: order.amount, plan });
  } catch (e) {
    res.status(500).json({ error: 'order nahi ban paya — Razorpay keys check karo' });
  }
});

// Step 2: browser se aaye payment ko SERVER par verify karo (asli suraksha yahi hai)
app.post('/api/verify-payment', needLogin, (req, res) => {
  const { order_id, payment_id, signature, plan, categories } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: 'galat plan' });
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(order_id + '|' + payment_id).digest('hex');
  if (expected !== signature) return res.status(400).json({ error: 'payment verify NAHI hua' });
  const until = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  db.prepare('UPDATE users SET plan=?, paid_until=?, categories=? WHERE id=?')
    .run(plan, until, JSON.stringify((categories || []).slice(0, PLANS[plan].categories)), req.session.userId);
  res.json({ ok: true, plan, paid_until: until });
});

// Webhook (Razorpay dashboard me lagana): payment.captured par bhi plan lagao — double suraksha
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-razorpay-signature'];
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || '')
    .update(req.body).digest('hex');
  if (sig !== expected) return res.status(400).send('bad signature');
  const evt = JSON.parse(req.body.toString());
  if (evt.event === 'payment.captured') {
    const p = evt.payload.payment.entity;
    const uid = p.notes && p.notes.user_id, plan = p.notes && p.notes.plan;
    if (uid && PLANS[plan]) {
      const until = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
      db.prepare('UPDATE users SET plan=?, paid_until=? WHERE id=? AND (paid_until IS NULL OR paid_until < ?)')
        .run(plan, until, uid, until);
    }
  }
  res.json({ ok: true });
});

/* ================= FREE TRIAL (Razorpay approval tak — bina payment 7 din) ================= */
app.post('/api/trial', needLogin, (req, res) => {
  const u = db.prepare('SELECT plan, paid_until FROM users WHERE id=?').get(req.session.userId);
  const today = new Date().toISOString().slice(0, 10);
  if (u.plan && (u.paid_until || '') >= today)
    return res.status(400).json({ error: 'plan pehle se active hai' });
  const { categories } = req.body || {};
  const until = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  db.prepare('UPDATE users SET plan=?, paid_until=?, categories=? WHERE id=?')
    .run('starter', until, JSON.stringify((categories || ['Desh']).slice(0, 1)), req.session.userId);
  res.json({ ok: true, plan: 'starter', paid_until: until });
});

/* ================= BLOGGER CONNECT (Google OAuth — password kabhi nahi) ================= */
app.get('/auth/google', needLogin, (req, res) => {
  const url = oauth2.generateAuthUrl({
    access_type: 'offline', prompt: 'consent', scope: [BLOGGER_SCOPE],
    state: String(req.session.userId),
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2.getToken(req.query.code);
    if (!tokens.refresh_token) throw new Error('no refresh token');
    const uid = Number(req.query.state);
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${BASE_URL}/auth/google/callback`);
    client.setCredentials({ refresh_token: tokens.refresh_token });
    const blogger = google.blogger({ version: 'v3', auth: client });
    const blogs = await blogger.blogs.listByUser({ userId: 'self' });
    const first = (blogs.data.items || [])[0] || {};
    db.prepare('UPDATE users SET blogger_refresh_token=?, blog_id=?, blog_url=? WHERE id=?')
      .run(tokens.refresh_token, first.id || null, first.url || null, uid);
    res.redirect('/dashboard.html?connected=1');
  } catch (e) {
    res.redirect('/dashboard.html?error=oauth');
  }
});

/* ================= SERVICE: news post (sirf owner ke liye, SERVICE_KEY se) ================= */
function bloggerClientFor(refreshToken) {
  const c = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${BASE_URL}/auth/google/callback`);
  c.setCredentials({ refresh_token: refreshToken });
  return google.blogger({ version: 'v3', auth: c });
}

// POST /api/service/post  { user_email, title, html, labels: [] }
app.post('/api/service/post', async (req, res) => {
  if (req.headers['x-service-key'] !== process.env.SERVICE_KEY)
    return res.status(403).json({ error: 'forbidden' });
  const { user_email, title, html, labels, draft } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get((user_email || '').toLowerCase());
  if (!u) return res.status(404).json({ error: 'user nahi mila' });
  if (!u.plan || (u.paid_until || '') < new Date().toISOString().slice(0, 10))
    return res.status(402).json({ error: 'plan active nahi' });
  if (!u.blogger_refresh_token || !u.blog_id)
    return res.status(400).json({ error: 'blogger connected nahi' });
  try {
    const blogger = bloggerClientFor(u.blogger_refresh_token);
    const r = await blogger.posts.insert({
      blogId: u.blog_id,
      isDraft: !!draft,
      requestBody: { title, content: html, labels: labels || ['News'] },
    });
    res.json({ ok: true, url: r.data.url, postId: r.data.id });
  } catch (e) {
    res.status(500).json({ error: 'blogger post fail: ' + (e.message || e) });
  }
});

app.get('/api/service/due', (req, res) => {
  if (req.headers['x-service-key'] !== process.env.SERVICE_KEY)
    return res.status(403).json({ error: 'forbidden' });
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT id,email,plan,categories,blog_id FROM users
    WHERE plan IS NOT NULL AND paid_until >= ? AND blogger_refresh_token IS NOT NULL AND blog_id IS NOT NULL`)
    .all(today);
  res.json({ users: rows.map(r => ({ ...r, categories: JSON.parse(r.categories || '[]') })) });
});

app.listen(PORT, () => console.log(`NewsPixLab service live: ${BASE_URL}`));
