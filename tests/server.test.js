'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createServer } = require('../server');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for state'); await delay(10); }
}
async function setup(t, options = {}) {
  const instance = createServer({ reconnectMs: 1000, emptyRoomMs: 1000, ...options });
  instance.server.listen(0, '127.0.0.1'); await once(instance.server, 'listening');
  t.after(() => instance.stop());
  return `http://127.0.0.1:${instance.server.address().port}`;
}
async function connect(base, room = 'test', resumeToken) {
  const url = base.replace('http:', 'ws:') + '/ws?room=' + room;
  const ws = new WebSocket(url);
  const client = { ws, packets: [], state: null, welcome: null };
  ws.on('error', () => {});
  ws.on('message', (bytes) => {
    const packet = JSON.parse(bytes);
    client.packets.push(packet);
    if (packet.state) client.state = packet.state;
    if (packet.type === 'WELCOME') client.welcome = packet;
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'HELLO', resumeToken }));
  await until(() => client.welcome);
  client.send = (message) => ws.send(JSON.stringify(message));
  return client;
}
async function command(client, message, predicate) {
  const revision = client.state.version;
  client.send(message);
  await until(() => client.state.version > revision && (!predicate || predicate(client.state)));
}
async function players(base) {
  const clients = [];
  for (let i = 0; i < 4; i++) clients.push(await connect(base));
  await until(() => Object.keys(clients[0].state.players).length === 4);
  const host = clients[0];
  await command(host, { type: 'CREATE_TEAM', name: 'Лисы' });
  await command(host, { type: 'CREATE_TEAM', name: 'Совы' });
  const ids = Object.keys(host.state.teams);
  for (let i = 0; i < 4; i++) await command(clients[i], { type: 'JOIN_TEAM', teamId: ids[Math.floor(i / 2)] });
  return clients;
}

test('HTTP serves UI but never private server files or the dictionary', async (t) => {
  const base = await setup(t);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.ok((await (await fetch(base)).text()).includes('Alias'));
  for (const path of ['/.env', '/server.js', '/data/words_ru.txt', '/words_ru.txt']) assert.equal((await fetch(base + path)).status, 404);
});
test('four clients receive individualized state, scores and no other session token', async (t) => {
  const clients = await players(await setup(t));
  await command(clients[0], { type: 'START_GAME' });
  await until(() => clients.every((client) => client.state.game.status === 'running'));
  const explainers = clients.filter((client) => client.state.game.currentWord);
  assert.equal(explainers.length, 1);
  const actor = explainers[0], word = actor.state.game.currentWord;
  for (const client of clients) {
    assert.equal(Object.hasOwn(client.state.game, 'currentWord'), client === actor);
    assert.ok(!JSON.stringify(client.state).includes(actor.welcome.resumeToken));
    if (client !== actor) assert.ok(!JSON.stringify(client.state).includes(word));
  }
  const teamId = actor.state.game.turnTeamId;
  await command(actor, { type: 'MARK', action: 'correct', wordId: actor.state.game.wordId });
  await until(() => clients.every((client) => client.state.teams[teamId].score === 1));
});
test('HELLO resume restores identity, name and team after reload', async (t) => {
  const base = await setup(t);
  const clients = await players(base), original = clients[0];
  await command(original, { type: 'SET_NAME', name: 'Саша' });
  const id = original.welcome.clientId, team = original.state.players[id].teamId;
  original.ws.close(); await once(original.ws, 'close');
  const resumed = await connect(base, 'test', original.welcome.resumeToken);
  assert.equal(resumed.welcome.clientId, id);
  assert.equal(resumed.state.players[id].name, 'Саша');
  assert.equal(resumed.state.players[id].teamId, team);
  assert.equal(Object.keys(resumed.state.players).length, 4);
});
test('malformed JSON and null packets do not crash the server', async (t) => {
  const base = await setup(t), client = await connect(base);
  client.ws.send('not json'); client.ws.send('null'); client.ws.send('[]');
  await until(() => client.packets.filter((packet) => packet.type === 'ERROR').length === 3);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});
test('cross-origin and invalid room upgrades are rejected', async (t) => {
  const base = await setup(t);
  for (const [suffix, options] of [['/ws?room=valid', { origin: 'https://foreign.example' }], ['/ws?room=bad%20room', {}]]) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + suffix, options);
    ws.on('error', () => {});
    const [, response] = await once(ws, 'unexpected-response');
    assert.equal(response.statusCode, 403); ws.terminate();
  }
});
test('oversized messages close only the offending connection', async (t) => {
  const base = await setup(t), client = await connect(base);
  const closed = once(client.ws, 'close');
  client.ws.send('x'.repeat(5000));
  const [code] = await closed;
  assert.equal(code, 1009);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});
test('rooms and resume credentials are isolated from other rooms', async (t) => {
  const base = await setup(t);
  const first = await connect(base, 'first');
  await command(first, { type: 'CREATE_TEAM', name: 'Лисы' });
  const second = await connect(base, 'second', first.welcome.resumeToken);
  assert.notEqual(first.welcome.clientId, second.welcome.clientId);
  assert.equal(Object.keys(second.state.teams).length, 0);
  await command(second, { type: 'SET_NAME', name: 'Other room' });
  assert.equal(Object.keys(first.state.players).length, 1);
});
