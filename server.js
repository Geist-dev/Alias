'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes } = require('node:crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const game = require('./src/game');

function createServer({ reconnectMs = 30000, emptyRoomMs = 60000, maxRooms = 100, tickMs = 250 } = {}) {
  const words = [...new Set(fs.readFileSync(path.join(__dirname, 'data/words_ru.txt'), 'utf8').split(/\r?\n/).map((word) => word.trim()).filter(Boolean))];
  if (!words.length) throw new Error('Empty word list');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'");
    next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const rooms = new Map();
  const timers = new Set();
  let stopping = false;
  const later = (callback, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
    timer.unref(); timers.add(timer); return timer;
  };
  const cancel = (timer) => { clearTimeout(timer); timers.delete(timer); };
  const send = (ws, payload) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, 'Client too slow'); return; }
    ws.send(JSON.stringify(payload));
  };
  function broadcast(room) {
    for (const [id, ws] of room.connections) send(ws, { type: 'STATE', state: game.view(room.state, id) });
  }
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    const roomId = url.searchParams.get('room') || 'default';
    let originAllowed = true;
    if (req.headers.origin) {
      try { originAllowed = new URL(req.headers.origin).host === req.headers.host; } catch { originAllowed = false; }
    }
    if (url.pathname !== '/ws' || !/^[A-Za-z0-9_-]{1,64}$/.test(roomId) || !originAllowed || (!rooms.has(roomId) && rooms.size >= maxRooms)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, roomId));
  });
  wss.on('connection', (ws, roomId) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let room, clientId;
    let count = 0, windowStart = Date.now();
    const helloTimer = later(() => ws.close(1008, 'HELLO required'), 5000);
    ws.on('error', () => {}); // Protocol errors close only this connection.
    ws.on('message', (data, binary) => {
      if (binary) { ws.close(1003, 'Text messages only'); return; }
      if (Date.now() - windowStart >= 5000) { windowStart = Date.now(); count = 0; }
      if (++count > 50) { ws.close(1008, 'Too many messages'); return; }
      let message;
      try { message = JSON.parse(data.toString()); } catch { send(ws, { type: 'ERROR', message: 'Сообщение должно быть JSON' }); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { send(ws, { type: 'ERROR', message: 'Некорректное сообщение' }); return; }
      if (!clientId) {
        if (message.type !== 'HELLO') { ws.close(1008, 'HELLO required'); return; }
        cancel(helloTimer);
        room = rooms.get(roomId);
        if (!room) {
          // Recheck after HELLO: several pending handshakes may share an upgrade window.
          if (rooms.size >= maxRooms) { ws.close(1013, 'Room limit'); return; }
          room = { state: game.createRoom(roomId, words), sessions: new Map(), connections: new Map(), expiry: new Map(), emptyTimer: null };
          rooms.set(roomId, room);
        }
        let resumeToken = typeof message.resumeToken === 'string' ? message.resumeToken : '';
        clientId = room.sessions.get(resumeToken);
        if (!clientId) {
          if (Object.keys(room.state.players).length >= 32) { ws.close(1013, 'Room full'); return; }
          clientId = randomUUID(); resumeToken = randomBytes(32).toString('hex');
          room.sessions.set(resumeToken, clientId); game.addPlayer(room.state, clientId);
        }
        const previous = room.connections.get(clientId);
        room.connections.set(clientId, ws);
        if (previous && previous !== ws) previous.close(4001, 'Session replaced');
        cancel(room.expiry.get(clientId)); room.expiry.delete(clientId);
        cancel(room.emptyTimer); room.emptyTimer = null;
        room.state.players[clientId].online = true;
        if (!room.state.game.hostId) room.state.game.hostId = clientId;
        room.state.version += 1;
        // Resume token is a per-player bearer credential. Never broadcast it.
        send(ws, { type: 'WELCOME', clientId, roomId, resumeToken, state: game.view(room.state, clientId) });
        broadcast(room); return;
      }
      if (room.connections.get(clientId) !== ws) return;
      const error = game.apply(room.state, clientId, message);
      if (error) send(ws, { type: 'ERROR', message: error });
      broadcast(room);
    });
    ws.on('close', () => {
      cancel(helloTimer);
      if (stopping) return;
      if (!room || !clientId || room.connections.get(clientId) !== ws) return;
      room.connections.delete(clientId);
      game.disconnectPlayer(room.state, clientId);
      room.state.version += 1; broadcast(room);
      room.expiry.set(clientId, later(() => {
        room.expiry.delete(clientId); game.removePlayer(room.state, clientId);
        for (const [token, id] of room.sessions) if (id === clientId) room.sessions.delete(token);
        room.state.version += 1; broadcast(room);
      }, reconnectMs));
      if (!room.connections.size) room.emptyTimer = later(() => {
        if (room.connections.size) return;
        for (const timer of room.expiry.values()) cancel(timer);
        rooms.delete(roomId);
      }, Math.max(emptyRoomMs, reconnectMs));
    });
  });
  const ticker = setInterval(() => {
    for (const room of rooms.values()) if (game.tick(room.state)) broadcast(room);
  }, tickMs);
  ticker.unref();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) ws.terminate();
      else { ws.isAlive = false; ws.ping(); }
    }
  }, 30000);
  heartbeat.unref();
  async function stop() {
    stopping = true;
    clearInterval(ticker);
    clearInterval(heartbeat);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  return { server, stop };
}
if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT must be an integer from 1 to 65535'); process.exit(1); }
  const host = process.env.HOST || '127.0.0.1';
  const instance = createServer();
  instance.server.once('error', (error) => { console.error(`Cannot start server: ${error.code}`); process.exitCode = 1; });
  instance.server.listen(port, host, () => console.log(`Alias: http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => instance.stop().catch(() => { process.exitCode = 1; }));
}
module.exports = { createServer };
