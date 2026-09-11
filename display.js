/* ---------- Helpers ---------- */
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function playerById(id) {
  return players.find(p => p.id === id);
}

function pairKey(a, b) {
  return [a, b].sort().join('_');
}

function formTeams(ids) {
  if (!ids || ids.length < 4) return null;
  const [a, b, c, d] = ids;
  const options = [
    { teamA: [a, b], teamB: [c, d] },
    { teamA: [a, c], teamB: [b, d] },
    { teamA: [a, d], teamB: [b, c] },
  ];

  let best = [];
  let bestScore = Infinity;

  options.forEach(opt => {
    const scoreA = history.includes(pairKey(opt.teamA[0], opt.teamA[1])) ? 1 : 0;
    const scoreB = history.includes(pairKey(opt.teamB[0], opt.teamB[1])) ? 1 : 0;
    const score = scoreA + scoreB;
    if (score < bestScore) {
      bestScore = score;
      best = [opt];
    } else if (score === bestScore) {
      best.push(opt);
    }
  });
  return best[Math.floor(Math.random() * best.length)];
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function fmtClock(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/* Cache team pairings so they don't get re-randomized every 2.5s render tick.
   Keyed by the sorted player ids in the group — same 4 players = same pairing. */
let teamsCache = {};

function formTeamsStable(ids) {
  if (!ids || ids.length < 4) return null;
  const key = [...ids].sort().join('_');
  if (teamsCache[key]) return teamsCache[key];
  const teams = formTeams(ids);
  teamsCache[key] = teams;
  return teams;
}

/* Small player chip used in NEXT UP / LATER */
function miniPlayerBox(id) {
  const p = playerById(id) || { name: '—' };
  const initial = (p.name || '?').charAt(0).toUpperCase();
  return `
    <div class="mini-player">
      <div class="mini-avatar">${escapeHtml(initial)}</div>
      <div class="mini-name">${escapeHtml(p.name)}</div>
    </div>`;
}

/* ---------- State ---------- */
let players = [];
let queue = [];
let court = null;
let history = [];
let currentStartTime = null;
let lastCourtKey = null;

/* ---------- Logo (same as admin) ---------- */
const logoImg = document.getElementById('logoImg');
const logoPlaceholder = document.getElementById('logoPlaceholder');

function applyLogo(data) {
  if (!data) return;
  logoImg.src = data;
  logoImg.hidden = false;
  logoPlaceholder.hidden = true;
}

// Load logo from localStorage (same key as admin)
const logoData = load('cq_logo', null);
if (logoData) {
  applyLogo(logoData);
} else {
  // fallback try
  try {
    logoImg.src = 'abclogo.jfif';
    logoImg.hidden = false;
    logoPlaceholder.hidden = true;
  } catch (e) {}
}

/* ---------- Theme ---------- */
const themeToggle = document.getElementById('themeToggle');
const body = document.body;

function applyTheme(theme) {
  if (theme === 'dark') {
    body.classList.add('dark-mode');
    themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
  } else {
    body.classList.remove('dark-mode');
    themeToggle.innerHTML = '<i class="fas fa-moon"></i>';
  }
  localStorage.setItem('cq_display_theme', theme);
}

const savedTheme = localStorage.getItem('cq_display_theme') || 'dark';
applyTheme(savedTheme);

themeToggle.onclick = () => {
  const next = body.classList.contains('dark-mode') ? 'light' : 'dark';
  applyTheme(next);
};

/* ---------- Render ---------- */
function getCourtKey(c) {
  if (!c) return 'empty';
  return [...c.teamA, ...c.teamB].join('-') + '|' + c.start;
}

function renderCourt() {
  const card = document.getElementById('courtCard');
  const liveDot = document.getElementById('liveDot');
  const panel = document.getElementById('inPlayPanel');

  const key = getCourtKey(court);

  // Only rebuild when players actually change (keeps timer smooth)
  if (key === lastCourtKey) return;
  lastCourtKey = key;

  if (!court) {
    liveDot.classList.remove('live');
    panel.classList.remove('live-panel');
    currentStartTime = null;
    card.innerHTML = `
      <div class="empty-msg">
        Court is free<br>
        <small style="opacity:0.7">Waiting for the next game...</small>
      </div>`;
    return;
  }

  liveDot.classList.add('live');
  panel.classList.add('live-panel');
  currentStartTime = court.start;

  const p1 = playerById(court.teamA[0]);
  const p2 = playerById(court.teamA[1]);
  const p3 = playerById(court.teamB[0]);
  const p4 = playerById(court.teamB[1]);

  card.innerHTML = `
    <div style="text-align:center;">
      <div class="court-label">Court 1</div>
      <div class="court-timer" id="courtTimer">00:00</div>

      <div class="players-grid">
        <div class="player-box">
          <div class="avatar">${(p1?.name || '?').charAt(0).toUpperCase()}</div>
          <div>${escapeHtml(p1?.name || '—')}</div>
        </div>
        <div class="player-box">
          <div class="avatar">${(p3?.name || '?').charAt(0).toUpperCase()}</div>
          <div>${escapeHtml(p3?.name || '—')}</div>
        </div>
        <div class="player-box">
          <div class="avatar">${(p2?.name || '?').charAt(0).toUpperCase()}</div>
          <div>${escapeHtml(p2?.name || '—')}</div>
        </div>
        <div class="player-box">
          <div class="avatar">${(p4?.name || '?').charAt(0).toUpperCase()}</div>
          <div>${escapeHtml(p4?.name || '—')}</div>
        </div>
        <div class="vs-badge">VS</div>
      </div>
    </div>`;
}

/* Build the markup for one queued game: each player gets their own mini box */
function renderGameGroup(g, title, need) {
  // Full group of 4 -> try to split into two teams and show them "vs" style
  if (g.length === 4) {
    const teams = formTeamsStable(g);
    if (teams) {
      return `
        <div class="next-game">
          <div class="g-title">${title}${need}</div>
          <div class="mini-match">
            <div class="mini-team">
              ${teams.teamA.map(id => miniPlayerBox(id)).join('')}
            </div>
            <div class="mini-vs">VS</div>
            <div class="mini-team">
              ${teams.teamB.map(id => miniPlayerBox(id)).join('')}
            </div>
          </div>
        </div>`;
    }
  }

  // Fewer than 4 players (still waiting for the group to fill up) -> flat row of boxes
  return `
    <div class="next-game">
      <div class="g-title">${title}${need}</div>
      <div class="mini-players-flat">
        ${g.map(id => miniPlayerBox(id)).join('')}
      </div>
    </div>`;
}

function renderNextGames() {
  const el = document.getElementById('nextGames');

  if (!queue || queue.length === 0) {
    teamsCache = {};
    el.innerHTML = `<div class="empty-msg">No upcoming games</div>`;
    return;
  }

  const groups = [];
  for (let i = 0; i < queue.length; i += 4) {
    groups.push(queue.slice(i, i + 4));
  }

  el.innerHTML = groups.slice(0, 2).map((g, gi) => {
    const title = gi === 0 ? 'Next' : 'Later';
    const need = g.length < 4 ? ` · needs ${4 - g.length}` : '';
    return renderGameGroup(g, title, need);
  }).join('');
}

function renderTop3() {
  const el = document.getElementById('top3List');
  const top = [...players].sort((a, b) => b.wins - a.wins).slice(0, 3);

  if (!top.length) {
    el.innerHTML = `<div class="empty-msg">No games finished yet</div>`;
    return;
  }

  el.innerHTML = top.map((p, i) => {
    const rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : 'r3';
    return `
      <div class="list-row top3">
        <div class="row-left">
          <span class="rank-badge ${rankClass}">${i + 1}</span>
          <span class="name">${escapeHtml(p.name)}</span>
        </div>
        <span class="wins">${p.wins} win${p.wins === 1 ? '' : 's'}</span>
      </div>`;
  }).join('');
}

function render() {
  players = load('cq_players', []);
  queue   = load('cq_queue', []);
  court   = load('cq_court', null);
  history = load('cq_history', []);

  // Also refresh logo in case admin changed it
  const latestLogo = load('cq_logo', null);
  if (latestLogo) applyLogo(latestLogo);

  renderCourt();
  renderNextGames();
  renderTop3();
}

/* ---------- Smooth Timer ---------- */
setInterval(() => {
  // Navbar clock
  const clockEl = document.getElementById('clockTime');
  if (clockEl) {
    clockEl.textContent = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  // Game timer – only updates the number
  if (currentStartTime) {
    const timerEl = document.getElementById('courtTimer');
    if (timerEl) {
      timerEl.textContent = fmtClock(Date.now() - currentStartTime);
    }
  }
}, 1000);

/* ---------- Data refresh ---------- */
setInterval(render, 2500);

/* ---------- First load ---------- */
render();