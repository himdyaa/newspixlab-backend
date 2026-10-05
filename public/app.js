/* NewsPixLab frontend logic */
const $ = id => document.getElementById(id);
const CATS = ['Desh','Videsh','Pradesh','Khel','Manoranjan','Technology','Business','Dharm-Astha'];
let ME = null, RZP_KEY = '';

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  return r.json();
}
function msg(el, t, ok) { const e = $(el); e.textContent = t; e.className = 'msg ' + (ok ? 'ok' : 'err'); }

// URL se plan preselect (?plan=growth)
const qPlan = new URLSearchParams(location.search).get('plan');

async function refresh() {
  try {
    const d = await (await fetch('/api/me')).json();
    if (d.error) return; // login nahi
    ME = d.user; RZP_KEY = d.razorpayKey;
    $('authCard').style.display = 'none';
    $('dash').style.display = 'block';
    $('logoutBtn').style.display = '';
    // Profile card
    const em = ME.email || '';
    $('pAvatar').textContent = em.charAt(0).toUpperCase() || '?';
    $('pEmail').textContent = em;
    const planName = ME.plan ? d.plans[ME.plan].name : null;
    $('pStatus').innerHTML = planName
      ? `<span class="badge-ok">✅ ${planName} Active</span>`
      : `<span class="badge-warn">⚠️ Koi plan active nahi</span>`;
    $('logoutBtn2').style.display = '';
    $('stPlan').textContent = ME.plan ? d.plans[ME.plan].name : 'Koi nahi';
    $('stValid').textContent = ME.paid_until || '—';
    $('stBlog').textContent = ME.bloggerConnected ? '✅ Connected' : '❌ Nahi';
    $('stNews').textContent = ME.plan ? (d.plans[ME.plan].categories * d.plans[ME.plan].newsPerDay + ' / roz') : '—';
    // plan select
    $('planSel').innerHTML = Object.entries(d.plans).map(([k,p]) =>
      `<option value="${k}"${(qPlan||ME.plan)===k?' selected':''}>${p.name} — ₹${(p.price/100).toLocaleString('en-IN')}/mahina (${p.categories} cat.)</option>`).join('');
    renderCats();
    $('planCard').style.display = ME.plan ? 'none' : '';
    $('blogCard').style.display = (ME.plan && !ME.bloggerConnected) ? '' : 'none';
    if (new URLSearchParams(location.search).get('connected')) msg('blogMsg','✅ Blogger connect ho gaya!',true);
    if (new URLSearchParams(location.search).get('error')) msg('blogMsg','OAuth me dikkat aayi — dobara try karein',false);
  } catch(e) {}
}
let picked = [];
function planMaxCats() {
  const plan = $('planSel') ? $('planSel').value : 'starter';
  return { starter:5, growth:5, pro:7, ultimate:8 }[plan] || 5;
}
function renderCats() {
  const max = planMaxCats();
  if (picked.length > max) picked = picked.slice(0, max);
  $('catPick').innerHTML = CATS.map(c =>
    `<span class="cat${picked.includes(c)?' on':''}" data-c="${c}">${c}</span>`).join('')
    + `<div class="cathint">${picked.length}/${max} categories chuni</div>`;
  document.querySelectorAll('.cat').forEach(el => el.onclick = () => {
    const c = el.dataset.c;
    const lim = planMaxCats();
    picked = picked.includes(c) ? picked.filter(x=>x!==c) : (picked.length < lim ? [...picked, c] : picked);
    renderCats();
  });
}
$('planSel') && ($('planSel').onchange = () => { renderCats(); });

$('loginBtn').onclick = async () => {
  const r = await api('/api/login', { email: $('email').value, password: $('pass').value });
  r.ok ? location.reload() : msg('authMsg', r.error || 'error', false);
};
$('signupBtn').onclick = async () => {
  const r = await api('/api/signup', { email: $('email').value, password: $('pass').value });
  r.ok ? location.reload() : msg('authMsg', r.error || 'error', false);
};
$('logoutBtn').onclick = async () => { await api('/api/logout'); location.href='index.html'; };
$('logoutBtn2') && ($('logoutBtn2').onclick = async () => { await api('/api/logout'); location.href='index.html'; });

$('payBtn').onclick = async () => {
  const plan = $('planSel').value;
  const maxCats = { starter:5, growth:5, pro:7, ultimate:8 }[plan] || 5;
  if (!picked.length) return msg('payMsg','Pehle categories chunein',false);
  const cats = picked.slice(0, maxCats);
  msg('payMsg','Order ban raha hai…',true);
  const o = await api('/api/create-order', { plan });
  if (o.error) return msg('payMsg', o.error, false);
  const rz = new Razorpay({
    key: RZP_KEY, amount: o.amount, currency: 'INR', order_id: o.orderId,
    name: 'NewsPixLab', description: plan + ' plan — 30 din',
    theme: { color: '#e63946' },
    handler: async function(resp) {
      msg('payMsg','Payment verify ho raha hai…',true);
      const v = await api('/api/verify-payment', { order_id: resp.razorpay_order_id, payment_id: resp.razorpay_payment_id, signature: resp.razorpay_signature, plan, categories: cats });
      v.ok ? (msg('payMsg','✅ Payment successful! Plan active.',true), setTimeout(()=>location.reload(),1200)) : msg('payMsg', v.error, false);
    },
    modal: { ondismiss: () => msg('payMsg','Payment cancel kiya gaya',false) }
  });
  rz.open();
};

$('trialBtn') && ($('trialBtn').onclick = async () => {
  const maxCats = 1;
  if (!picked.length) return msg('payMsg','Pehle categories chunein',false);
  const cats = picked.slice(0, maxCats);
  msg('payMsg','Trial activate ho raha hai…',true);
  const t = await api('/api/trial', { categories: cats });
  t.ok ? (msg('payMsg','✅ 7-din free trial active! Ab Blogger connect karein.',true), setTimeout(()=>location.reload(),1200)) : msg('payMsg', t.error || 'error', false);
});

refresh();
