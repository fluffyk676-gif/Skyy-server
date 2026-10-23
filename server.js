const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const scooters = {};

// Прием координат (теперь работает и через POST, и через GET-ссылку)
app.all('/api/scooter/location', (req, res) => {
  const data = req.method === 'GET' ? req.query : req.body;
  const { id, lat, lon, battery, lock } = data;
  
  if (id && lat && lon) {
    scooters[id] = { 
      id, 
      lat: parseFloat(lat), 
      lng: parseFloat(lon), 
      battery: parseInt(battery) || 100, 
      lastSeen: Date.now() 
    };
    console.log(`[GPS] ${id}: ${lat}, ${lon}`);
  }
  res.send('OK');
});

app.get('/api/scooters', (req, res) => {
  res.json(Object.values(scooters));
});

// Остальное (оплата и т.д.) оставляем как было
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
