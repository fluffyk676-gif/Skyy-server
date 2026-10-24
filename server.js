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
const supportTickets = []; // База сообщений в поддержку

// 1. Прием координат
app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon } = req.body;
  if (id && lat && lon) scooters[id] = { id, lat: parseFloat(lat), lng: parseFloat(lon), lastSeen: Date.now() };
  res.send('OK');
});

// 2. Список самокатов
app.get('/api/scooters', (req, res) => res.json(Object.values(scooters)));

// 3. РЕГИСТРАЦИЯ
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.status(400).json({ error: 'Этот логин уже занят' });
  users[username] = { username, password, balance: 0, email: '' };
  res.json({ success: true, user: users[username] });
});

// 4. ВХОД
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
  if (user.password !== password) return res.status(400).json({ error: 'Неверный пароль' });
  res.json({ success: true, user });
});

// 5. СМЕНА ПАРОЛЯ / ПОЧТЫ
app.post('/api/update-profile', (req, res) => {
  const { username, newPassword, newEmail } = req.body;
  const user = users[username];
  if (!user) return res.status(400).json({ error: 'Нет юзера' });
  
  if (newPassword) user.password = newPassword;
  if (newEmail) user.email = newEmail;
  res.json({ success: true, user });
});

// 6. ПОДДЕРЖКА
app.post('/api/support', (req, res) => {
  const { username, message } = req.body;
  supportTickets.push({ id: Date.now().toString(), username, message, time: new Date().toLocaleString() });
  res.json({ success: true });
});

// 7. Пополнение
app.post('/api/request-topup', (req, res) => {
  const { username, amount } = req.body;
  const id = Date.now().toString();
  pendingTopups[id] = { id, username, amount };
  res.json({ success: true });
});

// 8. Поездки
app.post('/api/start-ride', (req, res) => {
  const { username, scooterId } = req.body;
  const user = users[username];
  if (!user || user.balance < 30) return res.status(400).json({ error: 'Мало средств (нужно 30₽)' });
  user.balance -= 30;
  res.json({ success: true, balance: user.balance });
});

app.post('/api/end-ride', (req, res) => {
  const { username, minutes } = req.body;
  const user = users[username];
  const cost = minutes * 7;
  user.balance -= cost;
  res.json({ balance: user.balance, cost });
});

// 9. АДМИН-ПАНЕЛЬ (Заявки и Поддержка)
app.get('/admin', (req, res) => {
  let html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Skyy Admin</title>
  <style>body{font-family:sans-serif;padding:20px;background:#121212;color:#fff;} 
  h2{color:#0ea5e9;} .item{background:#1c1c1e;padding:15px;margin-bottom:10px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;}
  .btn{background:#22c55e;color:#fff;border:none;padding:12px 20px;border-radius:10px;cursor:pointer;font-weight:bold;font-size:14px;}
  .btn-red{background:#ef4444;} .ticket{background:#2d2d2d;padding:10px;border-radius:8px;margin-bottom:10px;}</style></head><body>
  
  <h2>💰 Заявки на пополнение</h2><div id="topups">Загрузка...</div>
  
  <hr style="margin:30px 0; border-color:#333;">
  
  <h2>💬 Сообщения в поддержку</h2><div id="support">Загрузка...</div>

  <script>
    // Загрузка пополнений
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
    
    // Загрузка поддержки
    async function loadSupport() {
      const r = await fetch('/api/admin/support');
      const data = await r.json();
      if(data.length === 0) { document.getElementById('support').innerText = 'Нет сообщений'; return; }
      document.getElementById('support').innerHTML = data.map(item => \`
        <div class="ticket">
          <div style="font-size:12px; color:#888;">\${item.time}</div>
          <b>От: \${item.username}</b>
          <div style="margin-top:5px; font-size:16px;">\${item.message}</div>
        </div>
      \`).join('');
    }

    async function confirmTopup(id, username, amount) {
      await fetch('/api/admin/confirm-topup', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ id, username, amount }) });
      loadTopups();
    }
    async function rejectTopup(id) {
      await fetch('/api/admin/reject-topup', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ id }) });
      loadTopups();
    }
    
    loadTopups(); loadSupport();
    setInterval(loadTopups, 3000);
    setInterval(loadSupport, 3000);
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
