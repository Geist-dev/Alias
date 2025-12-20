# Alias ("Шляпа") — Discord Activity (мультиплеер)

Это готовый минимальный проект: **один сервер Node.js + фронтенд**, который работает как обычный сайт и как Discord Activity.
Состояние игры синхронизируется через WebSocket.

## Быстрый старт локально
1) Установи Node.js 18+
2) В папке проекта:
```bash
npm install
npm start
```
Открой в браузере:
- http://localhost:3000

## Как тестировать мультиплеер
Открой два окна/вкладки и зайди в одну комнату:
- http://localhost:3000/?room=test

## Как задеплоить (пример)
Подойдёт Render / Fly.io / Railway / любой VPS.
Главное: нужен **один процесс** `npm start` и открытый порт `PORT`.

### Render (быстро)
- New Web Service
- Build Command: `npm install`
- Start Command: `npm start`

## Как подключить как Discord Activity
1) Задеплой проект и получи HTTPS URL, например:
- https://your-app.onrender.com

2) В Discord Developer Portal:
- Application -> Activities -> Enable
- URL: `https://your-app.onrender.com/?room=discord`

Комнату (`room`) можно сделать разной для разных серверов/каналов.

## Управление
- Первый зашедший становится **Ведущим (Host)**.
- Ведущий может менять время раунда, запускать/паузить игру и "засчитать/не засчитать" последнее слово.

## Папки
- `public/` — фронтенд
- `server.js` — сервер
