/* NewsPixLab DB — Postgres (production, DATABASE_URL) ya JSON file (local dev)
   Interface: getUserByEmail, getUserById, createUser, updateUser, getDueUsers, sanitize */
const fs = require('fs');
const path = require('path');

const LOCAL_PATH = path.join(__dirname, '..', 'newspixlab.json');
const USE_PG = !!process.env.DATABASE_URL;

let pool = null;
function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
    pool.on('error', e => console.error('pg pool error', e.message));
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT,
  plan TEXT,
  paid_until TEXT,
  categories TEXT DEFAULT '[]',
  blogger_refresh_token TEXT,
  blog_id TEXT,
  blog_url TEXT,
  blog_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);`;

let schemaDone = false;
async function ensureSchema() {
  if (schemaDone) return;
  await getPool().query(SCHEMA);
  schemaDone = true;
}

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    pass_hash: r.pass_hash,
    plan: r.plan,
    paid_until: r.paid_until,
    categories: r.categories || '[]',
    blogger_refresh_token: r.blogger_refresh_token,
    blog_id: r.blog_id,
    blog_url: r.blog_url,
    blog_name: r.blog_name,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

/* ---------- Postgres implementation ---------- */
const pgDb = {
  async getUserByEmail(email) {
    await ensureSchema();
    const r = await getPool().query('SELECT * FROM users WHERE email=$1', [(email || '').toLowerCase()]);
    return rowToUser(r.rows[0]);
  },
  async getUserById(id) {
    await ensureSchema();
    const r = await getPool().query('SELECT * FROM users WHERE id=$1', [Number(id)]);
    return rowToUser(r.rows[0]);
  },
  async createUser(email, passHash) {
    await ensureSchema();
    try {
      const r = await getPool().query(
        'INSERT INTO users (email, pass_hash) VALUES ($1,$2) RETURNING *',
        [email.toLowerCase(), passHash]
      );
      return rowToUser(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw new Error('exists');
      throw e;
    }
  },
  async updateUser(id, fields) {
    await ensureSchema();
    const allowed = ['plan','paid_until','categories','blogger_refresh_token','blog_id','blog_url','blog_name','pass_hash'];
    const keys = Object.keys(fields).filter(k => allowed.includes(k));
    if (!keys.length) return this.getUserById(id);
    const set = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
    const vals = [Number(id), ...keys.map(k => fields[k])];
    const r = await getPool().query(`UPDATE users SET ${set} WHERE id=$1 RETURNING *`, vals);
    return rowToUser(r.rows[0]);
  },
  async getDueUsers(today) {
    await ensureSchema();
    const r = await getPool().query(
      `SELECT * FROM users WHERE plan IS NOT NULL AND paid_until >= $1
       AND blogger_refresh_token IS NOT NULL AND blog_id IS NOT NULL`,
      [today]
    );
    return r.rows.map(rowToUser);
  },
};

/* ---------- JSON file implementation (local dev) ---------- */
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 3000;

async function load() {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
  } catch (e) {
    cache = { users: [], seq: 1 };
  }
  if (!cache.users) cache.users = [];
  if (!cache.seq) cache.seq = cache.users.length + 1;
  cacheTime = Date.now();
  return cache;
}
async function save() {
  if (!cache) return;
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(cache));
  cacheTime = Date.now();
}
const jsonDb = {
  async getUserByEmail(email) {
    const d = await load();
    return d.users.find(u => u.email === (email || '').toLowerCase()) || null;
  },
  async getUserById(id) {
    const d = await load();
    return d.users.find(u => u.id === Number(id)) || null;
  },
  async createUser(email, passHash) {
    const d = await load();
    if (d.users.some(u => u.email === email.toLowerCase())) throw new Error('exists');
    const u = {
      id: d.seq++, email: email.toLowerCase(), pass_hash: passHash,
      plan: null, paid_until: null, categories: '[]',
      blogger_refresh_token: null, blog_id: null, blog_url: null,
      created_at: new Date().toISOString(),
    };
    d.users.push(u);
    await save();
    return u;
  },
  async updateUser(id, fields) {
    const d = await load();
    const u = d.users.find(x => x.id === Number(id));
    if (!u) return null;
    Object.assign(u, fields);
    await save();
    return u;
  },
  async getDueUsers(today) {
    const d = await load();
    return d.users.filter(u =>
      u.plan && (u.paid_until || '') >= today &&
      u.blogger_refresh_token && u.blog_id
    );
  },
};

function sanitize(u) {
  if (!u) return null;
  const { pass_hash, blogger_refresh_token, ...rest } = u;
  return rest;
}

const impl = USE_PG ? pgDb : jsonDb;
module.exports = { ...impl, sanitize };
