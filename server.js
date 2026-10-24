const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const scooters = {};
const commandQueue = {};
const users = {};
const pendingTopups = {}; 

// --- API СЕРВЕРА ---
app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon } = req.body;
  if (id && lat && lon) scooters[id] = { id, lat: parseFloat(lat), lng: parseFloat(lon), lastSeen: Date.now() };
  res.send('OK');
});

app.get('/api/scooters', (req, res) => res.json(Object.values(scooters)));

app.post('/api/login', (req, res) => {
  const phone = req.body.phone;
  if (!users[phone]) users[phone] = { phone, balance: 0 };
  res.json(users[phone]);
});

// Прием заявки на пополнение
app.post('/api/request-topup', (req, res) => {
  const { phone, amount } = req.body;
  const id = Date.now().toString();
  pendingTopups[id] = { id, phone, amount, status: 'pending' };
  console.log(`Новая заявка: ${phone} на ${amount} руб.`);
  res.json({ success: true });
});

// Старт/Конец поездки
app.post('/api/start-ride', (req, res) => {
  const { phone, scooterId } = req.body;
  const user = users[phone];
  if (!user || user.balance < 30) return res.status(400).json({ error: 'Мало средств (нужно 30₽)' });
  user.balance -= 30;
  commandQueue[scooterId] = 'START';
  res.json({ success: true, balance: user.balance });
});

app.post('/api/end-ride', (req, res) => {
  const { phone, minutes } = req.body;
  const user = users[phone];
  const cost = minutes * 7;
  user.balance -= cost;
  res.json({ balance: user.balance, cost });
});

// --- АДМИН-ПАНЕЛЬ ---
app.get('/admin', (req, res) => {
  let html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Skyy Admin</title>
  <style>body{font-family:sans-serif;padding:20px;background:#121212;color:#fff;} 
  .item{background:#1c1c1e;padding:15px;margin-bottom:10px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;}
  .btn{background:#22c55e;color:#fff;border:none;padding:12px 20px;border-radius:10px;cursor:pointer;font-weight:bold;font-size:14px;}
  .btn-red{background:#ef4444;}</style></head><body>
  <h1>Заявки на пополнение</h1><div id="list">Загрузка...</div>
  <script>
    async function load() {
      const r = await fetch('/api/admin/topups');
      const data = await r.json();
      if(data.length === 0) { document.getElementById('list').innerText = 'Нет активных заявок'; return; }
      document.getElementById('list').innerHTML = data.map(item => \`
        <div class="item">
          <div>
            <b>\${item.phone}</b><br>
            <span style="color:#22c55e;font-size:20px;">\${item.amount} ₽</span>
          </div>
          <div style="display:flex; gap:10px;">
            <button class="btn" onclick="confirm('\${item.id}', '\${item.phone}', \${item.amount})">Подтвердить</button>
            <button class="btn btn-red" onclick="reject('\${item.id}')">Отклонить</button>
          </div>
        </div>
      \`).join('');
    }
    
    async function confirm(id, phone, amount) {
      await fetch('/api/admin/confirm-topup', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ id, phone, amount })
      });
      load();
    }
    
    async function reject(id) {
      await fetch('/api/admin/reject-topup', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ id })
      });
      load();
    }
    
    load();
    setInterval(load, 3000);
  </script></body></html>`;
  res.send(html);
});

app.get('/api/admin/topups', (req, res) => res.json(Object.values(pendingTopups)));

app.post('/api/admin/confirm-topup', (req, res) => {
  const { id, phone, amount } = req.body;
  if (users[phone]) users[phone].balance += parseInt(amount);
  delete pendingTopups[id];
  res.send('OK');
});

app.post('/api/admin/reject-topup', (req, res) => {
  delete pendingTopups[req.body.id];
  res.send('OK');
});

// --- ТРЕКЕР ---
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
            fetch(API + '/api/scooter/location', {
              method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
              body: 'id=' + ID + '&lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude + '&battery=100'
            });
          }, (err) => {}, { enableHighAccuracy: true });
        }
        setInterval(sendLocation, 5000); sendLocation();
      </script>
    </body></html>
  `);
});

app.use(express.static(__dirname));
app.listen(process.env.PORT || 3000, () => console.log('Server running'));
