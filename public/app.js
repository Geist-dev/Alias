'use strict';
const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const room = params.get('room') || crypto.randomUUID().slice(0, 8);
if (!params.has('room')) { params.set('room', room); history.replaceState(null, '', `${location.pathname}?${params}`); }
$('#roomLabel').textContent = `Комната / ${room}`;
const sessionKey = `alias-session:${room}`;
let socket, clientId = null, state = null, connected = false, reconnectTimer;
let rosterKey = '', scoreKey = '';
let retryDelay = 800;
const byId = (id) => state?.players[id]?.name || '—';
const isHost = () => state?.game.hostId === clientId;

function notify(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
  $('#notice').hidden = !message;
}
function send(type, payload = {}) {
  if (!connected || socket.readyState !== WebSocket.OPEN) { notify('Дождитесь подключения к серверу.', true); return; }
  socket.send(JSON.stringify({ type, ...payload }));
}
function connect() {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) { notify('ID комнаты: от 1 до 64 латинских букв, цифр, _ или -.', true); return; }
  $('#statusChip').textContent = 'Подключение…';
  const url = new URL('/ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('room', room);
  socket = new WebSocket(url);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'HELLO', resumeToken: sessionStorage.getItem(sessionKey) || '' }));
  socket.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'ERROR') { notify(message.message, true); return; }
    if (message.type === 'WELCOME') {
      clientId = message.clientId;
      sessionStorage.setItem(sessionKey, message.resumeToken);
      connected = true; retryDelay = 800;
      rosterKey = ''; // Re-enable team buttons disabled while the connection was down.
      notify('');
      if (message.state.players[clientId].name === 'Игрок') {
        const savedName = localStorage.getItem('alias-name');
        if (savedName) send('SET_NAME', { name: savedName });
      }
    }
    if (['WELCOME', 'STATE'].includes(message.type)) { state = message.state; render(); }
  };
  socket.onerror = () => notify('Не удалось подключиться к серверу.', true);
  socket.onclose = (event) => {
    connected = false;
    $('#statusChip').textContent = 'Нет связи';
    $('#word').textContent = '—';
    $('#wordHint').textContent = 'Дождитесь подключения. Слово временно скрыто.';
    document.querySelectorAll('main button').forEach((button) => { button.disabled = true; });
    if ([4001, 1008, 1009, 1013].includes(event.code)) {
      notify('Соединение закрыто: другая вкладка, лимит комнаты или сообщений. Обновите страницу для повторного подключения.', true);
      return;
    }
    notify('Связь потеряна. Переподключаемся; место сохраняется 30 секунд.', true);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(10000, retryDelay * 2);
  };
}
function button(label, handler, className = 'btn ghost') {
  const element = document.createElement('button');
  element.type = 'button'; element.className = className; element.textContent = label;
  element.addEventListener('click', handler);
  return element;
}
function renderTeams() {
  const key = JSON.stringify([state.teams, state.players, state.game.status, state.game.hostId]);
  if (key === rosterKey) return;
  rosterKey = key;
  $('#teams').replaceChildren();
  const lobby = state.game.status === 'lobby';
  for (const team of Object.values(state.teams)) {
    const card = document.createElement('article'); card.className = 'team'; card.dataset.teamId = team.id;
    const head = document.createElement('div'); head.className = 'teamHead';
    const title = document.createElement('h3'); title.className = 'teamName'; title.textContent = team.name;
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = `${team.playerIds.length} / 2`;
    head.append(title, badge);
    const players = document.createElement('div'); players.className = 'teamPlayers';
    for (const id of team.playerIds) {
      const player = state.players[id];
      const pill = document.createElement('div'); pill.className = 'pill';
      const name = document.createElement('b'); name.textContent = player.name;
      const marker = document.createElement('span'); marker.className = 'mini';
      marker.textContent = !player.online ? 'переподключение…' : id === clientId ? 'это вы' : 'в игре';
      pill.append(name, marker); players.append(pill);
    }
    if (!team.playerIds.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Два свободных места'; players.append(empty);
    }
    const actions = document.createElement('div'); actions.className = 'teamActions';
    const join = button('Присоединиться', () => send('JOIN_TEAM', { teamId: team.id }), 'btn');
    join.disabled = !lobby || team.playerIds.length >= 2 || state.players[clientId].teamId === team.id;
    const leave = button('Выйти', () => send('LEAVE_TEAM'));
    leave.disabled = !lobby || state.players[clientId].teamId !== team.id;
    actions.append(join, leave);
    if (isHost()) {
      const rename = button('Название', () => {
        const value = prompt('Название команды', team.name);
        if (value !== null) send('RENAME_TEAM', { teamId: team.id, name: value });
      }); rename.disabled = !lobby; actions.append(rename);
      if (!team.playerIds.length) {
        const remove = button('Удалить', () => send('DELETE_TEAM', { teamId: team.id }));
        remove.disabled = !lobby; actions.append(remove);
      }
    }
    card.append(head, players, actions); $('#teams').append(card);
  }
  $('#players').replaceChildren();
  for (const player of Object.values(state.players)) {
    const item = document.createElement('span'); item.className = 'playerTag';
    item.textContent = `${player.name}${player.id === state.game.hostId ? ' · ведущий' : ''}${player.online ? '' : ' · нет связи'}`;
    $('#players').append(item);
  }
  $('#playerCount').textContent = Object.values(state.players).filter((player) => player.online).length;
}
function render() {
  if (!connected || !state || !clientId) return;
  const g = state.game, host = isHost();
  document.body.dataset.playing = String(g.status !== 'lobby');
  $('#statusChip').textContent = ({ lobby: 'Лобби', running: 'Игра идёт', paused: 'Пауза' })[g.status];
  $('#meMeta').textContent = host ? 'Вы — ведущий. Управляйте игрой и приглашайте друзей.' : `Ведущий: ${byId(g.hostId)}`;
  if (document.activeElement !== $('#nameInput')) $('#nameInput').value = state.players[clientId].name;
  if (document.activeElement !== $('#roundSeconds')) $('#roundSeconds').value = g.roundSeconds;
  $('#saveNameBtn').disabled = false;
  $('#createTeamBtn').disabled = g.status !== 'lobby';
  $('#setRoundBtn').disabled = !host || g.status !== 'lobby';
  const validCount = Object.values(state.teams).filter((team) => team.playerIds.length === 2 && team.playerIds.every((id) => state.players[id]?.online)).length;
  $('#startBtn').disabled = !host || g.status !== 'lobby' || validCount < 2;
  $('#pauseBtn').disabled = !host || g.status !== 'running';
  $('#resumeBtn').disabled = !host || g.status !== 'paused';
  $('#endTurnBtn').disabled = !host || g.status !== 'running';
  $('#resetBtn').disabled = !host || g.status === 'lobby';
  const team = state.teams[g.turnTeamId];
  $('#turnLabel').textContent = team ? `${team.name} · объясняет ${byId(g.turnExplainerId)}, угадывает ${byId(g.turnListenerId)}` : 'Соберите команды и начните игру';
  $('#timer').textContent = String(g.secondsLeft).padStart(2, '0');
  const explainer = g.turnExplainerId === clientId;
  const listener = g.turnListenerId === clientId;
  $('#roleLabel').textContent = g.status === 'lobby' ? 'До старта' : g.status === 'paused' ? 'Пауза' : explainer ? 'Вы объясняете' : listener ? 'Вы угадываете' : 'Вы наблюдаете';
  const visible = g.status === 'running' && explainer;
  $('#word').textContent = visible ? g.currentWord || '—' : g.status === 'running' ? '•••••' : 'Ваша очередь впереди';
  $('#wordHint').textContent = visible ? 'Объясните слово, не называя его и однокоренные слова.' : g.notice || 'Слово приходит с сервера только объясняющему.';
  $('#correctBtn').disabled = !visible;
  $('#skipBtn').disabled = !visible;
  $('#hostPanel').hidden = !host;
  $('#hostCountBtn').disabled = !host || !g.lastAction || g.lastAction.awarded;
  $('#hostNotCountBtn').disabled = !host || !g.lastAction || !g.lastAction.awarded;
  $('#lastAction').textContent = g.lastAction ? `«${g.lastAction.word}» · ${g.lastAction.awarded ? 'засчитано' : 'не засчитано'}` : 'Здесь появится последнее завершённое слово.';
  renderTeams();
  const nextScoreKey = JSON.stringify(state.teams);
  if (scoreKey !== nextScoreKey) {
    scoreKey = nextScoreKey; $('#scores').replaceChildren();
    for (const team of Object.values(state.teams).sort((a, b) => b.score - a.score)) {
      const card = document.createElement('div'); card.className = 'scoreCard';
      const title = document.createElement('div'); title.className = 'name'; title.textContent = team.name;
      const points = document.createElement('div'); points.className = 'pts'; points.textContent = `${team.score} очк.`;
      card.append(title, points); $('#scores').append(card);
    }
  }
}
$('#nameForm').addEventListener('submit', (event) => {
  event.preventDefault(); const name = $('#nameInput').value.trim();
  if (name) { localStorage.setItem('alias-name', name); send('SET_NAME', { name }); }
});
$('#teamForm').addEventListener('submit', (event) => {
  event.preventDefault(); send('CREATE_TEAM', { name: $('#teamName').value }); $('#teamName').value = '';
});
$('#roundForm').addEventListener('submit', (event) => { event.preventDefault(); send('SET_ROUND_SECONDS', { seconds: Number($('#roundSeconds').value) }); });
for (const [id, type] of [['startBtn', 'START_GAME'], ['pauseBtn', 'PAUSE_GAME'], ['resumeBtn', 'RESUME_GAME'], ['endTurnBtn', 'END_TURN'], ['resetBtn', 'RESET_GAME']]) $( `#${id}`).onclick = () => send(type);
$('#correctBtn').onclick = () => send('MARK', { action: 'correct', wordId: state.game.wordId });
$('#skipBtn').onclick = () => send('MARK', { action: 'skip', wordId: state.game.wordId });
$('#hostCountBtn').onclick = () => send('HOST_OVERRIDE_LAST', { decision: 'count', actionId: state.game.lastAction?.id });
$('#hostNotCountBtn').onclick = () => send('HOST_OVERRIDE_LAST', { decision: 'not_count', actionId: state.game.lastAction?.id });
$('#copyLinkBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); notify('Ссылка на комнату скопирована.'); }
  catch { prompt('Скопируйте ссылку на комнату', location.href); }
};
connect();
