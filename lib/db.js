/* NewsPixLab DB — Vercel Blob (production) ya local JSON file (dev)
   Simple JSON database: { users: [...], seq: number } */
const fs = require('fs');
const path = require('path');

const BLOB_PATH = 'newspixlab-db.json';
const LOCAL_PATH = path.join(__dirname, '..', 'newspixlab.json');

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 3000;

async function blobGet() {
  const { head } = require('@vercel/blob');
  const meta = await head(BLOB_PATH);
  const res = await fetch(meta.url, { cache: 'no-store' });
  if (!res.ok) throw new Error('blob read fail');
  return res.json();
}

async function blobPut(data) {
  const { put } = require('@vercel/blob');
  await put(BLOB_PATH, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

async function load() {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;
  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      cache = await blobGet();
    } else {
      cache = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
    }
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
  const json = JSON.stringify(cache);
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    await blobPut(cache);
  } else {
    fs.writeFileSync(LOCAL_PATH, json);
  }
  cacheTime = Date.now();
}

function sanitize(u) {
  if (!u) return null;
  const { pass_hash, blogger_refresh_token, ...rest } = u;
  return rest;
}

module.exports = {
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
    if (d.users.some(u => u.email === email.toLowerCase())) {
      throw new Error('exists');
    }
    const u = {
      id: d.seq++,
      email: email.toLowerCase(),
      pass_hash: passHash,
      plan: null,
      paid_until: null,
      categories: '[]',
      blogger_refresh_token: null,
      blog_id: null,
      blog_url: null,
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
  sanitize,
};
