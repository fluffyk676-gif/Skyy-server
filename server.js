const express = require('express');
const cors = require('cors');
const path = require('path');
 
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
 
// Код входа в админку. Лучше задать свой в Render → Environment → ADMIN_CODE
const ADMIN_CODE = String(process.env.ADMIN_CODE || '2003');
 
const scooters = {};
const users = {};
const pendingTopups = {};
const supportTickets = [];
const rides = {};
const reviews = {};          // заявки на завершение поездки (с фото)
const finishedNotice = {};   // итог поездки для клиента (отдаётся один раз)
 
// Официальные парковки. Можно задать заранее через переменную PARKINGS (JSON-массив),
// чтобы они не пропадали при перезапуске сервера: [{"name":"...","lat":55.75,"lng":37.61,"r":30}]
let parkings = [];
try {
  parkings = JSON.parse(process.env.PARKINGS || '[]')
    .map((p, i) => ({ id: 'env' + i, name: String(p.name || 'Парковка'), lat: +p.lat, lng: +p.lng, r: +p.r || 30 }))
    .filter(p => isFinite(p.lat) && isFinite(p.lng));
} catch (e) { console.log('PARKINGS: неверный JSON'); }
 
const TARIFFS = { minute: 30, '30min': 150, '60min': 250 }; // списание на старте
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
  const z = parkings.find(p => distM(s, p) <= p.r + 20); // +20 м на погрешность GPS
  return { inZone: !!z, zone: z ? z.name : null };
}
 
// ---------- Защита админки ----------
const attempts = {};
function adminAuth(req, res, next) {
  const a = attempts[req.ip] || (attempts[req.ip] = { n: 0, until: 0 });
  if (Date.now() < a.until) return res.status(429).json({ error: 'Слишком много попыток. Подождите 10 минут' });
  if (req.get('x-admin-code') === ADMIN_CODE) { a.n = 0; return next(); }
  if (++a.n >= 5) { a.until = Date.now() + 10 * 60000; a.n = 0; }
  res.status(401).json({ error: 'Неверный код' });
}
app.use('/api/admin', adminAuth);
app.post('/api/admin/login', (req, res) => res.json({ success: true }));
 
// ---------- 1. Координаты от трекеров ----------
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
 
app.get('/api/scooters', (req, res) => {
  const now = Date.now();
  res.json(Object.values(scooters).filter(s => !rides[s.id] && now - s.lastSeen < 120000));
});
 
app.get('/api/parkings', (req, res) => res.json(parkings));
 
// Прозвон самокатa: клиент нажимает кнопку, трекер на самокате опрашивает /ring и пищит
app.post('/api/ring', (req, res) => {
  const { username, password, scooterId } = req.body;
  const u = users[username];
  if (!u || u.password !== password) return res.status(400).json({ error: 'Войдите в аккаунт' });
  const s = scooters[scooterId];
  if (!s) return res.status(400).json({ error: 'Самокат не найден' });
  const ride = rides[scooterId];
  if (ride && ride.username !== username) return res.status(400).json({ error: 'Самокат занят другим пользователем' });
  if (s.ringUntil && Date.now() < s.ringUntil) return res.status(429).json({ error: 'Самокат уже звонит' });
  s.ringUntil = Date.now() + 10000;
  res.json({ success: true });
});
app.get('/api/scooter/:id/ring', (req, res) => {
  const s = scooters[req.params.id];
  res.json({ ring: !!(s && s.ringUntil && Date.now() < s.ringUntil) });
});
 
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
  supportTickets.push({
    id: Date.now().toString(), username: req.body.username, message: req.body.message,
    reply: null, time: new Date().toLocaleString('ru-RU')
  });
  res.json({ success: true });
});
app.get('/api/support/:username', (req, res) =>
  res.json(supportTickets.filter(t => t.username === req.params.username)));
 
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
 
// Клиент не может завершить поездку сам: только отправить фото на проверку.
app.post('/api/request-finish', (req, res) => {
  const { username, scooterId, photo } = req.body;
  const ride = rides[scooterId];
  if (!ride || ride.username !== username) return res.status(400).json({ error: 'Поездка не найдена' });
  if (typeof photo !== 'string' || !photo.startsWith('data:image/jpeg;base64,') || photo.length > 3000000)
    return res.status(400).json({ error: 'Нужно фото самокат у ограды' });
 
  if (ride.review && ride.review.reviewId) delete reviews[ride.review.reviewId];
  const s = scooters[scooterId];
  const z = zoneOf(s);
  const id = Date.now().toString() + Math.floor(Math.random() * 1000);
  reviews[id] = {
    id, username, scooterId, photo,
    lat: s ? s.lat : null, lng: s ? s.lng : null,
    inZone: z.inZone, zone: z.zone,
    requestedAt: Date.now(), time: new Date().toLocaleString('ru-RU')
  };
  ride.review = { reviewId: id, status: 'pending' };
  res.json({ success: true });
});
 
function finalizeRide(scooterId, endTs) {
  const ride = rides[scooterId];
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
    return res.json({
      scooterId: id,
      ride: {
        username: r.username, tariff: r.tariff, startTime: r.startTime, paused: r.paused,
        pausedAt: r.pausedAt, pausedMs: r.pausedMs,
        review: r.review ? { status: r.review.status, comment: r.review.comment || '' } : null
      }
    });
  }
  if (finishedNotice[u]) { const f = finishedNotice[u]; delete finishedNotice[u]; return res.json({ finished: f }); }
  res.json({});
});
 
// ---------- Страница админки (встроена в server.js, код спрашивается на самой странице) ----------
const ADMIN_HTML = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Skyy Admin</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css" />
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;margin:0 auto;padding:16px;background:#121212;color:#fff;max-width:860px}
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
  <div class="row"><h1 style="margin:0;color:#0ea5e9">Skyy Admin</h1><button class="btn gray" onclick="logout()">Выйти</button></div>
 
  <h2>📸 Проверка парковки</h2><div id="reviews" class="muted">Загрузка…</div>
  <h2>🛴 Активные поездки</h2><div id="rides" class="muted">Загрузка…</div>
  <h2>💰 Заявки на пополнение</h2><div id="topups" class="muted">Загрузка…</div>
  <h2>💬 Поддержка</h2><div id="support" class="muted">Загрузка…</div>
 
  <h2>🅿️ Официальные парковки</h2>
  <div class="muted" style="margin-bottom:8px">Нажмите на карту, чтобы выбрать центр парковки, задайте название и радиус. Зоны сразу появятся у пользователей.</div>
  <div id="pmap"></div>
  <div class="row" style="margin-bottom:10px">
    <input id="pname" placeholder="Название" style="flex:1;min-width:140px" />
    <input id="pr" type="number" value="30" min="5" max="500" style="width:90px" title="Радиус, м" />
    <button class="btn" onclick="addPark()">Добавить</button>
  </div>
  <div id="parks"></div>
  <button class="btn gray" onclick="exportParks()">Экспорт JSON</button>
  <div id="exportBox" style="display:none;margin-top:10px">
    <div class="muted">Вставьте это в Render → Environment → PARKINGS, чтобы парковки не пропадали при перезапуске сервера:</div>
    <textarea id="exportText" readonly></textarea>
  </div>
</div>
 
<script>
var $ = function (id) { return document.getElementById(id); };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
var CODE = sessionStorage.getItem('skyy_admin') || '', timer = null, pmap = null, tmp = null, parkLayer = null, parks = [];
 
function api(path, method, body) {
  return fetch(path, { method: method || 'GET', headers: { 'Content-Type': 'application/json', 'x-admin-code': CODE }, body: body ? JSON.stringify(body) : undefined })
    .then(function (r) {
      if (r.status === 401 || r.status === 429) {
        return r.json().catch(function () { return {}; }).then(function (j) { var e = new Error(j.error || 'Нет доступа'); e.auth = true; throw e; });
      }
      return r.json().catch(function () { return {}; });
    });
}
function doLogin() {
  CODE = $('code').value.trim();
  api('/api/admin/login', 'POST', {}).then(function () { sessionStorage.setItem('skyy_admin', CODE); start(); })
    .catch(function (e) { $('loginErr').textContent = e.message; $('code').value = ''; });
}
function logout() { sessionStorage.removeItem('skyy_admin'); CODE = ''; clearInterval(timer); location.reload(); }
function start() {
  $('login').style.display = 'none'; $('main').style.display = 'block';
  initMap(); loadAll(); loadParks(); timer = setInterval(loadAll, 6000);
}
 
/* ---- Проверка фото ---- */
function loadReviews() {
  return api('/api/admin/reviews').then(function (data) {
    $('reviews').innerHTML = data.length ? data.map(function (r) {
      var badge = r.inZone === true ? '<span class="badge ok">В зоне парковки: ' + esc(r.zone) + '</span>'
        : r.inZone === false ? '<span class="badge bad">Вне парковки</span>' : '<span class="badge na">Парковки не заданы</span>';
      var link = r.lat != null ? '<a target="_blank" rel="noopener" href="https://yandex.ru/maps/?pt=' + r.lng + ',' + r.lat + '&z=18&l=map">Открыть на карте</a>' : '';
      return '<div class="card"><div class="row"><div><b>' + esc(r.scooterId) + '</b> · ' + esc(r.username) + '<br><span class="muted">' + esc(r.time) + '</span></div>' + badge + '</div>'
        + '<img class="photo" src="' + r.photo + '" onclick="this.classList.toggle(\'big\')" alt="Фото самоката" />'
        + '<div class="row"><div>' + link + '</div><div style="display:flex;gap:8px">'
        + '<button class="btn" onclick="approve(\'' + esc(r.id) + '\')">Принять и завершить</button>'
        + '<button class="btn red" onclick="reject(\'' + esc(r.id) + '\')">Переставить</button></div></div></div>';
    }).join('') : 'Нет заявок';
  });
}
function approve(id) { api('/api/admin/review-approve', 'POST', { id: id }).then(function () { loadReviews(); loadRides(); }); }
function reject(id) {
  var c = prompt('Что нужно исправить?', 'Переставьте самокат на официальную парковку и пристегните к металлической ограде');
  if (c === null) return;
  api('/api/admin/review-reject', 'POST', { id: id, comment: c }).then(function () { loadReviews(); loadRides(); });
}
 
/* ---- Поездки ---- */
function loadRides() {
  return api('/api/admin/rides').then(function (data) {
    var st = { pending: 'фото на проверке', rejected: 'нужно переставить' };
    $('rides').innerHTML = data.length ? data.map(function (r) {
      var min = Math.floor((Date.now() - r.startTime) / 60000);
      return '<div class="card row"><div><b>' + esc(r.scooterId) + '</b> · ' + esc(r.username) + '<br><span class="muted">' + esc(r.tariff) + ' · ' + min + ' мин' + (r.paused ? ' · пауза' : '') + (r.review ? ' · ' + st[r.review] : '') + '</span></div></div>';
    }).join('') : 'Нет активных поездок';
  });
}
 
/* ---- Пополнения ---- */
function loadTopups() {
  return api('/api/admin/topups').then(function (data) {
    $('topups').innerHTML = data.length ? data.map(function (i) {
      return '<div class="card row"><div><b>' + esc(i.username) + '</b><br><span style="color:#22c55e;font-size:20px">' + esc(i.amount) + ' ₽</span></div>'
        + '<div style="display:flex;gap:8px"><button class="btn" onclick="topup(\'confirm\',\'' + esc(i.id) + '\')">Подтвердить</button>'
        + '<button class="btn red" onclick="topup(\'reject\',\'' + esc(i.id) + '\')">Отклонить</button></div></div>';
    }).join('') : 'Нет активных заявок';
  });
}
function topup(kind, id) { api('/api/admin/' + kind + '-topup', 'POST', { id: id }).then(loadTopups); }
 
/* ---- Поддержка ---- */
function loadSupport() {
  if (document.activeElement && $('support').contains(document.activeElement)) return Promise.resolve();
  return api('/api/admin/support').then(function (data) {
    $('support').innerHTML = data.length ? data.slice().reverse().map(function (i) {
      return '<div class="card"><div class="muted">' + esc(i.time) + '</div><b>' + esc(i.username) + '</b><div style="margin-top:4px">' + esc(i.message) + '</div>'
        + (i.reply ? '<div style="margin-top:8px;color:#22c55e;border-left:3px solid #22c55e;padding-left:10px">Ответ: ' + esc(i.reply) + '</div>'
          : '<div class="reply"><input id="rp_' + esc(i.id) + '" placeholder="Ответ…" /><button class="btn" onclick="reply(\'' + esc(i.id) + '\')">Ответить</button></div>')
        + '</div>';
    }).join('') : 'Нет сообщений';
  });
}
function reply(id) {
  var v = $('rp_' + id).value.trim(); if (!v) return;
  api('/api/admin/reply', 'POST', { id: id, reply: v }).then(function () { document.activeElement.blur(); loadSupport(); });
}
 
function loadAll() {
  Promise.all([loadReviews(), loadRides(), loadTopups(), loadSupport()]).catch(function (e) { if (e.auth) logout(); });
}
 
/* ---- Парковки ---- */
function initMap() {
  if (pmap) return;
  pmap = L.map('pmap').setView([55.75, 37.61], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(pmap);
  parkLayer = L.layerGroup().addTo(pmap);
  pmap.on('click', function (e) {
    if (tmp) pmap.removeLayer(tmp);
    tmp = L.circle(e.latlng, { radius: +$('pr').value || 30, color: '#ff5a1f', fillOpacity: .25 }).addTo(pmap);
  });
  $('pr').oninput = function () { if (tmp) tmp.setRadius(+$('pr').value || 30); };
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(function (p) { pmap.setView([p.coords.latitude, p.coords.longitude], 15); });
}
function loadParks() {
  return fetch('/api/parkings').then(function (r) { return r.json(); }).then(function (data) {
    parks = data; parkLayer.clearLayers();
    parks.forEach(function (p) { L.circle([p.lat, p.lng], { radius: p.r, color: '#3b82f6', fillOpacity: .2 }).bindTooltip(p.name).addTo(parkLayer); });
    $('parks').innerHTML = parks.length ? parks.map(function (p) {
      return '<div class="card row"><div><b>' + esc(p.name) + '</b><br><span class="muted">' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + ' · ' + p.r + ' м</span></div>'
        + '<button class="btn red" onclick="delPark(\'' + esc(p.id) + '\')">Удалить</button></div>';
    }).join('') : '<div class="muted">Парковок пока нет</div>';
  });
}
function addPark() {
  if (!tmp) return alert('Сначала нажмите на карту');
  var c = tmp.getLatLng();
  api('/api/admin/parkings', 'POST', { name: $('pname').value.trim() || 'Парковка', lat: c.lat, lng: c.lng, r: +$('pr').value || 30 }).then(function () {
    pmap.removeLayer(tmp); tmp = null; $('pname').value = ''; loadParks();
  });
}
function delPark(id) { if (confirm('Удалить парковку?')) api('/api/admin/parkings/' + id, 'DELETE').then(loadParks); }
function exportParks() {
  $('exportText').value = JSON.stringify(parks.map(function (p) { return { name: p.name, lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), r: p.r }; }));
  $('exportBox').style.display = 'block';
}
 
if (CODE) api('/api/admin/login', 'POST', {}).then(start).catch(function () { sessionStorage.removeItem('skyy_admin'); });
</script>
</body>
</html>
`;
 
// ---------- 6. Поддержка / пополнения / парковки в админке ----------
app.get('/admin', (req, res) => res.send(ADMIN_HTML));
 
app.get('/api/admin/reviews', (req, res) =>
  res.json(Object.values(reviews).sort((a, b) => a.requestedAt - b.requestedAt)));
 
app.post('/api/admin/review-approve', (req, res) => {
  const rv = reviews[req.body.id];
  if (!rv) return res.status(404).json({ error: 'Заявка не найдена' });
  if (rides[rv.scooterId]) finalizeRide(rv.scooterId, rv.requestedAt); // считаем до момента отправки фото
  delete reviews[rv.id];
  res.json({ success: true });
});
 
app.post('/api/admin/review-reject', (req, res) => {
  const rv = reviews[req.body.id];
  if (!rv) return res.status(404).json({ error: 'Заявка не найдена' });
  const ride = rides[rv.scooterId];
  if (ride) ride.review = { status: 'rejected', comment: String(req.body.comment || '').slice(0, 300) };
  delete reviews[rv.id];
  res.json({ success: true });
});
 
app.get('/api/admin/rides', (req, res) =>
  res.json(Object.keys(rides).map(id => ({
    scooterId: id, username: rides[id].username, tariff: rides[id].tariff, startTime: rides[id].startTime,
    paused: rides[id].paused, review: rides[id].review ? rides[id].review.status : null
  }))));
 
app.get('/api/admin/topups', (req, res) => res.json(Object.values(pendingTopups)));
app.post('/api/admin/confirm-topup', (req, res) => {
  const topup = pendingTopups[req.body.id];
  if (topup && users[topup.username]) users[topup.username].balance += topup.amount;
  delete pendingTopups[req.body.id];
  res.send('OK');
});
app.post('/api/admin/reject-topup', (req, res) => { delete pendingTopups[req.body.id]; res.send('OK'); });
 
app.get('/api/admin/support', (req, res) => res.json(supportTickets));
app.post('/api/admin/reply', (req, res) => {
  const ticket = supportTickets.find(t => t.id === req.body.id);
  if (ticket) ticket.reply = req.body.reply;
  res.send('OK');
});
 
app.post('/api/admin/parkings', (req, res) => {
  const lat = +req.body.lat, lng = +req.body.lng, r = Math.min(500, Math.max(5, +req.body.r || 30));
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'Неверные координаты' });
  parkings.push({ id: Date.now().toString(), name: String(req.body.name || 'Парковка').slice(0, 80), lat, lng, r });
  res.json({ success: true });
});
app.delete('/api/admin/parkings/:id', (req, res) => {
  parkings = parkings.filter(p => p.id !== req.params.id);
  res.json({ success: true });
});
 
// ---------- 7. Трекер ----------
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Skyy Tracker</title></head>
    <body style="text-align:center;padding:50px 16px 0;font-family:sans-serif;">
      <h2 style="color:#0ea5e9;">Skyy Tracker</h2>
      <p id="gpsStatus" style="font-size:20px;font-weight:bold;color:#f59e0b;">Ожидание GPS...</p>
      <p id="idLabel" style="color:#888;"></p>
      <button id="sndBtn" onclick="enableSound()" style="font-size:18px;font-weight:bold;padding:16px 24px;border:none;border-radius:14px;background:#ff5a1f;color:#fff;">Включить звук и не гасить экран</button>
      <p id="sndOk" style="display:none;color:#22c55e;font-weight:bold;">Звук включён. Оставьте страницу открытой.</p>
      <p id="ringMsg" style="font-size:28px;font-weight:bold;color:#ef4444;"></p>
      <script>
        const API = location.origin;
        let ID = localStorage.getItem('skyy_id') || 'Skyy-' + Math.floor(1000 + Math.random() * 9000);
        localStorage.setItem('skyy_id', ID);
        document.getElementById('idLabel').innerText = 'ID: ' + ID;
 
        let ctx = null, ringing = false;
        function enableSound() {
          ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
          ctx.resume(); beep(0.2);
          document.getElementById('sndBtn').style.display = 'none';
          document.getElementById('sndOk').style.display = 'block';
          try { navigator.wakeLock.request('screen'); } catch (e) {}
        }
        // Звук воспроизводит пищалку из вашего видео: синус 4261 / 4507 Гц, 6 писков по 0,3 с,
        // затем восходящий «свист» 3500 -> 4700 Гц, пауза, цикл ~4,6 с
        function tone(t0, f1, f2, dur, vol) {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(f1, t0);
          if (f2 !== f1) o.frequency.linearRampToValueAtTime(f2, t0 + dur);
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.linearRampToValueAtTime(vol, t0 + 0.005);
          g.gain.setValueAtTime(vol, t0 + dur - 0.01);
          g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
          o.connect(g); g.connect(ctx.destination); o.start(t0); o.stop(t0 + dur + 0.02);
        }
        function playCycle(t0) {
          for (let i = 0; i < 6; i++) tone(t0 + i * 0.3, i % 2 ? 4507 : 4261, i % 2 ? 4507 : 4261, 0.23, 1);
          tone(t0 + 2.02, 3500, 4700, 0.38, 0.45);
        }
        function beep(d) { if (ctx) tone(ctx.currentTime, 4261, 4261, d, 0.8); }
        async function checkRing() {
          try {
            const r = await (await fetch(API + '/api/scooter/' + ID + '/ring')).json();
            if (r.ring && !ringing && ctx) {
              ringing = true;
              const t = ctx.currentTime + 0.05;
              playCycle(t); playCycle(t + 4.64);
              document.getElementById('ringMsg').innerText = '🔔 Звонок!';
              if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300, 800, 300, 150, 300, 150, 300]);
              setTimeout(() => { ringing = false; document.getElementById('ringMsg').innerText = ''; }, 10500);
            }
          } catch (e) {}
        }
        setInterval(checkRing, 2000);
 
        async function getBattery() {
          try { const b = await navigator.getBattery(); return Math.round(b.level * 100); } catch (e) { return 100; }
        }
        async function sendLocation() {
          const battery = await getBattery();
          navigator.geolocation.getCurrentPosition((pos) => {
            document.getElementById('gpsStatus').innerText = 'GPS OK: ' + pos.coords.latitude.toFixed(5);
            document.getElementById('gpsStatus').style.color = '#22c55e';
            fetch(API + '/api/scooter/location', {
              method: 'POST',
              headers: {'Content-Type': 'application/x-www-form-urlencoded'},
              body: 'id=' + ID + '&lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude + '&battery=' + battery
            });
          }, () => {
            document.getElementById('gpsStatus').innerText = 'Нет доступа к GPS';
            document.getElementById('gpsStatus').style.color = '#ef4444';
          }, { enableHighAccuracy: true });
        }
        setInterval(sendLocation, 5000); sendLocation();
      </script>
    </body></html>
  `);
});
 
// ---------- 8. Клиентское приложение ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
 
app.listen(process.env.PORT || 3000, () => console.log('Server running'));
