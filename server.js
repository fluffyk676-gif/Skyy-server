const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const scooters = {};
const commandQueue = {};

// Очистка старых самокатов
setInterval(() => {
  const now = Date.now();
  for (let id in scooters) {
    if (now - scooters[id].lastSeen > 5 * 60 * 1000) {
      delete scooters[id];
    }
  }
}, 60000);

// 1. Прием координат
app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon, battery, lock } = req.body;
  if (id && lat && lon) {
    scooters[id] = { id, lat: parseFloat(lat), lng: parseFloat(lon), battery: 100, lock: lock === '1', lastSeen: Date.now() };
  }
  res.send('OK');
});

// 2. Отдача списка в приложение
app.get('/api/scooters', (req, res) => {
  res.json(Object.values(scooters));
});

// 3. Прием команд из приложения
app.post('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = req.body.toString().toUpperCase() || req.body;
  if (cmd) {
    commandQueue[id] = cmd;
    console.log(`[CMD] Для ${id}: ${cmd}`);
  }
  res.send('OK');
});

// 4. Выдача команд для IoT-модуля (Arduino)
app.get('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = commandQueue[id];
  if (cmd) {
    delete commandQueue[id];
    res.send(cmd);
  } else {
    res.send('');
  }
});

app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
