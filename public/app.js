
const $ = (sel) => document.querySelector(sel);

const room = new URLSearchParams(location.search).get("room") || "default";
$("#roomLabel").textContent = `Комната: ${room}`;

const statusChip = $("#statusChip");
const copyLinkBtn = $("#copyLinkBtn");

const nameInput = $("#nameInput");
const saveNameBtn = $("#saveNameBtn");
const meMeta = $("#meMeta");

const createTeamBtn = $("#createTeamBtn");
const startBtn = $("#startBtn");
const pauseBtn = $("#pauseBtn");
const resumeBtn = $("#resumeBtn");
const endTurnBtn = $("#endTurnBtn");

const roundSecondsInput = $("#roundSeconds");
const setRoundBtn = $("#setRoundBtn");

const teamsEl = $("#teams");
const playersEl = $("#players");

const timerEl = $("#timer");
const roleLabel = $("#roleLabel");
const turnLabel = $("#turnLabel");
const wordEl = $("#word");
const wordHint = $("#wordHint");

const correctBtn = $("#correctBtn");
const skipBtn = $("#skipBtn");

const hostPanel = $("#hostPanel");
const hostCountBtn = $("#hostCountBtn");
const hostNotCountBtn = $("#hostNotCountBtn");
const lastActionEl = $("#lastAction");

const scoresEl = $("#scores");

let ws;
let clientId = null;
let state = null;

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/?room=${encodeURIComponent(room)}`;
}

function connect() {
  statusChip.textContent = "Подключение…";
  ws = new WebSocket(wsUrl());
  ws.onopen = () => statusChip.textContent = "Онлайн";
  ws.onclose = () => {
    statusChip.textContent = "Оффлайн — переподключение…";
    setTimeout(connect, 800);
  };
  ws.onerror = () => statusChip.textContent = "Ошибка соединения";
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "WELCOME") {
      clientId = msg.clientId;
      state = msg.state;
      render();
    }
    if (msg.type === "STATE") {
      state = msg.state;
      render();
    }
  };
}

function send(type, payload={}) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type, ...payload }));
}

function isHost() {
  return state?.game?.hostId && state.game.hostId === clientId;
}

function playerName(pid) {
  const p = state?.players?.[pid];
  return p ? p.name : "—";
}

function myPlayer() {
  return state?.players?.[clientId] || null;
}

function validTeamsCount() {
  const teams = Object.values(state?.teams || {});
  return teams.filter(t => (t.playerIds||[]).length === 2).length;
}

function fmtTime(s) {
  const n = Math.max(0, Number(s)||0);
  return String(n).padStart(2,"0");
}

function renderPlayers() {
  playersEl.innerHTML = "";
  const players = Object.values(state.players || {}).sort((a,b)=>a.joinedAt-b.joinedAt);
  for (const p of players) {
    const el = document.createElement("div");
    el.className = "playerTag";
    const hostMark = (state.game.hostId === p.id) ? " 👑" : "";
    el.textContent = `${p.name}${hostMark}`;
    playersEl.appendChild(el);
  }
}

function renderTeams() {
  teamsEl.innerHTML = "";
  const teams = Object.values(state.teams || {}).sort((a,b)=>a.id.localeCompare(b.id));
  for (const t of teams) {
    const card = document.createElement("div");
    card.className = "team";

    const head = document.createElement("div");
    head.className = "teamHead";
    const name = document.createElement("div");
    name.className = "teamName";
    name.textContent = t.name;

    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = `${(t.playerIds||[]).length}/2`;

    head.appendChild(name);
    head.appendChild(badge);

    const players = document.createElement("div");
    players.className = "teamPlayers";

    const ids = (t.playerIds || []);
    if (ids.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "Пусто — нажми «Присоединиться»";
      players.appendChild(empty);
    } else {
      for (const pid of ids) {
        const p = state.players[pid];
        const pill = document.createElement("div");
        pill.className = "pill";
        pill.innerHTML = `<b>${p?.name || "—"}</b><span class="mini">${pid===clientId?"это ты":""}</span>`;
        players.appendChild(pill);
      }
    }

    const actions = document.createElement("div");
    actions.className = "row wrap";
    actions.style.marginTop = "10px";

    const joinBtn = document.createElement("button");
    joinBtn.className = "btn";
    joinBtn.textContent = "Присоединиться";
    joinBtn.disabled = (state.game.status !== "lobby") || (ids.length >= 2) || (myPlayer()?.teamId === t.id);
    joinBtn.onclick = () => send("JOIN_TEAM", { teamId: t.id });

    const leaveBtn = document.createElement("button");
    leaveBtn.className = "btn ghost";
    leaveBtn.textContent = "Выйти";
    leaveBtn.disabled = (state.game.status !== "lobby") || (myPlayer()?.teamId !== t.id);
    leaveBtn.onclick = () => send("LEAVE_TEAM");

    const renameBtn = document.createElement("button");
    renameBtn.className = "btn ghost";
    renameBtn.textContent = "Переимен.";
    renameBtn.disabled = !isHost() || (state.game.status !== "lobby");
    renameBtn.onclick = () => {
      const nm = prompt("Название команды", t.name);
      if (nm) send("RENAME_TEAM", { teamId: t.id, name: nm });
    };

    actions.appendChild(joinBtn);
    actions.appendChild(leaveBtn);
    actions.appendChild(renameBtn);

    card.appendChild(head);
    card.appendChild(players);
    card.appendChild(actions);
    teamsEl.appendChild(card);
  }
}

function renderGame() {
  const g = state.game;
  const status = g.status;

  // controls
  createTeamBtn.disabled = status !== "lobby";
  setRoundBtn.disabled = !isHost() || status !== "lobby";
  startBtn.disabled = !isHost() || status !== "lobby" || validTeamsCount() < 2;
  pauseBtn.disabled = !isHost() || status !== "running";
  resumeBtn.disabled = !isHost() || status !== "paused";
  endTurnBtn.disabled = !isHost() || status !== "running";

  // labels
  const team = state.teams[g.turnTeamId];
  const exp = g.turnExplainerId ? playerName(g.turnExplainerId) : "—";
  const lis = g.turnListenerId ? playerName(g.turnListenerId) : "—";
  turnLabel.textContent = team ? `Ход: ${team.name} — объясняет ${exp}, угадывает ${lis}` : "Лобби";

  timerEl.textContent = fmtTime(g.secondsLeft);

  const isExplainer = (g.turnExplainerId === clientId);
  const isListener  = (g.turnListenerId === clientId);

  if (status !== "running") {
    roleLabel.textContent = status === "paused" ? "Пауза" : "Ожидание";
  } else if (isExplainer) {
    roleLabel.textContent = "Твоя роль: объясняешь";
  } else if (isListener) {
    roleLabel.textContent = "Твоя роль: угадываешь";
  } else {
    roleLabel.textContent = "Ты зритель (в этом ходе)";
  }

  // show word only to explainer (host still sees last action, but not current word)
  if (status === "running" && isExplainer) {
    wordEl.textContent = g.currentWord || "—";
    wordHint.textContent = "Объясняй и нажимай ✅ или ⏭️";
  } else if (status === "running" && isListener) {
    wordEl.textContent = "🤫";
    wordHint.textContent = "Слушай объяснение и угадывай!";
  } else {
    wordEl.textContent = "—";
    wordHint.textContent = "Слово видит только объясняющий.";
  }

  correctBtn.disabled = !(status === "running" && isExplainer);
  skipBtn.disabled = !(status === "running" && isExplainer);

  hostPanel.style.display = isHost() ? "block" : "none";
  hostCountBtn.disabled = !isHost() || !g.lastAction;
  hostNotCountBtn.disabled = !isHost() || !g.lastAction;

  if (g.lastAction) {
    const la = g.lastAction;
    const tnm = state.teams[la.teamId]?.name || "Команда";
    const by = playerName(la.by);
    lastActionEl.textContent = `Последнее: «${la.word}» (${tnm}) — ${la.type} — решал: ${by}`;
  } else {
    lastActionEl.textContent = "Последнего действия нет.";
  }

  // scores
  scoresEl.innerHTML = "";
  const teams = Object.values(state.teams||{}).sort((a,b)=>b.score-a.score);
  for (const t of teams) {
    const sc = document.createElement("div");
    sc.className = "scoreCard";
    sc.innerHTML = `<div class="name">${t.name}</div><div class="pts">${t.score}</div>`;
    scoresEl.appendChild(sc);
  }

  statusChip.textContent = status === "running" ? "Игра идёт" : (status === "paused" ? "Пауза" : "Лобби");
}

function render() {
  if (!state || !clientId) return;

  // my meta
  const p = myPlayer();
  if (p) {
    meMeta.textContent = `ID: ${clientId} · Ведущий: ${isHost() ? "да" : "нет"}`;
    if (!nameInput.value) nameInput.value = p.name;
  }

  // sync round seconds display
  roundSecondsInput.value = state.game.roundSeconds;

  renderTeams();
  renderPlayers();
  renderGame();
}

// UI events
saveNameBtn.onclick = () => {
  const nm = nameInput.value.trim();
  if (nm) send("SET_NAME", { name: nm });
};

createTeamBtn.onclick = () => {
  const nm = prompt("Название команды", `Команда ${Object.keys(state?.teams||{}).length+1}`);
  send("CREATE_TEAM", { name: nm || "" });
};

setRoundBtn.onclick = () => {
  const s = Number(roundSecondsInput.value);
  send("SET_ROUND_SECONDS", { seconds: s });
};

startBtn.onclick = () => send("START_GAME");
pauseBtn.onclick = () => send("PAUSE_GAME");
resumeBtn.onclick = () => send("RESUME_GAME");
endTurnBtn.onclick = () => send("END_TURN");

correctBtn.onclick = () => send("MARK", { action: "correct" });
skipBtn.onclick = () => send("MARK", { action: "skip" });

hostCountBtn.onclick = () => send("HOST_OVERRIDE_LAST", { decision: "count" });
hostNotCountBtn.onclick = () => send("HOST_OVERRIDE_LAST", { decision: "not_count" });

copyLinkBtn.onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
  try {
    await navigator.clipboard.writeText(url);
    statusChip.textContent = "Ссылка скопирована";
    setTimeout(()=>renderGame(), 900);
  } catch {
    prompt("Скопируй ссылку:", url);
  }
};

connect();
