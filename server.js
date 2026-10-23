const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const scooters = {};
const commandQueue = {};

// Очистка старых самокатов (фантомов)
setInterval(() => {
  const now = Date.now();
  for (let id in scooters) {
    if (now - scooters[id].lastSeen > 2 * 60 * 1000) delete scooters[id];
  }
}, 60000);

// Прием координат
app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon, battery, lock } = req.body;
  if (id && lat && lon) {
    scooters[id] = { id, lat: parseFloat(lat), lng: parseFloat(lon), battery: 100, lastSeen: Date.now() };
  }
  res.send('OK');
});

// Отдача списка
app.get('/api/scooters', (req, res) => {
  res.json(Object.values(scooters));
});

// Прием команд (и через POST, и через ссылку)
app.all('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  let cmd = req.body.toString().toUpperCase() || req.body;
  if (req.query.cmd) cmd = req.query.cmd.toUpperCase();

  if (cmd) {
    commandQueue[id] = cmd;
    console.log(`[CMD] ${id}: ${cmd}`);
  }
  res.send('OK');
});

// Страница Трекера для iPad
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body{font-family:sans-serif;text-align:center;padding-top:50px;background:#f8fafc; transition: background 0.3s;} .alarm { background: #ef4444 !important; color: white; }</style>
    </head>
    <body id="body" onclick="unlockAudio()">
      <h2 style="color:#0ea5e9;" id="title">Skyy Tracker (iPad)</h2>
      <p id="gpsStatus" style="font-size:20px;font-weight:bold;color:#f59e0b;">Ожидание GPS...</p>
      <p id="cmdStatus" style="font-size:18px;color:#64748b;margin-top:20px;">Проверка команд...</p>
      
      <script>
        const API = 'https://skyy-server.onrender.com';
        const ID = 'Skyy-iPad';
        let audioCtx = null;

        function unlockAudio() {
          if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            document.getElementById('title').innerText = "Звук разрешен!";
            document.getElementById('title').style.color = "#22c55e";
          }
        }

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
            (err) => { document.getElementById('gpsStatus').innerText = 'Ошибка GPS'; },
            { enableHighAccuracy: true, timeout: 10000 }
          );
        }
        setInterval(sendLocation, 5000);
        sendLocation();

        function checkCommands() {
          fetch(API + '/api/scooter/' + ID + '/command')
            .then(r => r.text())
            .then(cmd => {
              if (cmd === 'CALL') {
                document.getElementById('cmdStatus').innerText = 'СИРЕНА! 🔔';
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
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// Авто-пинг, чтобы сервер не засыпал на Render
setInterval(() => {
  axios.get('https://skyy-server.onrender.com/api/scooters').catch(() => {});
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
