const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== НАСТРОЙКИ ЮKASSA (Пока оставь так) =====
const YOOKASSA_SHOP_ID = "ТВОЙ_SHOP_ID";
const YOOKASSA_SECRET_KEY = "ТВОЙ_СЕКРЕТНЫЙ_КЛЮЧ";

const scooters = {};
const commandQueue = {};

// Прием координат от самокатов
app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon, battery, lock } = req.body;
  scooters[id] = { id, lat: parseFloat(lat), lng: parseFloat(lon), battery: parseInt(battery) || 100, lock: lock === '1', lastSeen: Date.now() };
  console.log(`[GPS] ${id}: ${lat}, ${lon}`);
  res.send('OK');
});

// Отдача списка самокатов в HTML
app.get('/api/scooters', (req, res) => {
  res.json(Object.values(scooters));
});

// Прием команд из HTML (START, STOP, CALL)
app.post('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = req.body.toString().toUpperCase() || req.body;
  commandQueue[id] = cmd;
  res.send('OK');
});

// Самокат забирает команду
app.get('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = commandQueue[id];
  delete commandQueue[id];
  res.send(cmd || '');
});

// Оплата ЮKassa
app.post('/api/pay', async (req, res) => {
  const { amount, description } = req.body;
  const idempotenceKey = uuidv4();

  try {
    const response = await axios.post('https://api.yookassa.ru/v3/payments', {
      amount: { value: `${amount}.00`, currency: "RUB" },
      capture: true,
      confirmation: { type: "redirect", return_url: "https://skyy-server.onrender.com" },
      description: description
    }, {
      headers: { 'Content-Type': 'application/json', 'Idempotence-Key': idempotenceKey },
      auth: { username: YOOKASSA_SHOP_ID, password: YOOKASSA_SECRET_KEY }
    });
    res.json({ confirmation_url: response.data.confirmation.confirmation_url });
  } catch (error) {
    console.error('Ошибка ЮKassa:', error.message);
    res.status(500).json({ error: 'Ошибка ЮKassa' });
  }
});

// ==========================================
// СТРАНИЦА ДЛЯ СТАРОГО ТЕЛЕФОНА (MEIZU)
// ==========================================
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Трекер</title></head>
    <body style="font-family:sans-serif; text-align:center; padding-top:50px; background:#f0f0f0;">
      <h2 style="color:#0ea5e9;">Skyy Tracker</h2>
      <p id="status" style="font-size:20px; font-weight:bold;">Ожидание GPS...</p>
      <div style="margin-top:20px; font-size:14px; color:#666;">Не закрывайте эту страницу</div>
      <script>
        const API = 'https://skyy-server.onrender.com/api/scooter/location';
        
        function sendLocation() {
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
              (pos) => {
                const lat = pos.coords.latitude;
                const lon = pos.coords.longitude;
                fetch(API, {
                  method: 'POST',
                  headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                  body: 'id=Skyy-Meizu&lat=' + lat + '&lon=' + lon + '&battery=100&lock=0'
                })
                .then(r => r.text())
                .then(t => {
                  document.getElementById('status').innerText = 'Отправлено! ' + lat.toFixed(5) + ', ' + lon.toFixed(5);
                  document.getElementById('status').style.color = '#22c55e';
                })
                .catch(e => {
                  document.getElementById('status').innerText = 'Ошибка сети...';
                });
              },
              (err) => {
                document.getElementById('status').innerText = 'Ошибка: Разрешите GPS в браузере!';
                document.getElementById('status').style.color = '#ef4444';
              },
              { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
            );
          }
        }
        
        sendLocation();
        setInterval(sendLocation, 5000);
      </script>
    </body>
    </html>
  `);
});

// Статические файлы и главная страница
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
