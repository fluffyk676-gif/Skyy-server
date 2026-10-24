const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const scooters = {};
const commandQueue = {};
const users = {}; // База пользователей (номер телефона: баланс)

// Очистка старых самокатов
setInterval(() => {
  const now = Date.now();
  for (let id in scooters) {
    if (now - scooters[id].lastSeen > 5 * 60 * 1000) delete scooters[id];
  }
}, 60000);

// 1. Прием координат
app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon, battery, lock } = req.body;
  if (id && lat && lon) {
    scooters[id] = { id, lat: parseFloat(lat), lng: parseFloat(lon), battery: parseInt(battery) || 100, lock: lock === '1', lastSeen: Date.now() };
  }
  res.send('OK');
});

// 2. Отдача списка самокатов
app.get('/api/scooters', (req, res) => {
  res.json(Object.values(scooters));
});

// 3. Команды для самокатов
app.post('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = req.body.toString().toUpperCase() || req.body;
  if (cmd) commandQueue[id] = cmd;
  res.send('OK');
});

app.get('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = commandQueue[id];
  if (cmd) { delete commandQueue[id]; res.send(cmd); } else { res.send(''); }
});

// ==========================================
// 4. АВТОРИЗАЦИЯ И БАЛАНС
// ==========================================
app.post('/api/login', (req, res) => {
  const phone = req.body.phone;
  if (!users[phone]) {
    users[phone] = { phone: phone, balance: 0, inRide: false };
  }
  res.json(users[phone]);
});

app.post('/api/topup', (req, res) => {
  const { phone, amount } = req.body;
  if (users[phone]) {
    users[phone].balance += parseInt(amount);
    res.json(users[phone]);
  } else {
    res.status(404).send('User not found');
  }
});

// 5. Старт поездки (Списание 30 рублей)
app.post('/api/start-ride', (req, res) => {
  const { phone, scooterId } = req.body;
  const user = users[phone];
  
  if (!user) return res.status(400).json({ error: 'Нет аккаунта' });
  if (user.balance < 30) return res.status(400).json({ error: 'Недостаточно средств (нужно 30₽)' });

  user.balance -= 30; // Списываем старт
  user.inRide = true;
  commandQueue[scooterId] = 'START';
  
  res.json({ success: true, balance: user.balance });
});

// 6. Конец поездки (Расчет по минутам)
app.post('/api/end-ride', (req, res) => {
  const { phone, minutes } = req.body;
  const user = users[phone];
  
  if (!user) return res.status(400).json({ error: 'Нет аккаунта' });

  const cost = minutes * 7; // 7 рублей за минуту
  user.balance -= cost;
  user.inRide = false;

  res.json({ success: true, balance: user.balance, cost: cost });
});

// Трекер для iPad
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Skyy Tracker</title></head>
    <body style="text-align:center; padding-top:50px; font-family:sans-serif;" onclick="unlockAudio()">
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
        setInterval(sendLocation, 5000);
        sendLocation();
      </script>
    </body></html>
  `);
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
