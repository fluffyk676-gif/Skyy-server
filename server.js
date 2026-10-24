const express = require('express');
const cors = require('cors');
const path = require('path');
 
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
 
const scooters = {};
const users = {};
const pendingTopups = {};
const supportTickets = [];
const rides = {};
 
const TARIFFS = { minute: 30, '30min': 150, '60min': 250 }; // списание на старте
const PER_MINUTE = 7;
 
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
 
// только свободные и «живые» (были на связи за последние 2 минуты)
app.get('/api/scooters', (req, res) => {
  const now = Date.now();
  res.json(Object.values(scooters).filter(s => !rides[s.id] && now - s.lastSeen < 120000));
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
    id: Date.now().toString(),
    username: req.body.username,
    message: req.body.message,
    reply: null,
    time: new Date().toLocaleString('ru-RU')
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
  rides[scooterId] = { username, tariff, paidFor: cost, startTime: Date.now(), paused: false, pausedAt: 0, pausedMs: 0 };
  res.json({ success: true, balance: user.balance, ride: rides[scooterId] });
});
 
app.post('/api/toggle-pause', (req, res) => {
  const { username, scooterId } = req.body;
  const ride = rides[scooterId];
  if (!ride || ride.username !== username) return res.status(400).json({ error: 'Нет поездки' });
  if (!ride.paused) {
    ride.paused = true;
    ride.pausedAt = Date.now();
  } else {
    ride.pausedMs += Date.now() - ride.pausedAt;
    ride.paused = false;
    ride.pausedAt = 0;
  }
  res.json({ success: true, isPaused: ride.paused, pausedAt: ride.pausedAt, pausedMs: ride.pausedMs });
});
 
app.post('/api/end-ride', (req, res) => {
  const { username, scooterId } = req.body;
  const ride = rides[scooterId];
  if (!ride || ride.username !== username || !users[username])
    return res.status(400).json({ error: 'Поездка не найдена' });
 
  if (ride.paused) ride.pausedMs += Date.now() - ride.pausedAt;
  const minutes = Math.ceil((Date.now() - ride.startTime - ride.pausedMs) / 60000);
 
  let extraCost = 0;
  if (ride.tariff === 'minute') extraCost = Math.max(0, minutes * PER_MINUTE - ride.paidFor); // 30 ₽ уже списаны
  else extraCost = Math.max(0, minutes - (ride.tariff === '30min' ? 30 : 60)) * PER_MINUTE;   // сверх пакета
 
  users[username].balance -= extraCost;
  delete rides[scooterId];
  res.json({ success: true, balance: users[username].balance, extraCost });
});
 
// восстановление активной поездки после перезагрузки страницы
app.get('/api/my-ride/:username', (req, res) => {
  const id = Object.keys(rides).find(k => rides[k].username === req.params.username);
  res.json(id ? { scooterId: id, ride: rides[id] } : {});
});
 
// ---------- 6. Админ-панель ----------
app.get('/admin', (req, res) => {
  const html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Skyy Admin</title>
  <style>body{font-family:sans-serif;padding:20px;background:#121212;color:#fff;max-width:800px;margin:0 auto}
  h2{color:#0ea5e9;} .item{background:#1c1c1e;padding:15px;margin-bottom:10px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;}
  .btn{background:#22c55e;color:#fff;border:none;padding:10px 15px;border-radius:10px;cursor:pointer;font-weight:bold;font-size:14px;}
  .btn-red{background:#ef4444;}
  .ticket{background:#2d2d2d;padding:15px;border-radius:10px;margin-bottom:15px;text-align:left;}
  .reply-box{display:flex;gap:10px;margin-top:10px;width:100%;}
  .reply-input{flex:1;padding:10px;border-radius:8px;border:none;background:#121212;color:#fff;box-sizing:border-box;}
  .refresh{background:#0ea5e9;margin-bottom:20px;width:100%;}</style></head><body>
 
  <button class="btn refresh" onclick="loadAll()">🔄 Обновить данные</button>
  <h2>💰 Заявки на пополнение</h2><div id="topups">Загрузка...</div>
  <hr style="margin:30px 0;border-color:#333;">
  <h2>💬 Поддержка</h2><div id="support">Загрузка...</div>
 
  <script>
    function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
 
    async function loadTopups() {
      const r = await fetch('/api/admin/topups');
      const data = await r.json();
      if (data.length === 0) { document.getElementById('topups').innerText = 'Нет активных заявок'; return; }
      document.getElementById('topups').innerHTML = data.map(item => \`
        <div class="item">
          <div><b>Логин: \${esc(item.username)}</b><br><span style="color:#22c55e;font-size:20px;">\${esc(item.amount)} ₽</span></div>
          <div style="display:flex;gap:10px;">
            <button class="btn" onclick="confirmTopup('\${esc(item.id)}')">Подтвердить</button>
            <button class="btn btn-red" onclick="rejectTopup('\${esc(item.id)}')">Отклонить</button>
          </div>
        </div>
      \`).join('');
    }
 
    async function loadSupport() {
      const r = await fetch('/api/admin/support');
      const data = await r.json();
      if (data.length === 0) { document.getElementById('support').innerText = 'Нет сообщений'; return; }
      document.getElementById('support').innerHTML = data.slice().reverse().map(item => \`
        <div class="ticket">
          <div style="font-size:12px;color:#888;">\${esc(item.time)}</div>
          <b>От: \${esc(item.username)}</b>
          <div style="margin-top:5px;font-size:16px;">\${esc(item.message)}</div>
          \${item.reply ? \`<div style="margin-top:10px;color:#22c55e;border-left:3px solid #22c55e;padding-left:10px;">Ответ: \${esc(item.reply)}</div>\` : \`
            <div class="reply-box">
              <input type="text" id="reply_\${esc(item.id)}" class="reply-input" placeholder="Написать ответ...">
              <button class="btn" onclick="sendReply('\${esc(item.id)}')">Ответить</button>
            </div>
          \`}
        </div>
      \`).join('');
    }
 
    async function loadAll() { await loadTopups(); await loadSupport(); }
    async function post(url, body) {
      await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
    }
    async function sendReply(id) {
      const input = document.getElementById('reply_' + id);
      if (!input.value) return;
      await post('/api/admin/reply', { id, reply: input.value });
      loadAll();
    }
    async function confirmTopup(id) { await post('/api/admin/confirm-topup', { id }); loadTopups(); }
    async function rejectTopup(id) { await post('/api/admin/reject-topup', { id }); loadTopups(); }
    loadAll();
  </script></body></html>`;
  res.send(html);
});
 
app.get('/api/admin/topups', (req, res) => res.json(Object.values(pendingTopups)));
 
app.post('/api/admin/confirm-topup', (req, res) => {
  const topup = pendingTopups[req.body.id];
  if (topup && users[topup.username]) users[topup.username].balance += topup.amount; // берём данные с сервера, а не из запроса
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
 
// ---------- 7. Трекер (открывается на телефоне, установленном на самокат) ----------
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="text-align:center;padding-top:50px;font-family:sans-serif;">
      <h2 style="color:#0ea5e9;">Skyy Tracker</h2>
      <p id="gpsStatus" style="font-size:20px;font-weight:bold;color:#f59e0b;">Ожидание GPS...</p>
      <p id="idLabel" style="color:#888;"></p>
      <script>
        const API = location.origin;
        let ID = localStorage.getItem('skyy_id') || 'Skyy-' + Math.floor(1000 + Math.random() * 9000);
        localStorage.setItem('skyy_id', ID);
        document.getElementById('idLabel').innerText = 'ID: ' + ID;
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
// Отдаём только index.html, а не всю папку, чтобы server.js и package.json не были доступны по ссылке
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
 
app.listen(process.env.PORT || 3000, () => console.log('Server running'));
