const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const scooters = {};
let activeCommands = {}; // Теперь команды НЕ удаляются сразу

// Очистка старых самокатов
setInterval(() => {
  const now = Date.now();
  for (let id in scooters) {
    if (now - scooters[id].lastSeen > 2 * 60 * 1000) delete scooters[id];
  }
}, 60000);

// Прием координат
app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon } = req.body;
  if (id && lat && lon) {
    scooters[id] = { id, lat: parseFloat(lat), lng: parseFloat(lon), battery: 100, lastSeen: Date.now() };
  }
  res.send('OK');
});

// Отдача списка
app.get('/api/scooters', (req, res) => {
  res.json(Object.values(scooters));
});

// Прием команд
app.all('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  let cmd = req.body.toString().toUpperCase() || req.body;
  if (req.query.cmd) cmd = req.query.cmd.toUpperCase();

  if (cmd) {
    activeCommands[id] = cmd;
    console.log(`[CMD] Для ${id} установлена: ${cmd}`);
  }
  res.send('OK');
});

// ТРЕКЕР ДЛЯ IPAD
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body{font-family:sans-serif;text-align:center;padding-top:50px;background:#f8fafc; transition: 0.3s;}
        .alarm { background: #ef4444 !important; color: white; }
        #cmdStatus { font-size: 24px; font-weight: bold; color: #ef4444; margin-top: 20px;}
      </style>
    </head>
    <body id="body" onclick="unlockAudio()">
      <h2 style="color:#0ea5e9;" id="title">Skyy Tracker (iPad)</h2>
      <p style="font-size:20px;color:#22c55e;" id="gpsStatus">Ожидание GPS...</p>
      <p id="cmdStatus">Проверка команд...</p>
      
      <script>
        const API = 'https://skyy-server.onrender.com';
        const ID = 'Skyy-iPad';
        let audioCtx = null;

        function unlockAudio() {
          if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            document.getElementById('title').innerText = "ЗВУК РАЗРЕШЕН!";
          }
        }

        function sendLocation() {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              document.getElementById('gpsStatus').innerText = 'GPS OK: ' + pos.coords.latitude.toFixed(5);
              fetch(API + '/api/scooter/location', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'id=' + ID + '&lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude
              });
            },
            (err) => { document.getElementById('gpsStatus').innerText = 'Ошибка GPS'; },
            { enableHighAccuracy: true, timeout: 10000 }
          );
        }
        setInterval(sendLocation, 5000);
        sendLocation();

        // ПРОВЕРКА КОМАНД
        function checkCommands() {
          fetch(API + '/api/scooter/' + ID + '/command')
            .then(r => r.text())
            .then(cmd => {
              if (cmd === 'CALL') {
                document.getElementById('cmdStatus').innerText = 'ПОЛУЧЕНА КОМАНДА: СИРЕНА! 🔔';
                document.getElementById('body').classList.add('alarm');
                
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
                setTimeout(() => {
                  document.getElementById('body').classList.remove('alarm');
                  document.getElementById('cmdStatus').innerText = 'Проверка команд...';
                }, 4000);
              }
            })
            .catch(e => {});
        }
        // Проверяем каждую секунду!
        setInterval(checkCommands, 1000); 
      </script>
    </body>
    </html>
  `);
});

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
