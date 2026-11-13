'use strict';
const { randomUUID } = require('node:crypto');

function name(value, fallback = 'Игрок') {
  return typeof value === 'string' ? value.trim().slice(0, 32) || fallback : fallback;
}
function shuffle(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function createRoom(roomId, words) {
  if (!words.length) throw new Error('The word list must not be empty');
  return {
    roomId, version: 0, players: Object.create(null), teams: Object.create(null), words: [...words], deck: [], discard: [],
    game: {
      status: 'lobby', hostId: null, turnTeamId: null, turnExplainerId: null,
      turnListenerId: null, turnIndex: 0, roundSeconds: 60, secondsLeft: 60,
      deadline: null, remainingMs: 60000, currentWord: null, wordId: null,
      lastAction: null, notice: '',
    },
  };
}
function validTeams(room) {
  return Object.values(room.teams).filter((team) => team.playerIds.length === 2
    && team.playerIds.every((id) => room.players[id]?.online));
}
function addPlayer(room, id) {
  room.players[id] = { id, name: 'Игрок', joinedAt: Date.now(), teamId: null, online: true };
  if (!room.game.hostId) room.game.hostId = id;
}
function pickWord(room) {
  if (!room.deck.length) { room.deck = shuffle(room.discard); room.discard = []; }
  room.game.currentWord = room.deck.pop() || null;
  room.game.wordId = room.game.currentWord ? randomUUID() : null;
}
function releaseWord(room) {
  if (room.game.currentWord) room.discard.push(room.game.currentWord);
  room.game.currentWord = room.game.wordId = null;
}
function toLobby(room, notice = '') {
  releaseWord(room);
  Object.assign(room.game, {
    status: 'lobby', turnTeamId: null, turnExplainerId: null, turnListenerId: null,
    deadline: null, remainingMs: room.game.roundSeconds * 1000,
    secondsLeft: room.game.roundSeconds, lastAction: null, notice,
  });
}
function nextTurn(room, now = Date.now()) {
  const teams = validTeams(room);
  if (teams.length < 2) { toLobby(room, 'Нужны две полные команды. Соберите игроков снова.'); return; }
  const current = teams.findIndex((team) => team.id === room.game.turnTeamId);
  const team = teams[(current + 1) % teams.length];
  releaseWord(room);
  const turn = team.turns || 0;
  team.turns = turn + 1;
  Object.assign(room.game, {
    status: 'running', turnTeamId: team.id,
    turnExplainerId: team.playerIds[turn % 2], turnListenerId: team.playerIds[(turn + 1) % 2],
    turnIndex: room.game.turnIndex + 1, secondsLeft: room.game.roundSeconds,
    remainingMs: room.game.roundSeconds * 1000, deadline: now + room.game.roundSeconds * 1000,
    lastAction: null, notice: '',
  });
  pickWord(room);
}
function tick(room, now = Date.now()) {
  if (room.game.status !== 'running') return false;
  const previous = [room.game.secondsLeft, room.game.turnIndex];
  room.game.secondsLeft = Math.max(0, Math.ceil((room.game.deadline - now) / 1000));
  if (!room.game.secondsLeft) nextTurn(room, now);
  return room.game.secondsLeft !== previous[0] || room.game.turnIndex !== previous[1];
}
function disconnectPlayer(room, id, now = Date.now()) {
  const player = room.players[id];
  if (!player) return;
  player.online = false;
  if (room.game.hostId === id) {
    room.game.hostId = Object.values(room.players).find((p) => p.online)?.id || null;
  }
  if (room.game.status === 'running' && [room.game.turnExplainerId, room.game.turnListenerId].includes(id)) {
    room.game.remainingMs = Math.max(0, room.game.deadline - now);
    room.game.secondsLeft = Math.ceil(room.game.remainingMs / 1000);
    room.game.deadline = null;
    room.game.status = 'paused';
    room.game.notice = 'Игрок отключился. Ждём переподключения или возвращаемся в лобби.';
  }
}
function removePlayer(room, id) {
  const player = room.players[id];
  if (!player) return;
  const wasInTeam = Boolean(player.teamId);
  if (player.teamId && room.teams[player.teamId]) {
    room.teams[player.teamId].playerIds = room.teams[player.teamId].playerIds.filter((pid) => pid !== id);
  }
  delete room.players[id];
  if (room.game.hostId === id) room.game.hostId = Object.values(room.players).find((p) => p.online)?.id || null;
  if (wasInTeam && room.game.status !== 'lobby') toLobby(room, 'Состав изменился. Проверьте команды и начните новую игру.');
}
// Explicit projection: deck, resume credentials and private future words never enter a public packet.
function view(room, clientId) {
  const g = room.game;
  const game = {
    status: g.status, hostId: g.hostId, turnTeamId: g.turnTeamId,
    turnExplainerId: g.turnExplainerId, turnListenerId: g.turnListenerId,
    turnIndex: g.turnIndex, roundSeconds: g.roundSeconds, secondsLeft: g.secondsLeft,
    lastAction: g.lastAction ? { ...g.lastAction } : null, notice: g.notice,
  };
  if (g.turnExplainerId === clientId && g.status === 'running') {
    game.currentWord = g.currentWord;
    game.wordId = g.wordId;
  }
  return {
    roomId: room.roomId, version: room.version,
    players: Object.fromEntries(Object.entries(room.players).map(([id, p]) => [id, { ...p }])),
    teams: Object.fromEntries(Object.entries(room.teams).map(([id, t]) => [id, {
      id: t.id, name: t.name, playerIds: [...t.playerIds], score: t.score,
    }])), game,
  };
}
function apply(room, clientId, message, now = Date.now()) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') return 'Некорректное сообщение';
  const player = room.players[clientId];
  if (!player?.online) return 'Игрок не подключён';
  tick(room, now);
  const g = room.game;
  const host = g.hostId === clientId;
  if (['JOIN_TEAM', 'RENAME_TEAM', 'DELETE_TEAM'].includes(message.type) && typeof message.teamId !== 'string') return 'Некорректный ID команды';
  if (message.type === 'HOST_SET_HOST' && typeof message.clientId !== 'string') return 'Некорректный ID игрока';
  const hostOnly = new Set(['RENAME_TEAM', 'DELETE_TEAM', 'SET_ROUND_SECONDS', 'START_GAME', 'PAUSE_GAME', 'RESUME_GAME', 'END_TURN', 'HOST_OVERRIDE_LAST', 'HOST_SET_HOST', 'RESET_GAME']);
  if (hostOnly.has(message.type) && !host) return 'Это действие доступно только ведущему';
  if (['CREATE_TEAM', 'JOIN_TEAM', 'LEAVE_TEAM', 'RENAME_TEAM', 'DELETE_TEAM', 'SET_ROUND_SECONDS'].includes(message.type) && g.status !== 'lobby') return 'Состав и настройки можно менять только в лобби';
  switch (message.type) {
    case 'SET_NAME': player.name = name(message.name); break;
    case 'CREATE_TEAM': {
      if (Object.keys(room.teams).length >= 8) return 'Максимум 8 команд';
      const id = randomUUID();
      room.teams[id] = { id, name: name(message.name, `Команда ${Object.keys(room.teams).length + 1}`), playerIds: [], score: 0, turns: 0 };
      break;
    }
    case 'JOIN_TEAM': {
      const team = room.teams[message.teamId];
      if (!team) return 'Команда не найдена';
      if (player.teamId === team.id) return null;
      // Validate destination before touching the original roster.
      if (team.playerIds.length >= 2) return 'В команде уже два игрока';
      if (player.teamId && room.teams[player.teamId]) room.teams[player.teamId].playerIds = room.teams[player.teamId].playerIds.filter((id) => id !== clientId);
      team.playerIds.push(clientId); player.teamId = team.id; break;
    }
    case 'LEAVE_TEAM': {
      if (player.teamId && room.teams[player.teamId]) room.teams[player.teamId].playerIds = room.teams[player.teamId].playerIds.filter((id) => id !== clientId);
      player.teamId = null; break;
    }
    case 'RENAME_TEAM': {
      const team = room.teams[message.teamId];
      if (!team) return 'Команда не найдена';
      team.name = name(message.name, team.name); break;
    }
    case 'DELETE_TEAM': {
      const team = room.teams[message.teamId];
      if (!team || team.playerIds.length) return 'Удалить можно только пустую команду';
      delete room.teams[team.id]; break;
    }
    case 'SET_ROUND_SECONDS': {
      if (!Number.isInteger(message.seconds) || message.seconds < 20 || message.seconds > 180) return 'Раунд: целое число от 20 до 180 секунд';
      g.roundSeconds = g.secondsLeft = message.seconds; g.remainingMs = message.seconds * 1000; break;
    }
    case 'START_GAME': {
      if (g.status !== 'lobby' || validTeams(room).length < 2) return 'Нужны минимум две команды по два подключённых игрока';
      room.deck = shuffle(room.words); room.discard = [];
      Object.values(room.teams).forEach((team) => { team.score = 0; team.turns = 0; });
      Object.assign(g, { turnTeamId: null, turnIndex: 0, currentWord: null });
      nextTurn(room, now); break;
    }
    case 'PAUSE_GAME': {
      if (g.status !== 'running') return 'Игра не запущена';
      g.remainingMs = Math.max(0, g.deadline - now); g.secondsLeft = Math.ceil(g.remainingMs / 1000);
      g.status = 'paused'; g.deadline = null; break;
    }
    case 'RESUME_GAME': {
      if (g.status !== 'paused') return 'Игра не на паузе';
      if (![g.turnExplainerId, g.turnListenerId].every((id) => room.players[id]?.online)) return 'Дождитесь игроков текущей команды или вернитесь в лобби';
      g.status = 'running'; g.deadline = now + g.remainingMs; g.notice = ''; break;
    }
    case 'END_TURN': {
      if (g.status !== 'running') return 'Игра не запущена';
      nextTurn(room, now); break;
    }
    case 'RESET_GAME': toLobby(room, 'Игра остановлена ведущим. Можно изменить команды.'); break;
    case 'MARK': {
      if (g.status !== 'running' || g.turnExplainerId !== clientId) return 'Слово отмечает только объясняющий во время своего хода';
      if (!g.currentWord || message.wordId !== g.wordId) return 'Это слово уже сменилось';
      if (!['correct', 'skip'].includes(message.action)) return 'Неизвестное действие';
      const awarded = message.action === 'correct';
      const team = room.teams[g.turnTeamId];
      if (awarded) team.score += 1;
      g.lastAction = { id: randomUUID(), word: g.currentWord, teamId: team.id, type: message.action, awarded, by: clientId };
      releaseWord(room); pickWord(room); break;
    }
    case 'HOST_OVERRIDE_LAST': {
      const last = g.lastAction;
      if (!last || message.actionId !== last.id || !['count', 'not_count'].includes(message.decision)) return 'Последнее действие изменилось';
      const awarded = message.decision === 'count';
      room.teams[last.teamId].score += Number(awarded) - Number(last.awarded);
      last.awarded = awarded; last.by = clientId; break;
    }
    case 'HOST_SET_HOST': {
      if (!room.players[message.clientId]?.online) return 'Игрок не подключён';
      g.hostId = message.clientId; break;
    }
    default: return 'Неизвестная команда';
  }
  room.version += 1;
  return null;
}
module.exports = { createRoom, addPlayer, view, apply, tick, disconnectPlayer, removePlayer, validTeams };
