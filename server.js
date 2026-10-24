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
const rides = {}; // Активные поездки

// 1. Прием координат
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

app.get('/api/scooters', (req, res) => res.json(Object.values(scooters)));

// 2. Аккаунты
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.status(400).json({ error: 'Логин занят' });
  users[username] = { username, password, balance: 0, email: '' };
  res.json({ success: true, user: users[username] });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.password !== password) return res.status(400).json({ error: 'Неверный логин или пароль' });
  res.json({ success: true, user });
});

app.post('/api/update-profile', (req, res) => {
  const { username, newPassword, newEmail } = req.body;
  const user = users[username];
  if (!user) return res.status(400).json({ error: 'Нет юзера' });
  if (newPassword) user.password = newPassword;
  if (newEmail) user.email = newEmail;
  res.json({ success: true, user });
});

// 3. Поддержка
app.post('/api/support', (req, res) => {
  supportTickets.push({ id: Date.now().toString(), username: req.body.username, message: req.body.message, reply: null, time: new Date().toLocaleString() });
  res.json({ success: true });
});
app.get('/api/support/:username', (req, res) => res.json(supportTickets.filter(t => t.username === req.params.username)));

// 4. Пополнение
app.post('/api/request-topup', (req, res) => {
  const id = Date.now().toString();
  pendingTopups[id] = { id, username: req.body.username, amount: req.body.amount };
  res.json({ success: true });
});

// 5. Поездки и тарифы
app.post('/api/start-ride', (req, res) => {
  const { username, scooterId, tariff } = req.body;
  const user = users[username];
  if (!user || user.balance < 30) return res.status(400).json({ error: 'Мало средств' });
  if (rides[scooterId]) return res.status(400).json({ error: 'Самокат уже занят!' });
  
  let cost = 0;
  if (tariff === 'minute') cost = 30;
  else if (tariff === '30min') cost = 150;
  else if (tariff === '60min') cost = 250;
  else if (tariff === 'unlimited') cost = 500;
  
  user.balance -= cost;
  rides[scooterId] = { username, tariff, startTime: Date.now(), isPaused: false, pauseStart: null };
  
  res.json({ success: true, balance: user.balance, ride: rides[scooterId] });
});

app.post('/api/toggle-pause', (req, res) => {
  const { username, scooterId } = req.body;
  const ride = rides[scooterId];
  if (!ride || ride.username !== username) return res.status(400).json({ error: 'Нет поездки' });

  if (ride.isPaused) {
    const pauseMins = Math.ceil((Date.now() - ride.pauseStart) / 60000);
    users[username].balance -= pauseMins * 3;
    ride.isPaused = false;
  } else {
    ride.isPaused = true;
    ride.pauseStart = Date.now();
  }
  res.json({ success: true, isPaused: ride.isPaused });
});

app.post('/api/end-ride', (req, res) => {
  const { username, scooterId } = req.body;
  const ride = rides[scooterId];
  if (!ride) return res.status(400).json({ error: 'Поездка не найдена' });
  
  const minutes = Math.ceil((Date.now() - ride.startTime) / 60000);
  let extraCost = 0;
  
  if (ride.tariff === 'minute') extraCost = minutes * 7;
  else if (ride.tariff === 'unlimited') extraCost = minutes * 5;
  
  if (ride.isPaused) extraCost += Math.ceil((Date.now() - ride.pauseStart) / 60000) * 3;
  
  users[username].balance -= extraCost;
  delete rides[scooterId];
  
  res.json({ success: true, balance: users[username].balance, extraCost });
});

// 6. АДМИН-ПАНЕЛЬ
app.get('/admin', (req, res) => {
  let html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Skyy Admin</title>
  <style>body{font-family:sans-serif;padding:20px;background:#121212;color:#fff;} 
  h2{color:#0ea5e9;} .item{background:#1c1c1e;padding:15px;margin-bottom:10px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;}
  .btn{background:#22c55e;color:#fff;border:none;padding:10px 15px;border-radius:10px;cursor:pointer;font-weight:bold;font-size:14px;}
  .btn-red{background:#ef4444;} 
  .ticket{background:#2d2d2d;padding:15px;border-radius:10px;margin-bottom:15px; text-align:left;}
  .reply-box{display:flex; gap:10px; margin-top:10px; width:100%;}
  .reply-input{flex:1; padding:10px; border-radius:8px; border:none; background:#121212; color:#fff; box-sizing:border-box;}
  .refresh{background:#0ea5e9; margin-bottom:20px; width:100%;}</style></head><body>
  
  <button class="btn refresh" onclick="loadAll()">🔄 Обновить данные</button>
  <h2>💰 Заявки на пополнение</h2><div id="topups">Загрузка...</div>
  <hr style="margin:30px 0; border-color:#333;">
  <h2>💬 Поддержка</h2><div id="support">Загрузка...</div>

  <script>
    async function loadTopups() {
      const r = await fetch('/api/admin/topups');
      const data = await r.json();
      if(data.length === 0) { document.getElementById('topups').innerText = 'Нет активных заявок'; return; }
      document.getElementById('topups').innerHTML = data.map(item => \`
        <div class="item">
          <div><b>Логин: \${item.username}</b><br><span style="color:#22c55e;font-size:20px;">\${item.amount} ₽</span></div>
          <div style="display:flex; gap:10px;">
            <button class="btn" onclick="confirmTopup('\${item.id}', '\${item.username}', \${item.amount})">Подтвердить</button>
            <button class="btn btn-red" onclick="rejectTopup('\${item.id}')">Отклонить</button>
          </div>
        </div>
      \`).join('');
    }
    
    async function loadSupport() {
      const r = await fetch('/api/admin/support');
      const data = await r.json();
      if(data.length === 0) { document.getElementById('support').innerText = 'Нет сообщений'; return; }
      document.getElementById('support').innerHTML = data.map(item => \`
        <div class="ticket">
          <div style="font-size:12px; color:#888;">\${item.time}</div>
          <b>От: \${item.username}</b>
          <div style="margin-top:5px; font-size:16px;">\${item.message}</div>
          \${item.reply ? \`<div style="margin-top:10px; color:#22c55e; border-left:3px solid #22c55e; padding-left:10px;">Ответ: \${item.reply}</div>\` : \`
            <div class="reply-box">
              <input type="text" id="reply_\${item.id}" class="reply-input" placeholder="Написать ответ...">
              <button class="btn" onclick="sendReply('\${item.id}')">Ответить</button>
            </div>
          \`}
        </div>
      \`).join('');
    }

    async function loadAll() { await loadTopups(); await loadSupport(); }

    async function sendReply(id) {
      const input = document.getElementById('reply_' + id);
      if(!input.value) return;
      await fetch('/api/admin/reply', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ id, reply: input.value }) });
      loadAll();
    }
    async function confirmTopup(id, username, amount) {
      await fetch('/api/admin/confirm-topup', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ id, username, amount }) });
      loadTopups();
    }
    async function rejectTopup(id) {
      await fetch('/api/admin/reject-topup', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ id }) });
      loadTopups();
    }
    loadAll();
  </script></body></html>`;
  res.send(html);
});

app.get('/api/admin/topups', (req, res) => res.json(Object.values(pendingTopups)));
app.post('/api/admin/confirm-topup', (req, res) => {
  const { id, username, amount } = req.body;
  if (users[username]) users[username].balance += parseInt(amount);
  delete pendingTopups[id];
  res.send('OK');
});
app.post('/api/admin/reject-topup', (req, res) => { delete pendingTopups[req.body.id]; res.send('OK'); });

app.get('/api/admin/support', (req, res) => res.json(supportTickets));
app.post('/api/admin/reply', (req, res) => {
  const ticket = supportTickets.find(t => t.id === req.body.id);
  if (ticket) ticket.reply = req.body.reply;
  res.send('OK');
});

// ТРЕКЕР
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="text-align:center; padding-top:50px; font-family:sans-serif;">
      <h2 style="color:#0ea5e9;">Skyy Tracker</h2>
      <p id="gpsStatus" style="font-size:20px; font-weight:bold; color:#f59e0b;">Ожидание GPS...</p>
      <script>
        const API = 'https://skyy-server.onrender.com';
        let ID = localStorage.getItem('skyy_id') || 'Skyy-' + Math.floor(1000 + Math.random() * 9000);
        localStorage.setItem('skyy_id', ID);
        function sendLocation() {
          navigator.geolocation.getCurrentPosition((pos) => {
            document.getElementById('gpsStatus').innerText = 'GPS OK: ' + pos.coords.latitude.toFixed(5);
            document.getElementById('gpsStatus').style.color = '#22c55e';
            fetch(API + '/api/scooter/location', { method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'id=' + ID + '&lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude + '&battery=100' });
          }, (err) => {}, { enableHighAccuracy: true });
        }
        setInterval(sendLocation, 5000); sendLocation();
      </script>
    </body></html>
  `);
});

app.use(express.static(__dirname));
app.listen(process.env.PORT || 3000, () => console.log('Server running'));
