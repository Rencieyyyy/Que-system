/* ---------- State ---------- */
let players = [];
let queue = [];
let courts = [null, null]; // courts[0] = Court 1, courts[1] = Court 2
let history = [];          // teammate pairs (written by admin)
let oppHistory = [];       // opponent pairs (written by admin)
let courtStartTimes = [null, null];
let lastCourtsKey = null;

/* ---------- Helpers ---------- */
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    // Bad/corrupted saved data (wrong type) falls back instead of breaking the page
    if (Array.isArray(fallback) && !Array.isArray(val)) return fallback;
    return val;
  } catch (e) {
    return fallback;
  }
}

function playerById(id) {
  return players.find(p => p.id === id);
}

function skipOf(id) {
  const p = playerById(id);
  return p && typeof p.skip === 'number' && !isNaN(p.skip) ? p.skip : 0;
}

function pairKey(a, b) {
  return [a, b].sort().join('_');
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

/* Load courts data, migrating from the old single-court format if needed */
function loadCourts() {
  const stored = load('cq_courts', null);
  if (Array.isArray(stored)) {
    return [stored[0] || null, stored[1] || null];
  }
  const legacy = load('cq_court', null);
  return [legacy || null, null];
}

/* ==========================================================================
   MATCHMAKING — MUST STAY IDENTICAL TO THE ADMIN PAGE (courtqueue.js)
   This page and the admin page are separate scripts with no shared runtime,
   so both run the exact same deterministic logic on the same saved data
   (players, queue, history, oppHistory). Same inputs = same Next/Later
   groups and the same teams as the admin sees. If you change anything in
   this section, change it in the admin script too.
   ========================================================================== */

/* How many rested players (front of line) are considered for the next 4.
   Must equal MIX_WINDOW in the admin script. */
const MIX_WINDOW = 8;

function countPairs(list) {
  const m = {};
  list.forEach(k => { m[k] = (m[k] || 0) + 1; });
  return m;
}

/* Repeat teammates weigh 3x more than repeat opponents */
function togetherScore(a, b, tm, opp) {
  const k = pairKey(a, b);
  return (tm[k] || 0) * 3 + (opp[k] || 0);
}

function stableShuffleIndex(seedStr, mod) {
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  return hash % mod;
}

function formTeams(ids) {
  if (!ids || ids.length < 4) return null;
  const [a, b, c, d] = ids;
  const tm  = countPairs(history);
  const opp = countPairs(oppHistory);

  const options = [
    { teamA: [a, b], teamB: [c, d] },
    { teamA: [a, c], teamB: [b, d] },
    { teamA: [a, d], teamB: [b, c] },
  ];

  const scored = options.map(o => {
    const [p, q] = o.teamA;
    const [r, s] = o.teamB;
    const teammateRepeats = (tm[pairKey(p, q)] || 0) + (tm[pairKey(r, s)] || 0);
    const opponentRepeats =
      (opp[pairKey(p, r)] || 0) + (opp[pairKey(p, s)] || 0) +
      (opp[pairKey(q, r)] || 0) + (opp[pairKey(q, s)] || 0);
    return { o, score: teammateRepeats * 3 + opponentRepeats };
  });

  const min  = Math.min(...scored.map(s => s.score));
  const best = scored.filter(s => s.score === min).map(s => s.o);
  if (best.length === 1) return best[0];

  const seed = [...ids].sort().join('_') + '|' + history.length;
  return best[stableShuffleIndex(seed, best.length)];
}

/* Cache so the preview doesn't recompute every 2.5s tick. The key includes
   history lengths so it refreshes whenever admin records a new game. */
let teamsCache = {};

function teamsCacheKey(ids) {
  return [...ids].sort().join('_') + '|' + history.length + '|' + oppHistory.length;
}

function formTeamsStable(ids) {
  if (!ids || ids.length < 4) return null;
  const key = teamsCacheKey(ids);
  if (teamsCache[key]) return teamsCache[key];
  const teams = formTeams(ids);
  teamsCache[key] = teams;
  return teams;
}

/* Queue ranked by: least rest remaining first, then FIFO */
function rankedQueue() {
  // Skip duplicates and anyone already on a court (matches admin's queue cleanup)
  const onCourt = new Set();
  courts.forEach(c => { if (c) [...c.teamA, ...c.teamB].forEach(id => onCourt.add(id)); });
  return queue
    .filter((id, i) => !onCourt.has(id) && queue.indexOf(id) === i)
    .map((id, index) => ({ id, index, player: playerById(id) }))
    .filter(entry => entry.player)
    .sort((a, b) => {
      const skipDiff = skipOf(a.id) - skipOf(b.id);
      if (skipDiff !== 0) return skipDiff;
      return a.index - b.index;
    })
    .map(entry => entry.id);
}

/* Keep the longest-waiting player, then choose the 3 others that make the
   least-familiar group of 4 */
function bestMixedFour(candidates) {
  if (candidates.length <= 4) return candidates.slice(0, 4);

  const tm  = countPairs(history);
  const opp = countPairs(oppHistory);
  const head = candidates[0];
  const rest = candidates.slice(1);

  let best = null;
  let bestScore = Infinity;
  let bestOrder = Infinity;

  for (let i = 0; i < rest.length - 2; i++) {
    for (let j = i + 1; j < rest.length - 1; j++) {
      for (let k = j + 1; k < rest.length; k++) {
        const group = [head, rest[i], rest[j], rest[k]];

        let score = 0;
        for (let x = 0; x < 4; x++) {
          for (let y = x + 1; y < 4; y++) {
            score += togetherScore(group[x], group[y], tm, opp);
          }
        }

        const order = i + j + k;
        if (score < bestScore || (score === bestScore && order < bestOrder)) {
          best = group;
          bestScore = score;
          bestOrder = order;
        }
      }
    }
  }
  return best;
}

function pickFourFrom(ranked) {
  if (ranked.length < 4) return null;

  const rested = ranked.filter(id => skipOf(id) === 0);

  // Small roster: not enough fully-rested players, pull in whoever has the
  // least rest left (same fallback as admin)
  if (rested.length < 4) return ranked.slice(0, 4);

  return bestMixedFour(rested.slice(0, MIX_WINDOW));
}

/* Upcoming groups, built exactly like the admin's Queue / Next / Later */
function buildGroups(maxGroups = Infinity) {
  let pool = rankedQueue();
  const groups = [];
  let guard = 0; // hard stop so a bad state can never loop forever
  while (pool.length && groups.length < maxGroups && guard++ < 50) {
    const g = pickFourFrom(pool);
    if (!g) { groups.push(pool); break; }
    groups.push(g);
    pool = pool.filter(id => !g.includes(id));
  }
  return groups;
}

/* ---------- Mini player chip used in NEXT UP / LATER ---------- */
function miniPlayerBox(id) {
  const p = playerById(id) || { name: '—' };
  return `
    <div class="mini-player">
      <div class="mini-name">${escapeHtml(p.name)}</div>
    </div>`;
}

/* ---------- Logo (same as admin) ---------- */
const logoImg = document.getElementById('logoImg');
const logoPlaceholder = document.getElementById('logoPlaceholder');

function applyLogo(data) {
  if (!data) return;
  logoImg.src = data;
  logoImg.hidden = false;
  logoPlaceholder.hidden = true;
}

const logoData = load('cq_logo', null);
if (logoData) {
  applyLogo(logoData);
} else {
  try {
    logoImg.src = 'abclogo.jpg';
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
function getCourtsKey(cs) {
  return cs.map(c => c ? [...c.teamA, ...c.teamB].join('-') + '|' + c.start : 'empty').join('~');
}

function renderCourt() {
  const card = document.getElementById('courtCard');
  const liveDot = document.getElementById('liveDot');
  const panel = document.getElementById('inPlayPanel');

  const key = getCourtsKey(courts);

  // Only rebuild when the courts actually change (keeps timers smooth)
  if (key === lastCourtsKey) return;
  lastCourtsKey = key;

  const anyLive = courts.some(Boolean);
  liveDot.classList.toggle('live', anyLive);
  panel.classList.toggle('live-panel', anyLive);

  courtStartTimes = courts.map(c => (c ? c.start : null));

  card.innerHTML = courts.map((court, i) => {
    const courtNum = i + 1;

    if (!court) {
      return `
        <div class="court-block">
          <div class="court-label">Court ${courtNum}</div>
          <div class="empty-msg" style="padding:14px 8px;">
            Court is free<br><small style="opacity:0.7">Waiting for the next game...</small>
          </div>
        </div>`;
    }

    const p1 = playerById(court.teamA[0]);
    const p2 = playerById(court.teamA[1]);
    const p3 = playerById(court.teamB[0]);
    const p4 = playerById(court.teamB[1]);

    return `
      <div class="court-block">
        <div class="court-label">Court ${courtNum}</div>
        <div class="court-timer" id="courtTimer-${i}">00:00</div>
        <div class="players-grid">
          <div class="player-box">
            <div>${escapeHtml(p1?.name || '—')}</div>
          </div>
          <div class="player-box">
            <div>${escapeHtml(p3?.name || '—')}</div>
          </div>
          <div class="player-box">
            <div>${escapeHtml(p2?.name || '—')}</div>
          </div>
          <div class="player-box">
            <div>${escapeHtml(p4?.name || '—')}</div>
          </div>
          <div class="vs-badge">VS</div>
        </div>
      </div>`;
  }).join('');
}

/* Markup for one queued game: each player gets their own mini box */
function renderGameGroup(g, title, need) {
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

  // Fewer than 4 players (still waiting for the group to fill up)
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

  const groups = buildGroups(2);

  if (!groups.length) {
    teamsCache = {};
    el.innerHTML = `<div class="empty-msg">No upcoming games</div>`;
    return;
  }

  el.innerHTML = groups.map((g, gi) => {
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
  players    = load('cq_players', []);
  queue      = load('cq_queue', []);
  courts     = loadCourts();
  history    = load('cq_history', []);
  oppHistory = load('cq_oppHistory', []);

  // Also refresh logo in case admin changed it
  const latestLogo = load('cq_logo', null);
  if (latestLogo) applyLogo(latestLogo);

  renderCourt();
  renderNextGames();
  renderTop3();
}

/* ---------- Smooth Timer ---------- */
setInterval(() => {
  const clockEl = document.getElementById('clockTime');
  if (clockEl) {
    clockEl.textContent = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  courtStartTimes.forEach((start, i) => {
    if (start) {
      const timerEl = document.getElementById('courtTimer-' + i);
      if (timerEl) {
        timerEl.textContent = fmtClock(Date.now() - start);
      }
    }
  });
}, 1000);

/* ---------- Data refresh ---------- */
setInterval(render, 2500);

/* ---------- First load ---------- */
render();