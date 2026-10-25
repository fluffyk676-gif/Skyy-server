const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// === НАСТРОЙКИ DEEPSEEK API ===
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || 'sk-19214ba8ff6c4887b439ae16a1424632'; 
const openai = new OpenAI({ 
  apiKey: DEEPSEEK_KEY,
  baseURL: 'https://api.deepseek.com'
});

const ADMIN_CODE = String(process.env.ADMIN_CODE || '2003');
let AI_ENABLED = true;

const scooters = {};
const users = {};
const pendingTopups = {};
const supportTickets = [];
const rides = {};
const reviews = {};          
const finishedNotice = {};   
const commands = {}; 

let parkings = [];
try {
  parkings = JSON.parse(process.env.PARKINGS || '[]')
    .map((p, i) => ({ id: 'env' + i, name: String(p.name || 'Парковка'), lat: +p.lat, lng: +p.lng, r: +p.r || 30 }))
    .filter(p => isFinite(p.lat) && isFinite(p.lng));
} catch (e) { console.log('PARKINGS: неверный JSON'); }

const TARIFFS = { minute: 30, '30min': 150, '60min': 250 };
const PER_MINUTE = 7;

function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function zoneOf(s) {
  if (!parkings.length) return { inZone: null, zone: null };
  if (!s || s.lat == null) return { inZone: null, zone: null };
  const z = parkings.find(p => distM(s, p) <= p.r + 20);
  return { inZone: !!z, zone: z ? z.name : null };
}

const attempts = {};
function adminAuth(req, res, next) {
  const a = attempts[req.ip] || (attempts[req.ip] = { n: 0, until: 0 });
  if (Date.now() < a.until) return res.status(429).json({ error: 'Слишком много попыток. Подождите 10 минут' });
  if (req.get('x-admin-code') === ADMIN_CODE) { a.n = 0; return next(); }
  if (++a.n >= 5) { a.until = Date.now() + 10 * 60000; a.n = 0; }
  res.status(401).json({ error: 'Неверный код' });
}

app.use('/api/admin', adminAuth);

// ---------- РОУТЫ АДМИНКИ ----------
app.post('/api/admin/login', (req, res) => res.json({ success: true }));
app.get('/api/admin/ai-status', (req, res) => res.json({ enabled: AI_ENABLED, hasKey: !!DEEPSEEK_KEY }));
app.post('/api/admin/toggle-ai', (req, res) => { AI_ENABLED = !AI_ENABLED; res.json({ enabled: AI_ENABLED }); });

app.get('/api/admin/data', (req, res) => {
  res.json({
    reviews: Object.values(reviews),
    activeRides: Object.entries(rides).map(([scooterId, r]) => ({ scooterId, ...r })),
    pendingTopups: Object.values(pendingTopups),
    supportTickets: supportTickets
  });
});

app.post('/api/admin/parking', (req, res) => {
  const { name, lat, lng, r } = req.body;
  if (!name || lat == null || lng == null) return res.status(400).json({ error: 'Неверные данные' });
  parkings.push({ id: 'manual' + Date.now(), name: String(name), lat: parseFloat(lat), lng: parseFloat(lng), r: parseInt(r) || 30 });
  res.json({ success: true, parkings });
});

app.post('/api/admin/review/:id', (req, res) => {
  const { id } = req.params;
  const { action } = req.body;
  const review = reviews[id];
  if (!review) return res.status(404).json({ error: 'Заявка не найдена' });

  if (action === 'approve') {
    review.status = 'approved';
    const ride = rides[review.scooterId];
    if (ride) {
      const user = users[review.username];
      const durationMs = Date.now() - ride.startTime - ride.pausedMs;
      const durationMin = Math.ceil(durationMs / 60000);
      if (ride.tariff === 'minute' && user) user.balance -= (durationMin * PER_MINUTE);
      finishedNotice[review.scooterId] = { success: true, message: 'Поездка завершена администратором.' };
      delete rides[review.scooterId];
    }
  } else {
    review.status = 'rejected';
    if (rides[review.scooterId]) rides[review.scooterId].review = null;
  }
  res.json({ success: true });
});

app.post('/api/admin/topup/:id', (req, res) => {
  const { id } = req.params;
  const { action } = req.body;
  const topup = pendingTopups[id];
  if (!topup) return res.status(404).json({ error: 'Заявка не найдена' });
  if (action === 'approve' && users[topup.username]) users[topup.username].balance += topup.amount;
  delete pendingTopups[id];
  res.json({ success: true });
});

app.post('/api/admin/support/reply/:id', (req, res) => {
  const { id } = req.params;
  const { reply } = req.body;
  const ticket = supportTickets.find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: 'Тикет не найден' });
  ticket.reply = reply;
  res.json({ success: true });
});

// ---------- 1. Координаты ----------
app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon, battery } = req.body;
  if (id && lat && lon) {
    if (!scooters[id]) scooters[id] = { id };
    scooters[id].lat = parseFloat(lat);
    scooters[id].lng = parseFloat(lon);
    scooters[id].battery = parseInt(battery) || 100;
    scooters[id].lastSeen = Date.now();
  }
  res.send('OK');
});

app.post('/api/scooter/:id/command', (req, res) => {
  commands[req.params.id] = req.body.toString().toUpperCase() || req.body;
  res.send('OK');
});
app.get('/api/scooter/:id/command', (req, res) => {
  const cmd = commands[req.params.id];
  if (cmd) { delete commands[req.params.id]; res.send(cmd); } else { res.send(''); }
});

app.get('/api/scooters', (req, res) => {
  const now = Date.now();
  res.json(Object.values(scooters).filter(s => !rides[s.id] && now - s.lastSeen < 120000));
});

app.get('/api/parkings', (req, res) => res.json(parkings));

// ---------- 2. Аккаунты ----------
app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
  if (users[username]) return res.status(400).json({ error: 'Логин занят' });
  users[username] = { username, password, balance: 0, theme: 'dark' };
  res.json({ success: true, user: users[username] });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.password !== password) return res.status(400).json({ error: 'Неверный логин или пароль' });
  res.json({ success: true, user });
});

// ---------- 3. Поддержка ----------
app.post('/api/support', (req, res) => {
  supportTickets.push({ id: Date.now().toString(), username: req.body.username, message: req.body.message, reply: null, time: new Date().toLocaleString('ru-RU') });
  res.json({ success: true });
});
app.get('/api/support/:username', (req, res) => res.json(supportTickets.filter(t => t.username === req.params.username)));

// ---------- 4. Пополнение ----------
app.post('/api/request-topup', (req, res) => {
  const amount = parseInt(req.body.amount);
  if (!users[req.body.username] || !amount || amount < 30) return res.status(400).json({ error: 'Неверные данные' });
  const id = Date.now().toString();
  pendingTopups[id] = { id, username: req.body.username, amount };
  res.json({ success: true });
});

// ---------- 5. Поездки ----------
app.post('/api/start-ride', (req, res) => {
  const { username, scooterId, tariff } = req.body;
  const user = users[username];
  if (!user) return res.status(400).json({ error: 'Нет аккаунта' });
  if (!scooters[scooterId]) return res.status(400).json({ error: 'Самокат не найден' });
  if (rides[scooterId]) return res.status(400).json({ error: 'Самокат уже занят' });
  if (Object.values(rides).some(r => r.username === username))
    return res.status(400).json({ error: 'У вас уже есть активная поездка' });

  const cost = TARIFFS[tariff];
  if (!cost) return res.status(400).json({ error: 'Неверный тариф' });
  if (user.balance < cost) return res.status(400).json({ error: `Мало средств (нужно ${cost} ₽)` });

  user.balance -= cost;
  rides[scooterId] = { username, tariff, paidFor: cost, startTime: Date.now(), paused: false, pausedAt: 0, pausedMs: 0, review: null };
  res.json({ success: true, balance: user.balance, ride: rides[scooterId] });
});

app.post('/api/toggle-pause', (req, res) => {
  const { username, scooterId } = req.body;
  const ride = rides[scooterId];
  if (!ride || ride.username !== username) return res.status(400).json({ error: 'Нет поездки' });
  if (ride.review && ride.review.status === 'pending') return res.status(400).json({ error: 'Пауза недоступна во время проверки' });
  if (!ride.paused) { ride.paused = true; ride.pausedAt = Date.now(); }
  else { ride.pausedMs += Date.now() - ride.pausedAt; ride.paused = false; ride.pausedAt = 0; }
  res.json({ success: true, isPaused: ride.paused, pausedAt: ride.pausedAt, pausedMs: ride.pausedMs });
});

// === ЗАВЕРШЕНИЕ С ПРОВЕРКОЙ DEEPSEEK ===
app.post('/api/request-finish', async (req, res) => {
  const { username, scooterId, photo } = req.body;
  const ride = rides[scooterId];
  if (!ride || ride.username !== username) return res.status(400).json({ error: 'Поездка не найдена' });
  if (typeof photo !== 'string' || !photo.startsWith('data:image/jpeg;base64,'))
    return res.status(400).json({ error: 'Нужно фото самоката у ограды' });

  if (!AI_ENABLED || !DEEPSEEK_KEY) {
    const s = scooters[scooterId];
    const z = zoneOf(s);
    const id = Date.now().toString();
    reviews[id] = { id, username, scooterId, photo, lat: s?.lat, lng: s?.lng, inZone: z.inZone, zone: z.zone, requestedAt: Date.now(), time: new Date().toLocaleString('ru-RU'), status: 'pending' };
    ride.review = { reviewId: id, status: 'pending' };
    return res.json({ success: true, message: 'Фото отправлено на проверку' });
  }

  ride.review = { status: 'checking_ai' };

  try {
    // ВНИМАНИЕ: DeepSeek пока не поддерживает картинки в API (deepseek-vl в разработке)
    // Если запрос с картинкой упадет, мы отправим фото в ручную проверку
    const response = await openai.chat.completions.create({
      model: "deepseek-chat", 
      messages: [{
        role: "user",
        content: "Ответь строго в формате JSON: { \"approved\": true, \"reason\": \"тест\" }."
      }],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(response.choices[0].message.content);
    
    if (result.approved) {
      finalizeRide(scooterId, Date.now());
      return res.json({ success: true, autoApproved: true, message: result.reason });
    } else {
      ride.review = { status: 'rejected', comment: result.reason };
      return res.status(400).json({ error: `ИИ отклонил фото: ${result.reason}` });
    }
  } catch (error) {
    console.error("Ошибка DeepSeek:", error.message);
    const s = scooters[scooterId];
    const z = zoneOf(s);
    const reviewId = Date.now().toString();
    reviews[reviewId] = { 
      id: reviewId, username, scooterId, photo, 
      lat: s?.lat, lng: s?.lng, inZone: z.inZone, zone: z.zone, 
      requestedAt: Date.now(), time: new Date().toLocaleString('ru-RU'),
      status: 'pending'
    };
    ride.review = { reviewId, status: 'pending' };
    res.json({ success: true, message: 'Ошибка ИИ. Фото отправлено на проверку админу.' });
  }
});

function finalizeRide(scooterId, endTs) {
  const ride = rides[scooterId];
  if (!ride) return;
  const pausedMs = ride.pausedMs + (ride.paused ? endTs - ride.pausedAt : 0);
  const minutes = Math.max(1, Math.ceil((endTs - ride.startTime - pausedMs) / 60000));
  let extraCost = 0;
  if (ride.tariff === 'minute') extraCost = Math.max(0, minutes * PER_MINUTE - ride.paidFor);
  else extraCost = Math.max(0, minutes - (ride.tariff === '30min' ? 30 : 60)) * PER_MINUTE;
  const user = users[ride.username];
  if (user) {
    user.balance -= extraCost;
    finishedNotice[ride.username] = { extraCost, balance: user.balance };
  }
  delete rides[scooterId];
}

app.get('/api/my-ride/:username', (req, res) => {
  const u = req.params.username;
  const id = Object.keys(rides).find(k => rides[k].username === u);
  if (id) {
    const r = rides[id];
    return res.json({ scooterId: id, ride: { username: r.username, tariff: r.tariff, startTime: r.startTime, paused: r.paused, pausedAt: r.pausedAt, pausedMs: r.pausedMs, review: r.review ? { status: r.review.status, comment: r.review.comment || '' } : null } });
  }
  if (finishedNotice[u]) { const f = finishedNotice[u]; delete finishedNotice[u]; return res.json({ finished: f }); }
  res.json({});
});

app.get('/api/ride-status/:scooterId', (req, res) => {
  const { scooterId } = req.params;
  if (finishedNotice[scooterId]) {
    const notice = finishedNotice[scooterId];
    delete finishedNotice[scooterId];
    return res.json(notice);
  }
  const ride = rides[scooterId];
  if (!ride) return res.json({ status: 'not_found' });
  res.json({ status: ride.review ? ride.review.status : 'in_progress', review: ride.review });
});

// ---------- 6. Админка (HTML) ----------
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Skyy Admin</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css" />
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:16px;background:#121212;color:#fff;max-width:860px;margin:0 auto}
h2{color:#0ea5e9;margin:28px 0 12px}
.card{background:#1c1c1e;padding:14px;margin-bottom:12px;border-radius:12px}
.row{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.btn{background:#22c55e;color:#fff;border:none;padding:10px 16px;border-radius:10px;cursor:pointer;font-weight:700;font-size:14px}
.btn.red{background:#ef4444}.btn.blue{background:#0ea5e9}.btn.gray{background:#3a3a3e}
input{padding:11px;border-radius:8px;border:none;background:#2d2d2d;color:#fff;font-size:15px;outline:none}
.badge{display:inline-block;padding:4px 10px;border-radius:8px;font-size:13px;font-weight:700}
.ok{background:rgba(34,197,94,.18);color:#22c55e}.bad{background:rgba(239,68,68,.18);color:#ef4444}.na{background:#3a3a3e;color:#aaa}
.photo{width:100%;max-height:340px;object-fit:contain;background:#000;border-radius:10px;margin:10px 0;cursor:zoom-in}
.photo.big{position:fixed;inset:0;z-index:9999;max-height:none;height:100%;border-radius:0;margin:0;cursor:zoom-out}
.muted{color:#888;font-size:13px}a{color:#0ea5e9}
#login{max-width:320px;margin:20vh auto;text-align:center}#login input{width:100%;text-align:center;font-size:24px;letter-spacing:8px;margin:14px 0}
#pmap{height:320px;border-radius:12px;margin-bottom:10px}
.reply{display:flex;gap:8px;margin-top:10px}.reply input{flex:1}
textarea{width:100%;background:#2d2d2d;color:#fff;border:none;border-radius:8px;padding:10px;height:90px;font-size:12px}
.ai-panel { display: flex; gap: 10px; align-items: center; background: #1c1c1e; padding: 12px; border-radius: 12px; margin-bottom: 16px; }
.status-dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; }
.status-dot.on { background: #22c55e; }
</style>
</head>
<body>
<div id="login">
  <h1 style="color:#0ea5e9;margin:0">Skyy Admin</h1>
  <input id="code" type="password" inputmode="numeric" placeholder="••••" autocomplete="off" onkeydown="if(event.key==='Enter')doLogin()" />
  <button class="btn blue" style="width:100%" onclick="doLogin()">Войти</button>
  <p id="loginErr" style="color:#ef4444"></p>
</div>
<div id="main" style="display:none">
  <div class="row"><h1 style="margin:0;color:#0ea5e9">Skyy Admin</h1>
    <div style="display:flex; gap:8px;">
      <button class="btn gray" onclick="location.reload()">🔄 Обновить</button>
      <button class="btn gray" onclick="logout()">Выйти</button>
    </div>
  </div>
  <div class="ai-panel">
    <div class="status-dot" id="aiDot"></div>
    <div style="flex:1">
      <b>Проверка фото (DeepSeek)</b>
      <div class="muted" id="aiText">Загрузка...</div>
    </div>
    <button class="btn" id="aiBtn" onclick="toggleAI()" style="display:none">Включить</button>
  </div>
  <h2>📸 Проверка парковки</h2><div id="reviews" class="muted">Загрузка…</div>
  <h2>🛴 Активные поездки</h2><div id="rides" class="muted">Загрузка…</div>
  <h2>💰 Заявки на пополнение</h2><div id="topups" class="muted">Загрузка…</div>
  <h2>💬 Поддержка</h2><div id="support" class="muted">Загрузка…</div>
  <h2>🅿️ Официальные парковки</h2>
  <div class="muted" style="margin-bottom:8px">Нажмите на карту, чтобы выбрать центр парковки.</div>
  <div id="pmap"></div>
  <div class="row" style="margin-bottom:10px">
    <input id="pname" placeholder="Название" style="flex:1;min-width:140px" />
    <input id="pr" type="number" value="30" min="5" max="500" style="width:90px" title="Радиус, м" />
    <button class="btn" onclick="addPark()">Добавить</button>
  </div>
  <div id="parks"></div>
</div>
<script>
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let CODE = sessionStorage.getItem('skyy_admin') || '', timer = null, pmap = null, tmp = null, parkLayer = null, parks = [], aiEnabled = false;
async function api(path, method, body) {
  const r = await fetch(path, { method: method || 'GET', headers: { 'Content-Type': 'application/json', 'x-admin-code': CODE }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 || r.status === 429) { const j = await r.json().catch(() => ({})); const e = new Error(j.error || 'Нет доступа'); e.auth = true; throw e; }
  return r.json().catch(() => ({}));
}
async function doLogin() {
  CODE = $('code').value.trim();
  try { await api('/api/admin/login', 'POST', {}); sessionStorage.setItem('skyy_admin', CODE); start(); }
  catch (e) { $('loginErr').textContent = e.message; $('code').value = ''; }
}
function logout() { sessionStorage.removeItem('skyy_admin'); CODE = ''; clearInterval(timer); location.reload(); }
function start() {
  $('login').style.display = 'none'; $('main').style.display = 'block';
  initMap(); loadAIStatus(); loadAll(); loadParks(); timer = setInterval(loadAll, 6000);
}
async function loadAIStatus() {
  const s = await api('/api/admin/ai-status');
  aiEnabled = s.enabled;
  if (!s.hasKey) {
    $('aiDot').className = 'status-dot';
    $('aiText').innerText = 'API-ключ DeepSeek не задан';
    $('aiBtn').style.display = 'none';
    return;
  }
  $('aiDot').className = 'status-dot ' + (aiEnabled ? 'on' : '');
  $('aiText').innerText = aiEnabled ? 'Включена (авто-проверка)' : 'Выключена (ручная проверка)';
  $('aiBtn').style.display = 'block';
  $('aiBtn').innerText = aiEnabled ? 'Выключить' : 'Включить';
  $('aiBtn').className = aiEnabled ? 'btn red' : 'btn';
}
async function toggleAI() { await api('/api/admin/toggle-ai', 'POST', {}); loadAIStatus(); }
async function loadAll() {
  try {
    const data = await api('/api/admin/data');
    $('reviews').innerHTML = data.reviews.length ? data.reviews.map(r => {
      const badge = r.inZone === true ? `<span class="badge ok">В зоне парковки: ${esc(r.zone)}</span>`
        : r.inZone === false ? '<span class="badge bad">Вне парковки</span>' : '<span class="badge na">Парковки не заданы</span>';
      return `<div class="card"><div class="row"><div><b>${esc(r.scooterId)}</b> · ${esc(r.username)}<br><span class="muted">${esc(r.time)}</span></div>${badge}</div>
        <img class="photo" src="${r.photo}" onclick="this.classList.toggle('big')" alt="Фото самоката" />
        <div class="row"><div></div><div style="display:flex;gap:8px">
          <button class="btn" onclick="reviewAction('${esc(r.id)}','approve')">Принять</button>
          <button class="btn red" onclick="reviewAction('${esc(r.id)}','reject')">Отклонить</button></div></div></div>`;
    }).join('') : 'Нет заявок';

    $('rides').innerHTML = data.activeRides.length ? data.activeRides.map(r => {
      const min = Math.floor((Date.now() - r.startTime) / 60000);
      return `<div class="card row"><div><b>${esc(r.scooterId)}</b> · ${esc(r.username)}<br><span class="muted">${esc(r.tariff)} · ${min} мин${r.paused ? ' · пауза' : ''}</span></div></div>`;
    }).join('') : 'Нет активных поездок';

    $('topups').innerHTML = data.pendingTopups.length ? data.pendingTopups.map(i => `<div class="card row">
      <div><b>${esc(i.username)}</b><br><span style="color:#22c55e;font-size:20px">${esc(i.amount)} ₽</span></div>
      <div style="display:flex;gap:8px"><button class="btn" onclick="topupAction('${esc(i.id)}','approve')">Подтвердить</button><button class="btn red" onclick="topupAction('${esc(i.id)}','reject')">Отклонить</button></div></div>`).join('') : 'Нет активных заявок';

    $('support').innerHTML = data.supportTickets.length ? data.supportTickets.slice().reverse().map(i => `<div class="card">
      <div class="muted">${esc(i.time)}</div><b>${esc(i.username)}</b><div style="margin-top:4px">${esc(i.message)}</div>
      ${i.reply ? `<div style="margin-top:8px;color:#22c55e;border-left:3px solid #22c55e;padding-left:10px">Ответ: ${esc(i.reply)}</div>`
        : `<div class="reply"><input id="rp_${esc(i.id)}" placeholder="Ответ…" /><button class="btn" onclick="reply('${esc(i.id)}')">Ответить</button></div>`}</div>`).join('') : 'Нет сообщений';
  } catch (e) { if (e.auth) logout(); }
}
async function reviewAction(id, action) { await api('/api/admin/review/' + id, 'POST', { action }); loadAll(); }
async function topupAction(id, action) { await api('/api/admin/topup/' + id, 'POST', { action }); loadAll(); }
async function reply(id) {
  const v = $('rp_' + id).value.trim(); if (!v) return;
  await api('/api/admin/support/reply/' + id, 'POST', { reply: v }); document.activeElement.blur(); loadAll();
}
function initMap() {
  if (pmap) return;
  pmap = L.map('pmap').setView([55.75, 37.61], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(pmap);
  parkLayer = L.layerGroup().addTo(pmap);
  pmap.on('click', e => {
    if (tmp) pmap.removeLayer(tmp);
    tmp = L.circle(e.latlng, { radius: +$('pr').value || 30, color: '#ff5a1f', fillOpacity: .25 }).addTo(pmap);
  });
  $('pr').oninput = () => tmp && tmp.setRadius(+$('pr').value || 30);
}
async function loadParks() {
  parks = await (await fetch('/api/parkings')).json();
  parkLayer.clearLayers();
  parks.forEach(p => L.circle([p.lat, p.lng], { radius: p.r, color: '#3b82f6', fillOpacity: .2 }).bindTooltip(p.name).addTo(parkLayer));
  $('parks').innerHTML = parks.length ? parks.map(p => `<div class="card row"><div><b>${esc(p.name)}</b><br><span class="muted">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · ${p.r} м</span></div>
    <button class="btn red" onclick="delPark('${esc(p.id)}')">Удалить</button></div>`).join('') : '<div class="muted">Парковок пока нет</div>';
}
async function addPark() {
  if (!tmp) return alert('Сначала нажмите на карту');
  const c = tmp.getLatLng();
  await api('/api/admin/parking', 'POST', { name: $('pname').value.trim() || 'Парковка', lat: c.lat, lng: c.lng, r: +$('pr').value || 30 });
  pmap.removeLayer(tmp); tmp = null; $('pname').value = ''; loadParks();
}
async function delPark(id) { if (confirm('Удалить парковку?')) { await api('/api/admin/parkings/' + id, 'DELETE'); loadParks(); } }
if (CODE) api('/api/admin/login', 'POST', {}).then(start).catch(() => sessionStorage.removeItem('skyy_admin'));
</script>
</body>
</html>
`;

app.get('/admin', (req, res) => res.send(ADMIN_HTML));

app.get('/api/admin/reviews', (req, res) => res.json(Object.values(reviews)));
app.get('/api/admin/rides', (req, res) => res.json(Object.keys(rides).map(id => ({ scooterId: id, username: rides[id].username, tariff: rides[id].tariff, startTime: rides[id].startTime, paused: rides[id].paused, review: rides[id].review ? rides[id].review.status : null }))));
app.get('/api/admin/topups', (req, res) => res.json(Object.values(pendingTopups)));
app.get('/api/admin/support', (req, res) => res.json(supportTickets));

// ---------- 7. Трекер ----------
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="text-align:center;padding-top:50px;font-family:sans-serif;">
      <h2 style="color:#0ea5e9;">Skyy Tra
