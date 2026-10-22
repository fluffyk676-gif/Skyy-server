const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== НАСТРОЙКИ ЮKASSA =====
// Пока оставь так. Когда зарегистрируешься в ЮKassa, вставишь свои ключи.
const YOOKASSA_SHOP_ID = "ТВОЙ_SHOP_ID";
const YOOKASSA_SECRET_KEY = "ТВОЙ_СЕКРЕТНЫЙ_КЛЮЧ";

// ===== БАЗА ДАННЫХ =====
const scooters = {};
const commandQueue = {};

// 1. Прием координат от самокатов (Meizu/Arduino)
app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon, battery, lock } = req.body;
  scooters[id] = { 
    id, 
    lat: parseFloat(lat), 
    lng: parseFloat(lon), 
    battery: parseInt(battery) || 100, 
    lock: lock === '1',
    lastSeen: Date.now()
  };
  console.log(`[GPS] ${id}: ${lat}, ${lon}`);
  res.send('OK');
});

// 2. Отдача списка самокатов в HTML
app.get('/api/scooters', (req, res) => {
  res.json(Object.values(scooters));
});

// 3. Прием команд из HTML (START, STOP, CALL)
app.post('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = req.body.toString().toUpperCase() || req.body;
  commandQueue[id] = cmd;
  console.log(`[CMD] Для ${id}: ${cmd}`);
  res.send('OK');
});

// 4. Самокат (телефон) забирает команду
app.get('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = commandQueue[id];
  delete commandQueue[id];
  res.send(cmd || '');
});

// 5. Оплата ЮKassa
app.post('/api/pay', async (req, res) => {
  const { amount, description } = req.body;
  const idempotenceKey = uuidv4();

  try {
    const response = await axios.post('https://api.yookassa.ru/v3/payments', {
      amount: { value: `${amount}.00`, currency: "RUB" },
      capture: true,
      confirmation: { type: "redirect", return_url: "https://example.com/success" },
      description: description
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotenceKey
      },
      auth: {
        username: YOOKASSA_SHOP_ID,
        password: YOOKASSA_SECRET_KEY
      }
    });
    res.json({ confirmation_url: response.data.confirmation.confirmation_url });
  } catch (error) {
    console.error('Ошибка ЮKassa:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Ошибка платежной системы (проверь ключи)' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
