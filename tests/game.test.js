'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../src/game');
function lobby() {
  const room = g.createRoom('test', ['ананас', 'космос', 'зонтик', 'гитара']);
  for (const id of ['a', 'b', 'c', 'd']) g.addPlayer(room, id);
  g.apply(room, 'a', { type: 'CREATE_TEAM', name: 'Лисы' });
  g.apply(room, 'a', { type: 'CREATE_TEAM', name: 'Совы' });
  const [first, second] = Object.keys(room.teams);
  for (const id of ['a', 'b']) g.apply(room, id, { type: 'JOIN_TEAM', teamId: first });
  for (const id of ['c', 'd']) g.apply(room, id, { type: 'JOIN_TEAM', teamId: second });
  return room;
}
function running() { const room = lobby(); assert.equal(g.apply(room, 'a', { type: 'START_GAME' }, 1000), null); return room; }

test('only the current explainer receives the word and no client receives the deck', () => {
  const room = running();
  for (const id of Object.keys(room.players)) {
    const state = g.view(room, id);
    assert.equal(Object.hasOwn(state.game, 'currentWord'), id === room.game.turnExplainerId);
    assert.equal(Object.hasOwn(state.game, 'wordId'), id === room.game.turnExplainerId);
    for (const key of ['words', 'deck', 'discard', 'sessions', '_wordlist', 'used']) assert.equal(Object.hasOwn(state, key), false);
    assert.equal(Object.hasOwn(state.teams[room.game.turnTeamId], 'turns'), false);
  }
});
test('joining a full team retains original membership', () => {
  const room = lobby(), original = room.players.a.teamId;
  assert.ok(g.apply(room, 'a', { type: 'JOIN_TEAM', teamId: room.players.c.teamId }));
  assert.equal(room.players.a.teamId, original);
  assert.deepEqual(room.teams[original].playerIds, ['a', 'b']);
});
test('team membership cannot change during a round, even through raw messages', () => {
  const room = running();
  assert.ok(g.apply(room, 'a', { type: 'LEAVE_TEAM' }, 1001));
  assert.ok(g.apply(room, 'c', { type: 'CREATE_TEAM', name: 'x' }, 1001));
  assert.equal(room.teams[room.players.a.teamId].playerIds.length, 2);
});
test('only host may start, pause, rename and reset', () => {
  const room = lobby();
  for (const message of [{ type: 'START_GAME' }, { type: 'RENAME_TEAM', teamId: room.players.a.teamId, name: 'x' }, { type: 'RESET_GAME' }]) assert.ok(g.apply(room, 'b', message));
  assert.equal(room.game.status, 'lobby');
});
test('a duplicate MARK cannot score the next word', () => {
  const room = running();
  const message = { type: 'MARK', action: 'correct', wordId: room.game.wordId };
  const id = room.game.turnExplainerId;
  assert.equal(g.apply(room, id, message, 1001), null);
  assert.ok(g.apply(room, id, message, 1002));
  assert.equal(room.teams[room.game.turnTeamId].score, 1);
});
test('listener cannot mark or obtain current word through ordinary state', () => {
  const room = running();
  assert.ok(g.apply(room, room.game.turnListenerId, { type: 'MARK', action: 'correct', wordId: room.game.wordId }, 1001));
  assert.equal(room.teams[room.game.turnTeamId].score, 0);
});
test('host corrections are idempotent and may be toggled without score drift', () => {
  const room = running();
  g.apply(room, room.game.turnExplainerId, { type: 'MARK', action: 'correct', wordId: room.game.wordId }, 1001);
  const id = room.game.lastAction.id, team = room.teams[room.game.turnTeamId];
  for (const decision of ['not_count', 'not_count', 'count', 'count', 'not_count']) g.apply(room, 'a', { type: 'HOST_OVERRIDE_LAST', decision, actionId: id }, 1002);
  assert.equal(team.score, 0);
});
test('pause preserves remaining time; resume does not reset the round', () => {
  const room = running();
  g.apply(room, 'a', { type: 'PAUSE_GAME' }, 11250);
  assert.equal(room.game.remainingMs, 49750);
  g.tick(room, 90000); assert.equal(room.game.status, 'paused');
  g.apply(room, 'a', { type: 'RESUME_GAME' }, 100000);
  assert.equal(room.game.deadline, 149750);
  g.tick(room, 149751); assert.equal(room.game.turnIndex, 2);
});
test('turns rotate between teams and alternate explainers within a team', () => {
  const room = running();
  assert.equal(room.game.turnExplainerId, 'a');
  g.apply(room, 'a', { type: 'END_TURN' }, 1001); assert.equal(room.game.turnExplainerId, 'c');
  g.apply(room, 'a', { type: 'END_TURN' }, 1002); assert.equal(room.game.turnExplainerId, 'b');
});
test('disconnect pauses the active round and transfers host; resume waits for players', () => {
  const room = running();
  g.disconnectPlayer(room, 'a', 2000);
  assert.equal(room.game.status, 'paused'); assert.equal(room.game.hostId, 'b');
  assert.ok(g.apply(room, 'b', { type: 'RESUME_GAME' }, 3000));
  room.players.a.online = true;
  assert.equal(g.apply(room, 'b', { type: 'RESUME_GAME' }, 4000), null);
});
test('expired player returns the room to a consistent lobby', () => {
  const room = running(); g.disconnectPlayer(room, 'a', 2000); g.removePlayer(room, 'a');
  assert.equal(room.game.status, 'lobby');
  assert.equal(room.teams[room.players.b.teamId].playerIds.length, 1);
  assert.equal(room.game.currentWord, null);
});
test('invalid payloads and invalid round lengths do not change settings', () => {
  const room = lobby();
  for (const value of [null, [], 2, { type: 'unknown' }, { type: 'SET_ROUND_SECONDS', seconds: -1 }, { type: 'SET_ROUND_SECONDS', seconds: Infinity }, { type: 'SET_ROUND_SECONDS', seconds: 20.5 }]) assert.ok(g.apply(room, 'a', value));
  assert.equal(room.game.roundSeconds, 60);
});
test('empty teams are explicit and can only be deleted by host', () => {
  const room = lobby(); g.apply(room, 'b', { type: 'CREATE_TEAM', name: 'Запас' });
  const teamId = Object.keys(room.teams).at(-1);
  assert.ok(g.apply(room, 'b', { type: 'DELETE_TEAM', teamId }));
  assert.equal(g.apply(room, 'a', { type: 'DELETE_TEAM', teamId }), null);
  assert.equal(room.teams[teamId], undefined);
});
test('names are bounded plain strings; a state copy cannot mutate the room', () => {
  const room = lobby();
  g.apply(room, 'a', { type: 'SET_NAME', name: 'x'.repeat(100) }); assert.equal(room.players.a.name.length, 32);
  const state = g.view(room, 'b'); state.teams[room.players.a.teamId].playerIds.pop();
  assert.equal(room.teams[room.players.a.teamId].playerIds.length, 2);
});
test('word recycling keeps a playable deck across many turns and marks', () => {
  const room = running();
  for (let i = 0; i < 30; i++) {
    assert.ok(room.game.currentWord);
    g.apply(room, room.game.turnExplainerId, { type: 'MARK', action: 'skip', wordId: room.game.wordId }, 1001 + i);
    if (i % 3 === 0) g.apply(room, 'a', { type: 'END_TURN' }, 1001 + i);
  }
  assert.ok(room.game.currentWord);
});
test('untrusted IDs cannot access object prototypes or throw through key coercion', () => {
  const room = lobby();
  for (const teamId of ['__proto__', 'constructor', { toString: null }, null, 2]) {
    for (const type of ['JOIN_TEAM', 'RENAME_TEAM', 'DELETE_TEAM']) assert.ok(g.apply(room, 'a', { type, teamId }));
  }
  assert.ok(g.apply(room, 'a', { type: 'HOST_SET_HOST', clientId: { toString: null } }));
});
test('expiry of a disconnected spectator does not interrupt the match', () => {
  const room = running(); g.addPlayer(room, 'spectator');
  g.disconnectPlayer(room, 'spectator', 1001); g.removePlayer(room, 'spectator');
  assert.equal(room.game.status, 'running'); assert.equal(room.game.turnIndex, 1);
});
