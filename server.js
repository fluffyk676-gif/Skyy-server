// Страница-трекер для старого телефона
app.get('/tracker.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>Трекер</title></head>
    <body style="font-family:sans-serif; text-align:center; padding-top:50px;">
      <h2>Трекер активен</h2>
      <p id="status">Ожидание GPS...</p>
      <script>
        const API = 'https://skyy-server.onrender.com/api/scooter/location';
        setInterval(() => {
          navigator.geolocation.getCurrentPosition((pos) => {
            const lat = pos.coords.latitude;
            const lon = pos.coords.longitude;
            fetch(API, {
              method: 'POST',
              headers: {'Content-Type': 'application/x-www-form-urlencoded'},
              body: `id=Skyy-Meizu&lat=${lat}&lon=${lon}&battery=100&lock=0`
            }).then(() => {
              document.getElementById('status').innerText = 'Отправлено: ' + lat + ', ' + lon;
            }).catch(e => {
              document.getElementById('status').innerText = 'Ошибка сети';
            });
          }, (err) => {
            document.getElementById('status').innerText = 'Разрешите геолокацию в браузере!';
          }, { enableHighAccuracy: true });
        }, 5000); // Отправляем каждые 5 секунд
      </script>
    </body>
    </html>
  `);
});
