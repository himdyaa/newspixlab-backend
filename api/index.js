/* NewsPixLab Service — Vercel serverless version
   Flow: signup/login -> plan/trial -> "Blogger Connect" (Google OAuth, password kabhi nahi)
   DB: Vercel Blob JSON (production) / local JSON (dev). Auth: JWT httpOnly cookie. */
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const path = require('path');
const Razorpay = require('razorpay');
const { google } = require('googleapis');
const db = require('../lib/db');

const app = express();
const JWT_SECRET = process.env.SESSION_SECRET || 'dev-secret-badlo';
const BASE_URL = (process.env.BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
).replace(/\/$/, '');

/* ---------- Plans (price paise me) ---------- */
const PLANS = {
  starter:  { name: 'Plan 1', price: 250000, per: 'mahina', categories: 5, newsPerDay: 3 },
  growth:   { name: 'Plan 2', price: 320000, per: 'mahina', categories: 5, newsPerDay: 5 },
  pro:      { name: 'Plan 3', price: 400000, per: 'mahina', categories: 7, newsPerDay: 7 },
  ultimate: { name: 'Plan 4', price: 500000, per: 'mahina', categories: 8, newsPerDay: 7, customNews: true },
};

/* ---------- Razorpay ---------- */
let rzp = null;
if (process.env.RAZORPAY_KEY_ID) {
  rzp = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

/* ---------- Google OAuth (Blogger) ---------- */
function oauth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/auth/google/callback`
  );
}
const BLOGGER_SCOPE = 'https://www.googleapis.com/auth/blogger';

app.use(express.json());
app.use(cookieParser());
// Static files: Vercel serves public/ natively in production.
// express.static only for local dev (not in Vercel function bundle).
if (!process.env.VERCEL) {
  app.use(express.static(path.join(__dirname, '..', 'public')));
}
// Root: redirect to static index.html (served by Vercel CDN)
app.get('/', (req, res) => res.redirect('/index.html'));

function setAuthCookie(res, userId) {
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('npl_token', token, {
    httpOnly: true, secure: true, sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000, path: '/',
  });
}

const needLogin = (req, res, next) => {
  const token = req.cookies && req.cookies.npl_token;
  if (!token) return res.status(401).json({ error: 'login-required' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    req.userId = p.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'login-required' });
  }
};

/* ================= AUTH ================= */
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 6)
    return res.status(400).json({ error: 'email aur 6+ akshar ka password do' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const u = await db.createUser(email, hash);
    setAuthCookie(res, u.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'ye email pehle se registered hai' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const u = await db.getUserByEmail(email);
  if (!u || !bcrypt.compareSync(password || '', u.pass_hash))
    return res.status(401).json({ error: 'email ya password galat' });
  setAuthCookie(res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('npl_token', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', needLogin, async (req, res) => {
  const u = await db.getUserById(req.userId);
  if (!u) return res.status(401).json({ error: 'login-required' });
  const safe = db.sanitize(u);
  safe.categories = JSON.parse(u.categories || '[]');
  safe.bloggerConnected = !!u.blogger_refresh_token;
  res.json({ user: safe, plans: PLANS, razorpayKey: process.env.RAZORPAY_KEY_ID || null });
});

/* ================= PAYMENT (Razorpay, server-side VERIFY) ================= */
app.post('/api/create-order', needLogin, async (req, res) => {
  const { plan } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: 'galat plan' });
  if (!rzp) return res.status(500).json({ error: 'payment abhi setup nahi hua' });
  try {
    const order = await rzp.orders.create({
      amount: PLANS[plan].price, currency: 'INR',
      receipt: `npl_${req.userId}_${Date.now()}`,
      notes: { plan, user_id: String(req.userId) },
    });
    res.json({ orderId: order.id, amount: order.amount, plan });
  } catch (e) {
    res.status(500).json({ error: 'order nahi ban paya — Razorpay keys check karo' });
  }
});

app.post('/api/verify-payment', needLogin, async (req, res) => {
  const { order_id, payment_id, signature, plan, categories } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: 'galat plan' });
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(order_id + '|' + payment_id).digest('hex');
  if (expected !== signature) return res.status(400).json({ error: 'payment verify NAHI hua' });
  const until = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  await db.updateUser(req.userId, {
    plan, paid_until: until,
    categories: JSON.stringify((categories || []).slice(0, PLANS[plan].categories)),
  });
  res.json({ ok: true, plan, paid_until: until });
});

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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
      const u = await db.getUserById(Number(uid));
      if (u && (!u.paid_until || u.paid_until < until)) {
        await db.updateUser(Number(uid), { plan, paid_until: until });
      }
    }
  }
  res.json({ ok: true });
});

/* ================= FREE TRIAL (7 din, bina payment) ================= */
app.post('/api/trial', needLogin, async (req, res) => {
  const u = await db.getUserById(req.userId);
  const today = new Date().toISOString().slice(0, 10);
  if (u.plan && (u.paid_until || '') >= today)
    return res.status(400).json({ error: 'plan pehle se active hai' });
  const { categories } = req.body || {};
  const until = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  await db.updateUser(req.userId, {
    plan: 'starter', paid_until: until,
    categories: JSON.stringify((categories || ['Desh']).slice(0, 1)),
  });
  res.json({ ok: true, plan: 'starter', paid_until: until });
});

/* ================= BLOGGER CONNECT (Google OAuth — password kabhi nahi) ================= */
app.get('/auth/google', needLogin, (req, res) => {
  const url = oauth2Client().generateAuthUrl({
    access_type: 'offline', prompt: 'consent', scope: [BLOGGER_SCOPE],
    state: String(req.userId),
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client().getToken(req.query.code);
    if (!tokens.refresh_token) throw new Error('no refresh token');
    const uid = Number(req.query.state);
    const client = oauth2Client();
    client.setCredentials({ refresh_token: tokens.refresh_token });
    const blogger = google.blogger({ version: 'v3', auth: client });
    const blogs = await blogger.blogs.listByUser({ userId: 'self' });
    const first = (blogs.data.items || [])[0] || {};
    await db.updateUser(uid, {
      blogger_refresh_token: tokens.refresh_token,
      blog_id: first.id || null,
      blog_url: first.url || null,
    });
    res.redirect('/dashboard.html?connected=1');
  } catch (e) {
    res.redirect('/dashboard.html?error=oauth');
  }
});

/* ================= SERVICE: news post (sirf owner ke liye, SERVICE_KEY se) ================= */
function bloggerClientFor(refreshToken) {
  const c = oauth2Client();
  c.setCredentials({ refresh_token: refreshToken });
  return google.blogger({ version: 'v3', auth: c });
}

app.post('/api/service/post', async (req, res) => {
  if (req.headers['x-service-key'] !== process.env.SERVICE_KEY)
    return res.status(403).json({ error: 'forbidden' });
  const { user_email, title, html, labels, draft } = req.body || {};
  const u = await db.getUserByEmail(user_email);
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

app.get('/api/service/due', async (req, res) => {
  if (req.headers['x-service-key'] !== process.env.SERVICE_KEY)
    return res.status(403).json({ error: 'forbidden' });
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.getDueUsers(today);
  res.json({ users: rows.map(r => ({ ...db.sanitize(r), categories: JSON.parse(r.categories || '[]') })) });
});

module.exports = app;
