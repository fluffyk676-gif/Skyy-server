const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// База данных в памяти (для реального проекта замени на MongoDB/PostgreSQL)
const scooters = {};
const commandQueue = {};

// Автоочистка самокатов, которые не выходят на связь > 5 минут (чтобы не было фантомов)
setInterval(() => {
  const now = Date.now();
  for (let id in scooters) {
    if (now - scooters[id].lastSeen > 5 * 60 * 1000) {
      delete scooters[id];
      console.log(`[Очистка] Удален ${id}`);
    }
  }
}, 60000);

// ==========================================
// 1. ПРИЕМ ДАННЫХ ОТ IoT-МОДУЛЯ (Arduino/iPad)
// ==========================================
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

// ==========================================
// 2. ОТДАЧА СПИСКА САМОКАТОВ В ПРИЛОЖЕНИЕ
// ==========================================
app.get('/api/scooters', (req, res) => {
  res.json(Object.values(scooters));
});

// ==========================================
// 3. ПРИЕМ КОМАНД ОТ ПРИЛОЖЕНИЯ (START, STOP, CALL)
// ==========================================
app.post('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = req.body.toString().toUpperCase() || req.body;
  
  if (cmd) {
    commandQueue[id] = cmd;
    console.log(`[CMD] Для ${id}: ${cmd}`);
  }
  res.send('OK');
});

// ==========================================
// 4. ВЫДАЧА КОМАНД ДЛЯ IoT-МОДУЛЯ (Arduino/iPad)
// ==========================================
app.get('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = commandQueue[id];
  
  if (cmd) {
    delete commandQueue[id]; // Удаляем после выдачи, чтобы не выполнялась дважды
    res.send(cmd);
  } else {
    res.send(''); // Если команд нет, отдаем пустоту
  }
});

// ==========================================
// РАЗДАЧА СТАТИКИ (index.html)
// ==========================================
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[IoT Server] Запущен на порту ${PORT}`));
