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
const rides = {}; // Активные поездки (кто на чем едет)

// 1. Прием координат (обновляем статус самоката)
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

// 2. Список самокатов
app.get('/api/scooters', (req, res) => res.json(Object.values(scooters)));

// 3. Регистрация и Вход
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.status(400).json({ error: 'Логин занят' });
  users[username] = { username, password, balance: 0 };
  res.json({ success: true, user: users[username] });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.password !== password) return res.status(400).json({ error: 'Неверный логин или пароль' });
  res.json({ success: true, user });
});

app.post('/api/update-profile', (req, res) => {
  const { username, newPassword } = req.body;
  if (users[username] && newPassword) users[username].password = newPassword;
  res.json({ success: true, user: users[username] });
});

// 4. Поддержка
app.post('/api/support', (req, res) => {
  supportTickets.push({ id: Date.now().toString(), username: req.body.username, message: req.body.message, reply: null, time: new Date().toLocaleString() });
  res.json({ success: true });
});
app.get('/api/support/:username', (req, res) => res.json(supportTickets.filter(t => t.username === req.params.username)));

// 5. Пополнение
app.post('/api/request-topup', (req, res) => {
  const id = Date.now().toString();
  pendingTopups[id] = { id, username: req.body.username, amount: req.body.amount };
  res.json({ success: true });
});

// 6. СТАРТ ПОЕЗДКИ (с тарифами)
app.post('/api/start-ride', (req, res) => {
  const { username, scooterId, tariff } = req.body;
  const user = users[username];
  const scooter = scooters[scooterId];
  
  if (!user || user.balance < 30) return res.status(400).json({ error: 'Мало средств' });
  if (rides[scooterId]) return res.status(400).json({ error: 'Самокат уже занят!' }); // Блокировка занятых
  
  let cost = 0;
  if (tariff === 'minute') cost = 30; // 30 старт, потом по 7
  else if (tariff === '30min') cost = 150; // Фикс 30 мин
  else if (tariff === '60min') cost = 250; // Фикс час
  else if (tariff === 'unlimited') cost = 500; // Пока не сядет
  
  user.balance -= cost;
  rides[scooterId] = { username, tariff, startTime: Date.now(), isPaused: false, pauseStart: null };
  
  res.json({ success: true, balance: user.balance, ride: rides[scooterId] });
});

// 7. ПАУЗА / ПРОДОЛЖИТЬ / ФОНАРИК
app.post('/api/toggle-pause', (req, res) => {
  const { username, scooterId } = req.body;
  const ride = rides[scooterId];
  if (!ride || ride.username !== username) return res.status(400).json({ error: 'Нет поездки' });

  if (ride.isPaused) {
    // Снимаем с паузы
    const pauseMins = Math.ceil((Date.now() - ride.pauseStart) / 60000);
    users[username].balance -= pauseMins * 3; // Списываем за паузу по 3р
    ride.isPaused = false;
  } else {
    // Ставим на паузу
    ride.isPaused = true;
    ride.pauseStart = Date.now();
  }
  res.json({ success: true, isPaused: ride.isPaused });
});

app.post('/api/toggle-light', (req, res) => {
  // В реальности здесь мы бы отправляли команду на ESP32
  res.json({ success: true });
});

// 8. КОНЕЦ ПОЕЗДКИ
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

// 9. АДМИН-ПАНЕЛЬ (та же, без изменений)
app.get('/admin', (req, res) => { /* код админки из прошлого сообщения */ 
  let html = `<html><body style="background:#121212;color:#fff;font-family:sans-serif;padding:20px;"><h1>Админка</h1><a href="/" style="color:#0ea5e9">На главную</a></body></html>`;
  res.send(html);
});

// 10. ТРЕКЕР (без изменений)
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
