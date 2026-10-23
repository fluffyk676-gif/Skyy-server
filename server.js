const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const scooters = {};
const commandQueue = {};

// Прием координат
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

// Отдача списка
app.get('/api/scooters', (req, res) => {
  res.json(Object.values(scooters));
});

// Прием команд
app.post('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = req.body.toString().toUpperCase() || req.body;
  commandQueue[id] = cmd;
  console.log(`[CMD] ${id}: ${cmd}`);
  res.send('OK');
});

// Выдача команд
app.get('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = commandQueue[id];
  delete commandQueue[id];
  res.send(cmd || '');
});

// СТРАНИЦА ТРЕКЕРА ДЛЯ IPAD
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body{font-family:sans-serif;text-align:center;padding-top:50px;background:#f8fafc; transition: background 0.3s;}
        .alarm { background: #ef4444 !important; color: white; }
      </style>
    </head>
    <body id="body" onclick="unlockAudio()">
      <h2 style="color:#0ea5e9;" id="title">Skyy Tracker</h2>
      <p id="gpsStatus" style="font-size:20px;font-weight:bold;color:#f59e0b;">Ожидание GPS...</p>
      <p id="cmdStatus" style="font-size:18px;color:#64748b;margin-top:20px;">Проверка команд...</p>
      
      <script>
        const API = 'https://skyy-server.onrender.com';
        const ID = 'Skyy-iPad';
        let audioCtx = null;

        // Разблокировка звука при клике (требование Safari)
        function unlockAudio() {
          if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            document.getElementById('title').innerText = "Звук разрешен!";
            document.getElementById('title').style.color = "#22c55e";
          }
        }

        // Отправка GPS
        function sendLocation() {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              document.getElementById('gpsStatus').innerText = 'GPS OK: ' + pos.coords.latitude.toFixed(5);
              document.getElementById('gpsStatus').style.color = '#22c55e';
              fetch(API + '/api/scooter/location', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'id=' + ID + '&lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude + '&battery=100&lock=0'
              });
            },
            (err) => {
              document.getElementById('gpsStatus').innerText = 'Ошибка GPS: ' + err.message;
              document.getElementById('gpsStatus').style.color = '#ef4444';
            },
            { enableHighAccuracy: true, timeout: 10000 }
          );
        }
        setInterval(sendLocation, 5000);
        sendLocation();

        // Проверка команд
        function checkCommands() {
          fetch(API + '/api/scooter/' + ID + '/command')
            .then(r => r.text())
            .then(cmd => {
              if (cmd === 'CALL') {
                document.getElementById('cmdStatus').innerText = 'СИРЕНА! 🔔';
                document.getElementById('cmdStatus').style.color = '#fff';
                
                document.getElementById('body').classList.add('alarm');
                setTimeout(() => document.getElementById('body').classList.remove('alarm'), 3000);
                
                if (audioCtx) {
                  const osc = audioCtx.createOscillator();
                  const gain = audioCtx.createGain();
                  osc.connect(gain);
                  gain.connect(audioCtx.destination);
                  osc.type = 'square';
                  osc.frequency.value = 880;
                  gain.gain.value = 1;
                  osc.start();
                  setTimeout(() => osc.stop(), 3000);
                }
              } else if (cmd === 'START') {
                document.getElementById('cmdStatus').innerText = 'Самокат РАЗБЛОКИРОВАН';
                document.getElementById('cmdStatus').style.color = '#22c55e';
              } else if (cmd === 'STOP') {
                document.getElementById('cmdStatus').innerText = 'Самокат ЗАБЛОКИРОВАН';
                document.getElementById('cmdStatus').style.color = '#ef4444';
              }
            })
            .catch(e => {});
        }
        setInterval(checkCommands, 3000);
      </script>
    </body>
    </html>
  `);
});

app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
