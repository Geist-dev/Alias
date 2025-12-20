
/**
 * Alias ("Шляпа") Discord Activity - simple realtime server
 * Run: npm install && npm start
 */
const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { nanoid } = require("nanoid");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * In-memory rooms. For production you want Redis/DB, but this is enough to get started.
 * rooms[roomId] = { clients: Map(ws->clientId), state: {...} }
 */
const rooms = new Map();

function nowMs() { return Date.now(); }

function defaultState(roomId) {
  return {
    roomId,
    version: 1,
    createdAt: nowMs(),
    // players: { [clientId]: {id, name, joinedAt, teamId|null } }
    players: {},
    // teams: { [teamId]: {id, name, playerIds:[...], score:number } }
    teams: {},
    // game: { status, hostId, turnTeamId, turnExplainerId, turnListenerId, turnIndex, secondsLeft, timerEndsAt, lastAction? }
    game: {
      status: "lobby", // lobby | running | paused | ended
      hostId: null,
      turnTeamId: null,
      turnExplainerId: null,
      turnListenerId: null,
      turnIndex: 0,
      roundSeconds: 60,
      secondsLeft: 60,
      timerEndsAt: null,
      lastAction: null, // {word, type:'correct'|'skip'|'undo-correct'|'undo-skip', by, ts}
    },
    // deck: array of words remaining in current deck
    deck: [],
    discard: [],
    // history of used words this match
    used: [],
  };
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    const r = { clients: new Map(), state: defaultState(roomId) };
    rooms.set(roomId, r);
  }
  return rooms.get(roomId);
}

function broadcast(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify(payload);
  for (const ws of room.clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function sanitizeName(s) {
  if (!s) return "Player";
  const t = String(s).trim().slice(0, 32);
  return t || "Player";
}

function countValidTeams(state) {
  const teams = Object.values(state.teams);
  return teams.filter(t => (t.playerIds || []).length === 2).length;
}

function nextTurn(state) {
  // Determine turn order among valid teams (size==2). Rotate.
  const validTeams = Object.values(state.teams).filter(t => (t.playerIds || []).length === 2);
  validTeams.sort((a,b)=>a.id.localeCompare(b.id)); // stable
  if (validTeams.length < 2) return null;

  let idx = 0;
  if (state.game.turnTeamId) {
    const curIdx = validTeams.findIndex(t => t.id === state.game.turnTeamId);
    idx = (curIdx >= 0) ? (curIdx + 1) % validTeams.length : 0;
  }
  const team = validTeams[idx];

  // alternate explainer inside team: based on teamTurns counter
  team._turns = team._turns || 0;
  const [p1, p2] = team.playerIds;
  const explainer = (team._turns % 2 === 0) ? p1 : p2;
  const listener  = (team._turns % 2 === 0) ? p2 : p1;
  team._turns += 1;

  state.game.turnTeamId = team.id;
  state.game.turnExplainerId = explainer;
  state.game.turnListenerId = listener;
  state.game.turnIndex += 1;
  state.game.secondsLeft = state.game.roundSeconds;
  state.game.timerEndsAt = nowMs() + state.game.roundSeconds * 1000;
  state.game.lastAction = null;
  return { teamId: team.id, explainer, listener };
}

function ensureDeck(state) {
  if (state.deck.length === 0) {
    // reshuffle: discard -> deck
    state.deck = shuffle([...state.discard]);
    state.discard = [];
  }
}

function shuffle(arr) {
  for (let i=arr.length-1;i>0;i--) {
    const j = Math.floor(Math.random() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickWord(state) {
  ensureDeck(state);
  const w = state.deck.shift() || null;
  if (w) state.used.push({ word: w, ts: nowMs(), turn: state.game.turnIndex });
  return w;
}

function recomputeSecondsLeft(state) {
  if (state.game.status !== "running") return;
  if (!state.game.timerEndsAt) return;
  const left = Math.ceil((state.game.timerEndsAt - nowMs())/1000);
  state.game.secondsLeft = Math.max(0, left);
  if (state.game.secondsLeft === 0) {
    // End of turn -> next turn
    nextTurn(state);
    state.game.status = "running";
    // pre-pick next word
    state.game.currentWord = pickWord(state);
  }
}

setInterval(() => {
  for (const { state } of rooms.values()) {
    if (state.game.status === "running") {
      recomputeSecondsLeft(state);
    }
  }
  // broadcast tick at low rate to reduce traffic
  for (const [roomId, room] of rooms.entries()) {
    if (room.state.game.status === "running") {
      broadcast(roomId, { type:"STATE", state: room.state });
    }
  }
}, 1000);

function requireHost(state, clientId) {
  return state.game.hostId === clientId;
}

function setHostIfEmpty(state, clientId) {
  if (!state.game.hostId) state.game.hostId = clientId;
}

function removePlayerFromTeams(state, playerId) {
  for (const t of Object.values(state.teams)) {
    t.playerIds = (t.playerIds || []).filter(id => id !== playerId);
  }
}

function cleanupEmptyTeams(state) {
  for (const [tid, t] of Object.entries(state.teams)) {
    if (!t.playerIds || t.playerIds.length === 0) {
      delete state.teams[tid];
    }
  }
}

function lobbyResetGame(state) {
  state.game.status = "lobby";
  state.game.turnTeamId = null;
  state.game.turnExplainerId = null;
  state.game.turnListenerId = null;
  state.game.turnIndex = 0;
  state.game.timerEndsAt = null;
  state.game.secondsLeft = state.game.roundSeconds;
  state.game.lastAction = null;
  state.game.currentWord = null;
  // scores reset
  for (const t of Object.values(state.teams)) t.score = 0;
  // reshuffle full wordlist into deck
  state.deck = shuffle([...state._wordlist]);
  state.discard = [];
  state.used = [];
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = (url.searchParams.get("room") || "default").slice(0, 64);

  const room = ensureRoom(roomId);
  const clientId = nanoid(10);

  room.clients.set(ws, clientId);

  // init wordlist once per room
  if (!room.state._wordlist) {
    // load words from public/words_ru.txt at runtime
    const fs = require("fs");
    const wordsPath = path.join(__dirname, "public", "words_ru.txt");
    const raw = fs.readFileSync(wordsPath, "utf8");
    room.state._wordlist = raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    room.state.deck = shuffle([...room.state._wordlist]);
  }

  // create player
  room.state.players[clientId] = {
    id: clientId,
    name: "Player",
    joinedAt: nowMs(),
    teamId: null,
  };
  setHostIfEmpty(room.state, clientId);

  send(ws, { type: "WELCOME", clientId, roomId, state: room.state });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    const state = room.state;

    // Keep timers fresh
    recomputeSecondsLeft(state);

    switch (msg.type) {
      case "SET_NAME": {
        state.players[clientId].name = sanitizeName(msg.name);
        break;
      }
      case "CREATE_TEAM": {
        const teamId = nanoid(8);
        state.teams[teamId] = {
          id: teamId,
          name: sanitizeName(msg.name || `Команда ${Object.keys(state.teams).length+1}`),
          playerIds: [],
          score: 0
        };
        break;
      }
      case "JOIN_TEAM": {
        const teamId = msg.teamId;
        if (!state.teams[teamId]) break;
        // ensure player is in at most one team
        removePlayerFromTeams(state, clientId);
        const t = state.teams[teamId];
        if ((t.playerIds || []).length >= 2) break; // max 2
        t.playerIds.push(clientId);
        state.players[clientId].teamId = teamId;
        cleanupEmptyTeams(state);
        break;
      }
      case "LEAVE_TEAM": {
        removePlayerFromTeams(state, clientId);
        state.players[clientId].teamId = null;
        cleanupEmptyTeams(state);
        break;
      }
      case "RENAME_TEAM": {
        const t = state.teams[msg.teamId];
        if (!t) break;
        if (!requireHost(state, clientId)) break;
        t.name = sanitizeName(msg.name);
        break;
      }
      case "SET_ROUND_SECONDS": {
        if (!requireHost(state, clientId)) break;
        const s = Math.max(20, Math.min(180, Number(msg.seconds)||60));
        state.game.roundSeconds = s;
        state.game.secondsLeft = s;
        break;
      }
      case "START_GAME": {
        if (!requireHost(state, clientId)) break;
        const ok = countValidTeams(state) >= 2;
        if (!ok) break;
        // reset and start
        lobbyResetGame(state);
        state.game.status = "running";
        nextTurn(state); // sets explainer/listener
        state.game.currentWord = pickWord(state);
        break;
      }
      case "PAUSE_GAME": {
        if (!requireHost(state, clientId)) break;
        if (state.game.status === "running") {
          // freeze secondsLeft
          recomputeSecondsLeft(state);
          state.game.status = "paused";
          state.game.timerEndsAt = null;
        }
        break;
      }
      case "RESUME_GAME": {
        if (!requireHost(state, clientId)) break;
        if (state.game.status === "paused") {
          state.game.status = "running";
          state.game.timerEndsAt = nowMs() + state.game.secondsLeft * 1000;
        }
        break;
      }
      case "END_TURN": {
        if (!requireHost(state, clientId)) break;
        if (state.game.status !== "running") break;
        nextTurn(state);
        state.game.currentWord = pickWord(state);
        break;
      }
      case "MARK": {
        // only explainer can mark, host can override via OVERRIDE_MARK
        const isExplainer = state.game.turnExplainerId === clientId;
        if (!isExplainer) break;
        if (state.game.status !== "running") break;
        const action = msg.action; // correct|skip
        const word = state.game.currentWord;
        if (!word) break;

        const team = state.teams[state.game.turnTeamId];
        if (!team) break;

        if (action === "correct") {
          team.score += 1;
          state.discard.push(word);
        } else if (action === "skip") {
          // put back to discard so it can reappear later
          state.discard.push(word);
        } else break;

        state.game.lastAction = { word, type: action, by: clientId, ts: nowMs(), teamId: team.id };
        state.game.currentWord = pickWord(state);
        break;
      }
      case "HOST_OVERRIDE_LAST": {
        if (!requireHost(state, clientId)) break;
        const la = state.game.lastAction;
        if (!la) break;
        const team = state.teams[la.teamId];
        if (!team) break;
        // decision: 'count' or 'not_count' toggles last action score effect
        const decision = msg.decision; // count | not_count
        // If last was correct and host says not_count => -1 (min 0)
        if (la.type === "correct" && decision === "not_count") {
          team.score = Math.max(0, team.score - 1);
          state.game.lastAction = { ...la, type: "undo-correct", by: clientId, ts: nowMs() };
        }
        // If last was skip and host says count => +1
        if (la.type === "skip" && decision === "count") {
          team.score += 1;
          state.game.lastAction = { ...la, type: "undo-skip", by: clientId, ts: nowMs() };
        }
        break;
      }
      case "HOST_SET_HOST": {
        // allow transferring host
        if (!requireHost(state, clientId)) break;
        const target = msg.clientId;
        if (state.players[target]) state.game.hostId = target;
        break;
      }
      default:
        break;
    }

    state.version += 1;
    broadcast(roomId, { type:"STATE", state });
  });

  ws.on("close", () => {
    const clientId = room.clients.get(ws);
    room.clients.delete(ws);

    if (clientId && room.state.players[clientId]) {
      // remove from teams
      removePlayerFromTeams(room.state, clientId);
      delete room.state.players[clientId];
      cleanupEmptyTeams(room.state);

      // if host left, pick another
      if (room.state.game.hostId === clientId) {
        const ids = Object.keys(room.state.players);
        room.state.game.hostId = ids[0] || null;
      }

      room.state.version += 1;
      broadcast(roomId, { type:"STATE", state: room.state });
    }

    // if room empty, delete after short grace
    if (room.clients.size === 0) {
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.clients.size === 0) rooms.delete(roomId);
      }, 60_000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Alias activity server listening on http://localhost:${PORT}`);
});
