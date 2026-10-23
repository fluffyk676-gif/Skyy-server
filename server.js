const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== ВСТАВЬ СЮДА СВОИ КЛЮЧИ ЮKASSA =====
const YOOKASSA_SHOP_ID = "ТВОЙ_SHOP_ID";
const YOOKASSA_SECRET_KEY = "ТВОЙ_СЕКРЕТНЫЙ_КЛЮЧ";

const scooters = {};
const commandQueue = {};

app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon, battery, lock } = req.body;
  scooters[id] = { id, lat: parseFloat(lat), lng: parseFloat(lon), battery: parseInt(battery) || 100, lock: lock === '1', lastSeen: Date.now() };
  res.send('OK');
});

app.get('/api/scooters', (req, res) => {
  res.json(Object.values(scooters));
});

app.post('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = req.body.toString().toUpperCase() || req.body;
  commandQueue[id] = cmd;
  res.send('OK');
});

app.get('/api/scooter/:id/command', (req, res) => {
  const id = req.params.id;
  const cmd = commandQueue[id];
  delete commandQueue[id];
  res.send(cmd || '');
});

// ОПЛАТА ЮKASSA (РЕАЛЬНАЯ)
app.post('/api/pay', async (req, res) => {
  const { amount, description } = req.body;
  const idempotenceKey = uuidv4();

  try {
    const response = await axios.post('https://api.yookassa.ru/v3/payments', {
      amount: { value: `${amount}.00`, currency: "RUB" },
      capture: true,
      // Сюда вернется пользователь после оплаты
      confirmation: { type: "redirect", return_url: "https://skyy-server.onrender.com" },
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
    
    // Отдаем ссылку на страницу оплаты ЮKassa
    res.json({ confirmation_url: response.data.confirmation.confirmation_url });
  } catch (error) {
    console.error('ЮKassa Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Ошибка ЮKassa. Проверь ключи в коде.' });
  }
});

app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
