const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const scooters = {};
const commandQueue = {};

// Прием координат от самокатов (Meizu)
app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon, battery, lock } = req.body;
  if (id && lat && lon) {
    scooters[id] = { 
      id, 
      lat: parseFloat(lat), 
      lng: parseFloat(lon), 
      battery: parseInt(battery) || 100, 
      lock: lock === '1', 
      lastSeen: Date.now() 
    };
    console.log(`[GPS] ${id}: ${lat}, ${lon}`);
  }
  res.send('OK');
});

// Отдача списка самокатов в HTML
app.get('/api/scooters', (req, res) => {
  res.json(Object.values(scooters));
});

// Прием команд (START, STOP, CALL)
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

// ==========================================
// СТРАНИЦА ДЛЯ MEIZU (ТОЛЬКО РЕАЛЬНЫЙ GPS)
// ==========================================
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family:sans-serif; text-align:center; padding-top:50px; background:#fff;">
      <h2 style="color:#0ea5e9;">Skyy Tracker</h2>
      <p id="status" style="font-size:20px; font-weight:bold; color:#f59e0b;">Ожидание GPS...</p>
      <p style="color:#666; font-size:14px;">Не закрывайте эту страницу</p>
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
                .then(() => {
                  document.getElementById('status').innerText = 'GPS OK: ' + lat.toFixed(5);
                  document.getElementById('status').style.color = '#22c55e';
                })
                .catch(e => {
                  document.getElementById('status').innerText = 'Ошибка сети';
                  document.getElementById('status').style.color = '#ef4444';
                });
              },
              (err) => {
                document.getElementById('status').innerText = 'Ошибка GPS: ' + err.message;
                document.getElementById('status').style.color = '#ef4444';
              },
              { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
            );
          }
        }
        
        setInterval(sendLocation, 5000);
        sendLocation();
      </script>
    </body>
    </html>
  `);
});

// Раздача сайта
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
