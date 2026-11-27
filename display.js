/* ---------- State ---------- */
let players = [];
let queue = [];
let courts = [null, null]; // courts[0] = Court 1, courts[1] = Court 2
let history = [];          // teammate pairs (written by admin)
let oppHistory = [];       // opponent pairs (written by admin)
let matchHistory = [];     // finished games with scores (written by admin)
let lockedPairs = [];      // fixed teammates (written by admin)
let lockMode = false;
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

function gamesPlayedOf(id) {
  const p = playerById(id);
  return p && typeof p.gamesPlayed === 'number' && !isNaN(p.gamesPlayed) ? p.gamesPlayed : 0;
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
   MATCHMAKING - MUST STAY IDENTICAL TO THE ADMIN PAGE (index.js)
   This page and the admin page are separate scripts with no shared runtime,
   so both run the exact same deterministic logic on the same saved data
   (players, queue, history, oppHistory). Same inputs = same Next/Later
   groups and the same teams as the admin sees. If you change anything in
   this section, change it in the admin script too.
   ========================================================================== */

/* How many rested players (front of line) are considered for the next 4.
   Must equal MIX_WINDOW in the admin script. */
const MIX_WINDOW = 8;
const MAX_GAMES = 7;

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

  // Locked teammates: two locked pairs always play as the two teams
  if (lockMode && partnerOf(a) === b && partnerOf(c) === d) {
    return { teamA: [a, b], teamB: [c, d] };
  }
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
  return [...ids].sort().join('_') + '|' + history.length + '|' + oppHistory.length + '|' + lockSig();
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
    .filter((id, i) => !onCourt.has(id) && queue.indexOf(id) === i && gamesPlayedOf(id) < MAX_GAMES)
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

/* ---------- Locked teammates ----------
   When "Lock teammates" is ON, admin sets fixed pairs. A pair always plays
   together (same team every game) and only the opponents change. */
const LOCK_WINDOW = 6;

function partnerOf(id) {
  for (const pr of lockedPairs) {
    if (pr[0] === id) return pr[1];
    if (pr[1] === id) return pr[0];
  }
  return null;
}

function lockSig() {
  return lockMode ? lockedPairs.map(p => p.join('+')).join(',') : 'off';
}

/* Pairs where BOTH partners are in the ranked list, longest-waiting first */
function lockedUnits(ranked) {
  const pos = new Map(ranked.map((id, i) => [id, i]));
  const seen = new Set();
  const units = [];
  ranked.forEach(id => {
    if (seen.has(id)) return;
    const mate = partnerOf(id);
    if (mate && pos.has(mate) && !seen.has(mate)) {
      seen.add(id); seen.add(mate);
      units.push([id, mate]);
    }
  });
  const rest = u => Math.max(skipOf(u[0]), skipOf(u[1]));
  const first = u => Math.min(pos.get(u[0]), pos.get(u[1]));
  return units.sort((a, b) => (rest(a) - rest(b)) || (first(a) - first(b)));
}

/* Pick 2 pairs: the longest-waiting pair + the pair they've faced least.
   Opponents are only chosen from the pairs with the least rest remaining. */
function pickLockedFour(ranked) {
  const units = lockedUnits(ranked);
  if (units.length < 2) return null;

  const rest = u => Math.max(skipOf(u[0]), skipOf(u[1]));
  const head = units[0];
  const pool = units.slice(1, LOCK_WINDOW + 1).filter(u => rest(u) <= rest(units[1]));

  const opp = countPairs(oppHistory);
  let best = pool[0];
  let bestScore = Infinity;
  pool.forEach(u => {
    let score = 0;
    head.forEach(x => u.forEach(y => { score += opp[pairKey(x, y)] || 0; }));
    if (score < bestScore) { best = u; bestScore = score; }
  });
  return [...head, ...best];
}

function pickFourFrom(ranked) {
  if (lockMode) return pickLockedFour(ranked);
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
    if (!g) {
      const rest = lockMode ? lockedUnits(pool).flat() : pool;
      if (rest.length) groups.push(rest);
      break;
    }
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

let appliedLogoData = null;

function applyLogo(data) {
  if (!data || data === appliedLogoData) return;
  appliedLogoData = data;
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

  const key = getCourtsKey(courts) + '#' + players.map(p => p.id + ':' + p.name).join(',');

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

/* Latest 4 finished games with scores (winner highlighted) */
function renderResults() {
  const el = document.getElementById('resultsList');
  if (!el) return;
  const recent = matchHistory.slice(-4).reverse();
  if (!recent.length) {
    el.innerHTML = `<div class="empty-msg">No scores yet</div>`;
    return;
  }
  const names = (saved, ids) =>
    (saved || ids.map(id => (playerById(id) || { name: '—' }).name))
      .map(escapeHtml).join(' &amp; ');

  el.innerHTML = recent.map(m => {
    const aWin = m.winner === 'A';
    return `
      <div class="result-row">
        <span class="result-court">C${m.court}</span>
        <span class="result-team ${aWin ? 'win' : ''}">${names(m.teamANames, m.teamA)}</span>
        <span class="result-score"><b class="${aWin ? 'win' : ''}">${m.scoreA}</b> – <b class="${aWin ? '' : 'win'}">${m.scoreB}</b></span>
        <span class="result-team right ${aWin ? '' : 'win'}">${names(m.teamBNames, m.teamB)}</span>
      </div>`;
  }).join('');
}

/* Points scored / conceded per player, from saved match scores */
function playerStats() {
  const s = {};
  players.forEach(p => { s[p.id] = { pf: 0, pa: 0 }; });
  matchHistory.forEach(m => {
    (m.teamA || []).forEach(id => { if (s[id]) { s[id].pf += m.scoreA; s[id].pa += m.scoreB; } });
    (m.teamB || []).forEach(id => { if (s[id]) { s[id].pf += m.scoreB; s[id].pa += m.scoreA; } });
  });
  return s;
}

/* Ranking: wins, then point difference, then points scored, then name */
function rankedPlayers() {
  const st = playerStats();
  const diff = p => st[p.id].pf - st[p.id].pa;
  return [...players].sort((a, b) =>
    (b.wins || 0) - (a.wins || 0) ||
    diff(b) - diff(a) ||
    st[b.id].pf - st[a.id].pf ||
    a.name.localeCompare(b.name)
  );
}

function renderTop3() {
  const el = document.getElementById('top3List');
  const top = rankedPlayers().slice(0, 3);

  if (!top.length) {
    el.innerHTML = `<div class="empty-msg">No games finished yet</div>`;
    return;
  }

  el.innerHTML = top.map((p, i) => {
    const rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : 'r3';
    const st = playerStats()[p.id] || { pf: 0, pa: 0 };
    const d = st.pf - st.pa;
    return `
      <div class="list-row top3">
        <div class="row-left">
          <span class="rank-badge ${rankClass}">${i + 1}</span>
          <span class="name">${escapeHtml(p.name)}</span>
        </div>
        <div class="row-right">
          <span class="games-tag">${d > 0 ? '+' : ''}${d} pts</span>
          <span class="wins">${p.wins || 0} win${(p.wins || 0) === 1 ? '' : 's'}</span>
        </div>
      </div>`;
  }).join('');
}

function render() {
  players      = load('cq_players', []);
  queue        = load('cq_queue', []);
  courts       = loadCourts();
  history      = load('cq_history', []);
  oppHistory   = load('cq_oppHistory', []);
  matchHistory = load('cq_matchHistory', []);
  lockedPairs  = load('cq_lockedPairs', []);
  lockMode     = load('cq_lockMode', false) === true;

  // Also refresh logo in case admin changed it
  const latestLogo = load('cq_logo', null);
  if (latestLogo) applyLogo(latestLogo);

  renderCourt();
  renderNextGames();
  renderResults();
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