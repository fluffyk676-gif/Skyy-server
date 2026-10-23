const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Флаг для сирены
let isRinging = false;

// Прием координат
app.post('/api/scooter/location', (req, res) => {
  res.send('OK');
});

// Отдача списка (пустой, чтобы приложение не падало)
app.get('/api/scooters', (req, res) => {
  res.json([{ id: "Skyy-iPad", lat: 55.75, lng: 37.61, battery: 100 }]);
});

// Включить сирену (через POST)
app.all('/api/ring', (req, res) => {
  isRinging = true;
  console.log("СИРЕНА ВКЛЮЧЕНА!");
  res.send('OK');
});

// Проверка (iPad дергает этот адрес)
app.get('/api/check', (req, res) => {
  if (isRinging) {
    res.send('CALL');
    isRinging = false; // Сбрасываем после того, как отдали
  } else {
    res.send('WAIT');
  }
});

// Страница трекера
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { text-align: center; font-family: sans-serif; padding-top: 50px; transition: 0.3s; }
        .alarm { background: #ef4444; color: white; }
      </style>
    </head>
    <body id="body" onclick="unlockAudio()">
      <h1 id="title" style="color: #0ea5e9;">Skyy Tracker</h1>
      <h2 id="status" style="color: gray;">Ждем...</h2>
      <p style="color: #888;">(Нажми на экран, чтобы включить звук)</p>
      
      <script>
        let audioCtx = null;
        function unlockAudio() {
          if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            document.getElementById('title').innerText = "ЗВУК РАЗРЕШЕН";
            document.getElementById('title').style.color = "#22c55e";
          }
        }

        // Отправка GPS (чтобы сервер знал, что iPad жив)
        setInterval(() => {
          navigator.geolocation.getCurrentPosition(p => {
            fetch('https://skyy-server.onrender.com/api/scooter/location', {
              method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
              body: 'id=Skyy-iPad&lat=' + p.coords.latitude + '&lon=' + p.coords.longitude
            });
          });
        }, 5000);

        // Проверка команды раз в секунду
        setInterval(() => {
          fetch('https://skyy-server.onrender.com/api/check')
            .then(r => r.text())
            .then(cmd => {
              if (cmd === 'CALL') {
                document.getElementById('status').innerText = "СИРЕНА! 🔔";
                document.getElementById('status').style.color = "red";
                document.getElementById('body').classList.add('alarm');
                
                if (audioCtx) {
                  let osc = audioCtx.createOscillator();
                  osc.type = 'square';
                  osc.frequency.value = 880;
                  osc.connect(audioCtx.destination);
                  osc.start();
                  setTimeout(() => osc.stop(), 3000);
                }
                
                setTimeout(() => {
                  document.getElementById('status').innerText = "Ждем...";
                  document.getElementById('status').style.color = "gray";
                  document.getElementById('body').classList.remove('alarm');
                }, 4000);
              }
            })
            .catch(e => console.log("Ошибка сети"));
        }, 1000); // Каждую секунду
      </script>
    </body>
    </html>
  `);
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(process.env.PORT || 3000);
