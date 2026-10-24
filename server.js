const express = require('express');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const scooters = {};
const commandQueue = {};
const users = {};
const pendingTopups = {};

// === ТВОИ НАСТРОЙКИ ===
const BOT_TOKEN = "8481132005:AAE4BVZTHpoW1_LmciAoWKyDddzCAvLivCM";
const ADMIN_ID = 5832179468; 

// Запуск бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("Бот запущен!");

// Обработка кнопок от админа (тебя)
bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  
  if (chatId.toString() !== ADMIN_ID.toString()) return; // Только ты можешь нажимать

  if (data.startsWith('confirm_')) {
    const [_, phone, amount, topupId] = data.split('_');
    if (!users[phone]) users[phone] = { phone, balance: 0 };
    users[phone].balance += parseInt(amount);
    delete pendingTopups[topupId];
    
    bot.sendMessage(chatId, `✅ Баланс для ${phone} пополнен на ${amount} ₽.`);
    bot.editMessageText(`Пополнение ${phone} на ${amount} ₽: ПОДТВЕРЖДЕНО.`, { chat_id: chatId, message_id: query.message.message_id });
  }
  
  if (data.startsWith('reject_')) {
    const [_, phone, amount, topupId] = data.split('_');
    delete pendingTopups[topupId];
    bot.sendMessage(chatId, `❌ Пополнение для ${phone} отклонено.`);
    bot.editMessageText(`Пополнение ${phone} на ${amount} ₽: ОТКЛОНЕНО.`, { chat_id: chatId, message_id: query.message.message_id });
  }
});

// --- API СЕРВЕРА ---

// Прием координат
app.post('/api/scooter/location', (req, res) => {
  const { id, lat, lon } = req.body;
  if (id && lat && lon) scooters[id] = { id, lat: parseFloat(lat), lng: parseFloat(lon), lastSeen: Date.now() };
  res.send('OK');
});

// Список самокатов
app.get('/api/scooters', (req, res) => res.json(Object.values(scooters)));

// Вход в аккаунт
app.post('/api/login', (req, res) => {
  const phone = req.body.phone;
  if (!users[phone]) users[phone] = { phone, balance: 0 };
  res.json(users[phone]);
});

// Запрос на пополнение (клиент нажал "Я перевел")
app.post('/api/request-topup', (req, res) => {
  const { phone, amount } = req.body;
  const topupId = Date.now().toString();
  pendingTopups[topupId] = { phone, amount };
  
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Подтвердить", callback_data: `confirm_${phone}_${amount}_${topupId}` }],
        [{ text: "❌ Отклонить", callback_data: `reject_${phone}_${amount}_${topupId}` }]
      ]
    }
  };
  
  bot.sendMessage(ADMIN_ID, `💰 Запрос на пополнение!\nНомер: ${phone}\nСумма: ${amount} ₽\n\nПроверьте Сбер и подтвердите.`, opts);
  res.json({ success: true });
});

// Старт поездки
app.post('/api/start-ride', (req, res) => {
  const { phone, scooterId } = req.body;
  const user = users[phone];
  if (!user || user.balance < 30) return res.status(400).json({ error: 'Недостаточно средств (нужно 30₽)' });
  user.balance -= 30;
  commandQueue[scooterId] = 'START';
  res.json({ success: true, balance: user.balance });
});

// Конец поездки
app.post('/api/end-ride', (req, res) => {
  const { phone, minutes } = req.body;
  const user = users[phone];
  const cost = minutes * 7;
  user.balance -= cost;
  res.json({ balance: user.balance, cost });
});

// --- ТРЕКЕР ДЛЯ УСТРОЙСТВ ---
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="text-align:center; padding-top:50px; font-family:sans-serif;">
      <h2 style="color:#0ea5e9;">Skyy Tracker</h2>
      <p id="gpsStatus" style="font-size:20px; font-weight:bold; color:#f59e0b;">Ожидание GPS...</p>
      <script>
        const API = 'https://skyy-server.onrender.com';
        let ID = localStorage.getItem('skyy_id') || 'Skyy-' + Math.floor(1000 + Math.random() * 9000);
        localStorage.setItem('skyy_id', ID);
        function sendLocation() {
          navigator.geolocation.getCurrentPosition((pos) => {
            document.getElementById('gpsStatus').innerText = 'GPS OK: ' + pos.coords.latitude.toFixed(5);
            document.getElementById('gpsStatus').style.color = '#22c55e';
            fetch(API + '/api/scooter/location', {
              method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
              body: 'id=' + ID + '&lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude + '&battery=100'
            });
          }, (err) => {}, { enableHighAccuracy: true });
        }
        setInterval(sendLocation, 5000); sendLocation();
      </script>
    </body></html>
  `);
});

app.use(express.static(__dirname));
app.listen(process.env.PORT || 3000, () => console.log('Server running'));
