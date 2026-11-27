/* ---------- State ---------- */
let players     = load('cq_players', []);
let queue       = load('cq_queue', []);
let courts      = loadCourts();          // [Court 1, Court 2] - each is null or {teamA, teamB, start}
let history     = load('cq_history', []);       // every pair that has been TEAMMATES (one entry per game per team)
let oppHistory  = load('cq_oppHistory', []);    // every pair that has been OPPONENTS (4 entries per game)
let matchHistory = load('cq_matchHistory', []);  // completed matches with scores
let gameTimes   = load('cq_gameTimes', []);
let lockedPairs = load('cq_lockedPairs', []);   // [[idA, idB], ...] fixed teammates
let lockMode    = load('cq_lockMode', false) === true;

const MAX_GAMES = 7;

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    // Bad/corrupted saved data (wrong type) falls back instead of breaking the app
    if (Array.isArray(fallback) && !Array.isArray(val)) return fallback;
    return val;
  } catch (e) { return fallback; }
}

/* Load the 2-court array, migrating old single-court saves (cq_court) if found */
function loadCourts() {
  const stored = load('cq_courts', null);
  if (Array.isArray(stored)) {
    return [stored[0] || null, stored[1] || null];
  }
  const legacy = load('cq_court', null);
  return [legacy || null, null];
}

/* Make sure every player has counters used by matchmaking/UI.
   Old saved data may be missing these fields. */
function normalizePlayers() {
  players.forEach(p => {
    if (typeof p.skip !== 'number' || isNaN(p.skip)) p.skip = 0;
    if (typeof p.gamesPlayed !== 'number' || isNaN(p.gamesPlayed)) p.gamesPlayed = 0;
    if (typeof p.wins !== 'number' || isNaN(p.wins)) p.wins = 0;
  });
}

function isMaxedOut(playerOrId) {
  const p = typeof playerOrId === 'string' ? playerById(playerOrId) : playerOrId;
  return !!p && (p.gamesPlayed || 0) >= MAX_GAMES;
}

normalizePlayers();
syncQueueWithPlayers();

/* Guarantee invariant: every eligible player who exists and isn't currently
   on a court is somewhere in the queue. Players who reached the max games
   limit are kept out of the playable queue. Checked and repaired every render. */
function syncQueueWithPlayers() {
  // Clean locked pairs: both players must exist, no player in two pairs
  const usedInPair = new Set();
  lockedPairs = lockedPairs.filter(pr =>
    Array.isArray(pr) && pr.length === 2 && pr[0] !== pr[1] &&
    playerById(pr[0]) && playerById(pr[1]) &&
    !usedInPair.has(pr[0]) && !usedInPair.has(pr[1]) &&
    (usedInPair.add(pr[0]), usedInPair.add(pr[1]), true)
  );

  const onCourtIds = new Set();
  courts.forEach(c => {
    if (c) {
      c.teamA.forEach(id => onCourtIds.add(id));
      c.teamB.forEach(id => onCourtIds.add(id));
    }
  });

  // Drop queue entries for players that no longer exist, duplicates,
  // anyone who is currently on a court, or anyone who reached the max games limit
  queue = queue.filter((id, i) => {
    const p = playerById(id);
    return p && !onCourtIds.has(id) && !isMaxedOut(p) && queue.indexOf(id) === i;
  });

  // Anyone eligible, not on court, and missing from the queue gets appended to the back
  players.forEach(p => {
    if (!onCourtIds.has(p.id) && !isMaxedOut(p) && !queue.includes(p.id)) {
      queue.push(p.id);
    }
  });
}

function save() {
  localStorage.setItem('cq_players', JSON.stringify(players));
  localStorage.setItem('cq_queue', JSON.stringify(queue));
  localStorage.setItem('cq_courts', JSON.stringify(courts));
  localStorage.setItem('cq_history', JSON.stringify(history));
  localStorage.setItem('cq_oppHistory', JSON.stringify(oppHistory));
  localStorage.setItem('cq_matchHistory', JSON.stringify(matchHistory));
  localStorage.setItem('cq_gameTimes', JSON.stringify(gameTimes));
  localStorage.setItem('cq_lockedPairs', JSON.stringify(lockedPairs));
  localStorage.setItem('cq_lockMode', JSON.stringify(lockMode));
  localStorage.removeItem('cq_court'); // legacy key no longer used
}

function uid() { return 'p' + Math.random().toString(36).slice(2, 9); }
function playerById(id) { return players.find(p => p.id === id); }
function pairKey(a, b) { return [a, b].sort().join('_'); }
function isPlayerOnAnyCourt(id) {
  return courts.some(c => c && (c.teamA.includes(id) || c.teamB.includes(id)));
}

/* ---------- Pair counting ----------
   Remember how many times every pair has been teammates AND opponents,
   then choose the group of 4 (and the split into teams) that has played
   together the LEAST. Everything is deterministic, so the Next/Later
   preview always matches what actually happens. */

function countPairs(list) {
  const m = {};
  list.forEach(k => { m[k] = (m[k] || 0) + 1; });
  return m;
}

/* How "familiar" two players are. Repeat teammates weigh 3x more than
   repeat opponents, since being partnered again is what feels stale. */
function togetherScore(a, b, tm, opp) {
  const k = pairKey(a, b);
  return (tm[k] || 0) * 3 + (opp[k] || 0);
}

/* ---------- Smart team formation ---------- */
function formTeams(ids) {
  const [a, b, c, d] = ids;

  // Locked teammates: two locked pairs always play as the two teams
  // (ids arrive as [team1, team1, team2, team2] from pickLockedFour)
  if (lockMode) {
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

  // Still tied: stable (not random) pick so admin page and TV display agree
  const seed = [...ids].sort().join('_') + '|' + history.length;
  return best[stableShuffleIndex(seed, best.length)];
}

function stableShuffleIndex(seedStr, mod) {
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  return hash % mod;
}

/* Cache so the "Next"/"Later" preview shows the exact teams that get put
   on court. Cleared whenever a game starts (history changes). */
let teamsCache = {};

function teamsCacheKey(ids) {
  return [...ids].sort().join('_') + '|' + history.length + '|' + lockSig();
}

function formTeamsStable(ids) {
  const key = teamsCacheKey(ids);
  if (teamsCache[key]) return teamsCache[key];
  const teams = formTeams(ids);
  teamsCache[key] = teams;
  return teams;
}

/* Remember who teamed with / played against whom */
function recordMatchup(teams) {
  const [a, b] = teams.teamA;
  const [c, d] = teams.teamB;
  history.push(pairKey(a, b), pairKey(c, d));
  oppHistory.push(pairKey(a, c), pairKey(a, d), pairKey(b, c), pairKey(b, d));
  teamsCache = {};
}

/* ---------- Fair rotation + mixing ---------- */

/* How many rested players (from the front of the line) are considered
   when picking the next 4. The person who has waited longest is ALWAYS
   included; the other 3 are chosen from this window to be the people
   they've played with least. */
const MIX_WINDOW = 8;

/* Queue ranked by: least rest remaining first, then FIFO. */
function rankedQueue() {
  return queue
    .map((id, index) => ({ id, index, player: playerById(id) }))
    .filter(entry => entry.player && !isMaxedOut(entry.player))
    .sort((a, b) => {
      const skipDiff = a.player.skip - b.player.skip;
      if (skipDiff !== 0) return skipDiff;
      return a.index - b.index;
    })
    .map(entry => entry.id);
}

/* From a list of candidates (front of line first), keep the head of the
   line and pick the 3 others that make the least-familiar group of 4. */
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

        // Ties go to whoever has waited longest (lowest queue positions)
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

function skipOf(id) {
  const p = playerById(id);
  return p && typeof p.skip === 'number' && !isNaN(p.skip) ? p.skip : 0;
}

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

/* Teams that are ready to play in lock mode:
   - locked pairs where BOTH partners are ready, and
   - unpaired players, teamed up two at a time (least-repeated teammates,
     similar rest), so locked pairs always have opponents from the queue.
   Longest-waiting teams first. */
function lockedUnits(ranked) {
  const pos = new Map(ranked.map((id, i) => [id, i]));
  const seen = new Set();
  const units = [];
  const free = [];
  ranked.forEach(id => {
    if (seen.has(id)) return;
    const mate = partnerOf(id);
    if (mate && playerById(mate) && !isMaxedOut(mate)) {
      // Locked: plays only with this partner (waits if the partner is busy)
      if (pos.has(mate) && !seen.has(mate)) {
        seen.add(id); seen.add(mate);
        units.push([id, mate]);
      }
    } else {
      free.push(id); // not paired (or partner already finished all games)
    }
  });

  const tm = countPairs(history);
  const pool = free.slice();
  while (pool.length >= 2) {
    const h = pool.shift();
    const win = [];
    for (let i = 0; i < Math.min(pool.length, 6); i++) win.push(i);
    const sameRest = win.filter(i => skipOf(pool[i]) === skipOf(h));
    const cand = sameRest.length ? sameRest : win;
    let bi = cand[0];
    let bs = Infinity;
    cand.forEach(i => {
      const sc = tm[pairKey(h, pool[i])] || 0;
      if (sc < bs) { bs = sc; bi = i; }
    });
    units.push([h, pool.splice(bi, 1)[0]]);
  }

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

function noGameMessage() {
  return lockMode
    ? 'Need at least 4 ready players in the queue to start a game (a locked pair counts as 2).'
    : 'Need at least 4 eligible players in the queue to start a game.';
}

/* Pick 4 from an already-ranked list, or null if fewer than 4 exist. */
function pickFourFrom(ranked) {
  if (lockMode) return pickLockedFour(ranked);
  if (ranked.length < 4) return null;

  const rested = ranked.filter(id => playerById(id).skip === 0);

  // Small roster: not enough fully-rested players, so pull in whoever has
  // the least rest left (otherwise the court would sit empty forever).
  if (rested.length < 4) return ranked.slice(0, 4);

  return bestMixedFour(rested.slice(0, MIX_WINDOW));
}

function pickNextFour() {
  return pickFourFrom(rankedQueue());
}

/* Every time a game starts, every resting player's wait ticks down. */
function tickRestCounters() {
  queue.forEach(id => {
    const p = playerById(id);
    if (p && p.skip > 0) p.skip -= 1;
  });
}

/* Non-destructive preview of upcoming groups, built with the exact same
   picker as real games so the Queue tab and Next/Later never lie. The
   last group may have fewer than 4 (needs more players). */
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

function nextEligibleGroups(maxGroups = 2) {
  return buildGroups(maxGroups);
}

/* ---------- Actions ---------- */
function addPlayer(name) {
  name = name.trim();
  if (!name) return;

  if (players.length >= 30) {
    alert('Maximum 30 players reached.');
    return;
  }

  const p = { id: uid(), name, wins: 0, skip: 0, gamesPlayed: 0 };
  players.push(p);
  queue.push(p.id); // new players always join at the back - fair line
  save();
  render();
}

function removePlayer(id) {
  if (isPlayerOnAnyCourt(id)) {
    alert("This player is currently on court.\nEnd the game first, then remove them.");
    return;
  }

  queue = queue.filter(pid => pid !== id);
  players = players.filter(p => p.id !== id);
  lockedPairs = lockedPairs.filter(pr => !pr.includes(id));
  teamsCache = {};
  save();
  render();
}

/* Put 4 players on a court: pull them from the queue, form teams, and
   record who teamed/faced whom. Shared by startGame and endGame. */
function beginGame(courtIndex, ids) {
  queue = queue.filter(id => !ids.includes(id));
  const teams = formTeamsStable(ids);
  recordMatchup(teams);
  courts[courtIndex] = { teamA: teams.teamA, teamB: teams.teamB, start: Date.now() };
}

/* Start a game on a specific court index (0 = Court 1, 1 = Court 2) */
function startGame(courtIndex) {
  if (courts[courtIndex]) {
    alert(`Court ${courtIndex + 1} already has a game in play.`);
    return;
  }

  const ids = pickNextFour();
  if (!ids) {
    alert(noGameMessage());
    return;
  }

  beginGame(courtIndex, ids);
  tickRestCounters();

  save();
  render();
  closeModal();
}

/* Decide whether to ask which court, auto-pick the only free one, or block */
function openStartGameModal() {
  if (!pickNextFour()) {
    alert(noGameMessage());
    return;
  }

  const freeIndexes = courts.map((c, i) => (c ? -1 : i)).filter(i => i !== -1);

  if (freeIndexes.length === 0) {
    alert('Both courts are currently in play. End a game first.');
    return;
  }

  if (freeIndexes.length === 1) {
    startGame(freeIndexes[0]);
    return;
  }

  modalTitle.textContent = 'Choose a court';
  modalBody.innerHTML = `
    <p style="margin:-4px 0 16px;color:var(--text-muted);font-size:0.9rem;">
      Which court should the next game start on?
    </p>
    ${courts.map((c, i) => `
      <button class="win-option" data-startcourt="${i}">
        <span class="wl">AVAILABLE</span>
        <span>Court ${i + 1}</span>
      </button>`).join('')}
    <button class="btn btn-secondary" id="cancelStart" style="width:100%;margin-top:8px">Cancel</button>`;
  overlay.classList.remove('hidden');

  modalBody.querySelectorAll('[data-startcourt]').forEach(btn => {
    btn.onclick = () => startGame(parseInt(btn.getAttribute('data-startcourt'), 10));
  });
  document.getElementById('cancelStart').onclick = closeModal;
}

function endGame(courtIndex, scoreA, scoreB, expectedStart) {
  const court = courts[courtIndex];
  if (!court) return;

  // The game on this court changed while the modal was open: don't score the wrong game
  if (expectedStart && court.start !== expectedStart) {
    alert('This game has already changed. Please reopen it and enter the score again.');
    closeModal();
    render();
    return;
  }

  const a = Number(scoreA);
  const b = Number(scoreB);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) {
    return;
  }

  const winner = a > b ? 'A' : 'B';
  const winners = winner === 'A' ? court.teamA : court.teamB;
  const losers  = winner === 'A' ? court.teamB : court.teamA;
  const finishedIds = [...court.teamA, ...court.teamB];
  const endedAt = Date.now();
  const duration = endedAt - court.start;

  // Every participant played a game (max 7 per player)
  finishedIds.forEach(id => {
    const p = playerById(id);
    if (p) p.gamesPlayed = (p.gamesPlayed || 0) + 1;
  });

  // Winners rest 1 game, losers rest 2 games, before being eligible again
  winners.forEach(id => {
    const p = playerById(id);
    if (p) { p.wins = (p.wins || 0) + 1; p.skip = 1; }
  });
  losers.forEach(id => {
    const p = playerById(id);
    if (p) { p.skip = 2; }
  });

  // Save names too, so removing/replacing a player never blanks old results
  const nameOf = id => (playerById(id) || { name: '—' }).name;
  matchHistory.push({
    court: courtIndex + 1,
    teamA: court.teamA.slice(),
    teamB: court.teamB.slice(),
    teamANames: court.teamA.map(nameOf),
    teamBNames: court.teamB.map(nameOf),
    scoreA: a,
    scoreB: b,
    winner,
    durationMs: duration,
    endedAt
  });

  gameTimes.push(duration);
  if (gameTimes.length > 20) gameTimes = gameTimes.slice(-20);

  // Finished players go to the BACK of the queue - no cutting ahead.
  // Players who reached the 7-game limit can no longer be queued.
  finishedIds.forEach(id => {
    if (!isMaxedOut(id)) queue.push(id);
  });

  courts[courtIndex] = null;

  // Auto-start the next game on the freed court if 4 players are available.
  // Rest counters only tick when a game actually starts.
  const nextIds = pickNextFour();
  if (nextIds) {
    beginGame(courtIndex, nextIds);
    tickRestCounters();
  }

  save();
  render();
  closeModal();
}

function resetAll() {
  if (!confirm('This clears all players, the queue, and the leaderboard. Continue?')) return;
  players = [];
  queue = [];
  courts = [null, null];
  history = [];
  oppHistory = [];
  matchHistory = [];
  teamsCache = {};
  gameTimes = [];
  save();
  render();
}

function replacePlayer(oldId, newName) {
  if (!newName) return;
  const oldIndex = players.findIndex(p => p.id === oldId);
  const newP = { id: uid(), name: newName, wins: 0, skip: 0, gamesPlayed: 0 };
  if (oldIndex !== -1) {
    players.splice(oldIndex, 1, newP);
  } else {
    players.push(newP);
  }
  queue = queue.map(pid => pid === oldId ? newP.id : pid);
  lockedPairs = lockedPairs.map(pr => pr.map(pid => pid === oldId ? newP.id : pid));
  teamsCache = {};
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  save();
  render();
  window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
}

/* ---------- Rendering helpers ---------- */
const els = {
  statWaiting: document.getElementById('statWaiting'),
  statAvg: document.getElementById('statAvg'),
  clockTime: document.getElementById('clockTime'),
  courtCard: document.getElementById('courtCard'),
  liveCount: document.getElementById('liveCount'),
  top3List: document.getElementById('top3List'),
  queueList: document.getElementById('queueList'),
  maxedList: document.getElementById('maxedList'),
  matchList: document.getElementById('matchList'),
  leaderList: document.getElementById('leaderList'),
  navQueueCount: document.getElementById('navQueueCount'),
  capacityCount: document.getElementById('capacityCount'),
  capacityProgress: document.getElementById('capacityProgress'),
  nextGames: document.getElementById('nextGames'),
};

function fmtClock(msElapsed) {
  const totalSec = Math.floor(msElapsed / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function teamName(ids) {
  return ids.map(id => (playerById(id) || { name: '—' }).name).join(' & ');
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function renderCourt() {
  const liveDot = document.getElementById('liveDot');
  const liveCountNum = courts.filter(Boolean).length;

  els.liveCount.textContent = `${liveCountNum} live`;
  if (liveDot) liveDot.classList.toggle('live', liveCountNum > 0);

  els.courtCard.innerHTML = courts.map((court, i) => {
    const courtNum = i + 1;

    if (!court) {
      return `
        <div class="court-card court-card-empty">
          <div class="court-top">
            <span class="court-name">Court ${courtNum}</span>
          </div>
          <div class="court-empty">
            <p>Court is free. ${(lockMode && !pickNextFour()) ? 'Waiting for enough players to start a game.' : queue.length < 4
              ? (players.some(isMaxedOut)
                  ? `Not enough players left (some already finished ${MAX_GAMES} games). Add more players to keep playing.`
                  : `Waiting on ${4 - queue.length} more player${4 - queue.length === 1 ? '' : 's'} to start a game.`)
              : 'Ready to start the next game.'}</p>
          </div>
        </div>`;
    }

    return `
      <div class="court-card">
        <div class="court-top">
          <span class="court-name">Court ${courtNum}</span>
          <span class="pill-live">Live</span>
        </div>
        <div class="court-timer" id="courtTimer-${i}">00:00</div>
        <div class="matchup">
          <div class="team">
            <i class="fas fa-users"></i>
            <span>${escapeHtml(teamName(court.teamA))}</span>
          </div>
          <div class="vs">VS</div>
          <div class="team">
            <i class="fas fa-users"></i>
            <span>${escapeHtml(teamName(court.teamB))}</span>
          </div>
        </div>
        <button class="btn-end" data-endcourt="${i}">
          <i class="fas fa-flag-checkered"></i> End Game
        </button>
      </div>`;
  }).join('');

  els.courtCard.querySelectorAll('[data-endcourt]').forEach(btn => {
    btn.onclick = () => openEndGameModal(parseInt(btn.getAttribute('data-endcourt'), 10));
  });
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

function leaderRow(p, i, top3) {
  const rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
  const canPrint = i < 3;
  const played = p.gamesPlayed || 0;
  const st = playerStats()[p.id] || { pf: 0, pa: 0 };
  const d = st.pf - st.pa;
  const diffTag = `${d > 0 ? '+' : ''}${d} pts`;
  const limitTag = played >= MAX_GAMES ? ' <i class="fas fa-check-circle" aria-hidden="true"></i> Max reached' : '';
  return `
    <div class="list-row leader-row ${top3 ? 'top3' : ''}">
      <div class="row-left">
        <span class="rank-badge ${rankClass}">${i < 3 ? '' : i + 1}</span>
        <span class="name">${escapeHtml(p.name)}</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
        <span class="wins">${p.wins} win${p.wins === 1 ? '' : 's'}</span>
        <span class="row-meta" title="Point difference">${diffTag}</span>
        <span class="row-meta">${played}/${MAX_GAMES} games${limitTag}</span>
        ${canPrint ? `<button class="btn-certificate" data-cert="${p.id}" title="Print certificate"><i class="fas fa-award"></i></button>` : ''}
      </div>
    </div>`;
}

function renderTop3() {
  const top = rankedPlayers().slice(0, 3);
  if (!top.length) {
    els.top3List.innerHTML = `<div class="empty-state">No games finished yet.</div>`;
    return;
  }
  els.top3List.innerHTML = `<div class="list-card">${top.map((p, i) => leaderRow(p, i, true)).join('')}</div>`;
  attachCertificateHandlers();
}

function renderLeaders() {
  const sorted = rankedPlayers();
  if (!sorted.length) {
    els.leaderList.innerHTML = `<div class="empty-state">Add players to start tracking wins.</div>`;
    return;
  }
  els.leaderList.innerHTML = `<div class="list-card">${sorted.map((p, i) => leaderRow(p, i, i < 3)).join('')}</div>`;
  attachCertificateHandlers();
}

function attachCertificateHandlers() {
  document.querySelectorAll('.btn-certificate').forEach(btn => {
    btn.onclick = () => {
      const player = playerById(btn.getAttribute('data-cert'));
      if (player) showCertificate(player);
    };
  });
}

function renderQueue() {
  els.statWaiting.textContent = queue.length;
  els.navQueueCount.textContent = queue.length;
  els.capacityCount.textContent = players.length;
  els.capacityProgress.style.width = (players.length / 30 * 100) + '%';

  if (!queue.length) {
    const msg = players.length
      ? `No eligible players waiting. Each player can play up to ${MAX_GAMES} games.`
      : `Nobody's waiting. Add players to build the queue.`;
    els.queueList.innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }

  // Groups come from the same picker real games use, so "Up next" always
  // matches who actually plays next.
  const groups = buildGroups();

  // Lock mode: players without a ready partner don't appear in any group
  const inGroups = new Set(groups.flat());
  const leftover = lockMode ? rankedQueue().filter(id => !inGroups.has(id)) : [];
  const leftoverHtml = leftover.length ? `
      <div class="queue-group">
        <div class="queue-group-head">
          <span class="queue-group-title">WAITING FOR A TEAMMATE · ${leftover.length}</span>
        </div>
        <div class="queue-players">
          ${leftover.map(id => {
            const p = playerById(id);
            return `<span class="player-chip">${escapeHtml(p ? p.name : '?')}
              <button data-replace="${id}" title="Replace player" aria-label="Replace player"><i class="fas fa-right-left" aria-hidden="true"></i></button>
              <button data-remove="${id}" title="Remove">&times;</button></span>`;
          }).join('')}
        </div>
      </div>` : '';

  els.queueList.innerHTML = `<div class="list-card">${
    groups.map((g, gi) => `
      <div class="queue-group">
        <div class="queue-group-head">
          <span class="queue-group-title">${
            gi === 0 && g.length === 4 ? 'Up next' : `Group ${gi + 1}`
          }${g.length < 4 ? ` · needs ${4 - g.length} more` : ''}</span>
        </div>
        <div class="queue-players">
          ${g.map(id => {
            const p = playerById(id);
            const played = p ? (p.gamesPlayed || 0) : 0;
            const restTag = p && p.skip > 0
              ? ` <span class="chip-meta"><i class="fas fa-clock" aria-hidden="true"></i> Resting: ${p.skip} left</span>`
              : '';
            const gamesTag = p ? ` <span class="chip-meta">${played}/${MAX_GAMES}</span>` : '';
            return `<span class="player-chip">${escapeHtml(p ? p.name : '?')}${gamesTag}${restTag}
              <button data-replace="${id}" title="Replace player" aria-label="Replace player"><i class="fas fa-right-left" aria-hidden="true"></i></button>
              <button data-remove="${id}" title="Remove">&times;</button></span>`;
          }).join('')}
        </div>
      </div>`).join('') + leftoverHtml
  }</div>`;

  els.queueList.querySelectorAll('[data-remove]').forEach(btn => {
    btn.onclick = () => removePlayer(btn.getAttribute('data-remove'));
  });
  els.queueList.querySelectorAll('[data-replace]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-replace');
      const current = playerById(id);
      const name = prompt('Replace "' + (current ? current.name : '') + '" with:', '');
      if (name && name.trim()) replacePlayer(id, name.trim());
    };
  });
}

/* Players who reached the max games: no longer in the queue, so show them here */
function renderMaxed() {
  const el = els.maxedList;
  if (!el) return;
  const done = players.filter(p => isMaxedOut(p));
  if (!done.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="queue-group" style="margin-top:22px">
      <div class="queue-group-head">
        <span class="queue-group-title">FINISHED · ${done.length} reached ${MAX_GAMES} games</span>
      </div>
      <div class="queue-players">
        ${done.map(p => `<span class="player-chip">${escapeHtml(p.name)}
          <span class="chip-meta"><i class="fas fa-check-circle" aria-hidden="true"></i> ${p.wins} win${p.wins === 1 ? '' : 's'}</span></span>`).join('')}
      </div>
    </div>`;
}

function matchNames(m, side) {
  const names = side === 'A' ? m.teamANames : m.teamBNames;
  const ids   = side === 'A' ? m.teamA : m.teamB;
  const list  = names || ids.map(id => (playerById(id) || { name: '—' }).name);
  return list.map(escapeHtml).join(' &amp; ');
}

/* Score history (latest 15) */
function renderMatches() {
  const el = els.matchList;
  if (!el) return;
  if (!matchHistory.length) {
    el.innerHTML = `<div class="empty-state">No scores recorded yet.</div>`;
    return;
  }
  el.innerHTML = `<div class="list-card">${
    [...matchHistory].reverse().slice(0, 15).map(m => `
      <div class="list-row">
        <div class="row-left">
          <span class="row-meta">C${m.court}</span>
          <span class="name">${matchNames(m, 'A')} <b>${m.scoreA}</b> – <b>${m.scoreB}</b> ${matchNames(m, 'B')}</span>
        </div>
        <span class="row-meta">${Math.max(1, Math.round((m.durationMs || 0) / 60000))}m</span>
      </div>`).join('')
  }</div>`;
}

function renderStats() {
  if (gameTimes.length) {
    const avgMs = gameTimes.reduce((a, b) => a + b, 0) / gameTimes.length;
    els.statAvg.textContent = Math.max(1, Math.round(avgMs / 60000)) + 'm';
  } else {
    els.statAvg.textContent = '–';
  }
}

function renderNextGames() {
  const el = els.nextGames;
  if (!el) return;

  const groups = nextEligibleGroups(2);

  if (!groups.length) {
    el.innerHTML = `<div class="next-game"><div class="g-title">Next games</div><div class="g-list">No upcoming games</div></div>`;
    return;
  }

  el.innerHTML = groups.map((g, gi) => {
    const title = gi === 0 ? 'Next' : 'Later';
    const need = g.length < 4 ? ` · needs ${4 - g.length}` : '';
    if (g.length === 4) {
      const teams = formTeamsStable(g);
      const a = teams.teamA.map(id => (playerById(id) || { name: '—' }).name).join(' & ');
      const b = teams.teamB.map(id => (playerById(id) || { name: '—' }).name).join(' & ');
      return `<div class="next-game"><div class="g-title">${title}${need}</div><div class="g-list">${escapeHtml(a)} vs ${escapeHtml(b)}</div></div>`;
    }
    const names = g.map(id => (playerById(id) || { name: '—' }).name).join(', ');
    return `<div class="next-game"><div class="g-title">${title}${need}</div><div class="g-list">${escapeHtml(names)}</div></div>`;
  }).join('');
}

/* ---------- Lock teammates panel (Players tab) ---------- */
const lockPanel = document.createElement('div');
lockPanel.id = 'lockPanel';
els.queueList.parentNode.insertBefore(lockPanel, els.queueList);

function renderLockPanel() {
  const prev1 = (document.getElementById('lockP1') || {}).value || '';
  const prev2 = (document.getElementById('lockP2') || {}).value || '';
  const pairedIds = new Set(lockedPairs.flat());
  const unpaired = players.filter(p => !pairedIds.has(p.id) && !isMaxedOut(p));
  const nameOf = id => (playerById(id) || { name: '?' }).name;
  const opts = sel => `<option value="">Select player</option>` + unpaired.map(p =>
    `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
  const selStyle = 'flex:1;min-width:130px;padding:10px 12px;border:1.5px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-size:0.95rem;';

  lockPanel.innerHTML = `
    <div class="capacity-card">
      <div class="capacity-top" style="margin-bottom:10px">
        <div>
          <h3><i class="fas fa-lock" aria-hidden="true"></i> Lock Teammates</h3>
          <p>Locked pairs stay teammates all game and play against other players in the queue. Unpaired players are teamed up automatically as their opponents.</p>
        </div>
        <button class="btn ${lockMode ? 'btn-primary' : 'btn-outline'}" id="lockToggle">${lockMode ? 'ON' : 'OFF'}</button>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <select id="lockP1" style="${selStyle}">${opts(prev1)}</select>
        <select id="lockP2" style="${selStyle}">${opts(prev2)}</select>
        <button class="btn btn-primary" id="lockAdd"><i class="fas fa-link" aria-hidden="true"></i> Lock pair</button>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn btn-outline" id="lockAuto"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> Auto-pair the rest</button>
        ${lockedPairs.length ? `<button class="btn btn-ghost" id="lockClear">Unlock all</button>` : ''}
      </div>

      ${lockedPairs.length ? `<div class="queue-players">${lockedPairs.map((pr, i) => `
        <span class="player-chip">${escapeHtml(nameOf(pr[0]))} &amp; ${escapeHtml(nameOf(pr[1]))}
          <button data-unlock="${i}" title="Unlock this pair">&times;</button></span>`).join('')}</div>`
        : `<div class="empty-state" style="padding:8px">No locked pairs yet.</div>`}

      ${lockMode && unpaired.length ? `<p style="margin-top:10px;font-size:0.85rem;color:var(--text-muted)">
        Not paired (teamed up automatically as opponents): ${unpaired.map(p => escapeHtml(p.name)).join(', ')}</p>` : ''}
    </div>`;

  const changed = () => { teamsCache = {}; save(); render(); };

  document.getElementById('lockToggle').onclick = () => { lockMode = !lockMode; changed(); };

  document.getElementById('lockAdd').onclick = () => {
    const a = document.getElementById('lockP1').value;
    const b = document.getElementById('lockP2').value;
    if (!a || !b) { alert('Pick two players.'); return; }
    if (a === b) { alert('Pick two different players.'); return; }
    lockedPairs.push([a, b]);
    changed();
  };

  document.getElementById('lockAuto').onclick = () => {
    const taken = new Set(lockedPairs.flat());
    const order = [...queue, ...players.map(p => p.id)]
      .filter((id, i, arr) => arr.indexOf(id) === i && playerById(id) && !taken.has(id) && !isMaxedOut(id));
    for (let i = 0; i + 1 < order.length; i += 2) lockedPairs.push([order[i], order[i + 1]]);
    changed();
  };

  const clearBtn = document.getElementById('lockClear');
  if (clearBtn) clearBtn.onclick = () => { lockedPairs = []; changed(); };

  lockPanel.querySelectorAll('[data-unlock]').forEach(btn => {
    btn.onclick = () => {
      lockedPairs.splice(parseInt(btn.getAttribute('data-unlock'), 10), 1);
      changed();
    };
  });
}

function render() {
  syncQueueWithPlayers();
  renderLockPanel();
  renderCourt();
  renderTop3();
  renderQueue();
  renderMaxed();
  renderLeaders();
  renderMatches();
  renderNextGames();
  renderStats();
}

/* ---------- Live timer / clock ---------- */
setInterval(() => {
  courts.forEach((court, i) => {
    if (court) {
      const el = document.getElementById('courtTimer-' + i);
      if (el) el.textContent = fmtClock(Date.now() - court.start);
    }
  });
  const now = new Date();
  els.clockTime.textContent = now.toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}, 1000);

/* ---------- Tabs ---------- */
document.querySelectorAll('.nav-item').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.nav-item').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  };
});

document.getElementById('seeFullBoard').onclick = (e) => {
  e.preventDefault();
  document.querySelector('.nav-item[data-tab="leaders"]').click();
};

/* ---------- Modal ---------- */
const overlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');

function closeModal() {
  overlay.classList.add('hidden');
  modalBody.innerHTML = '';
}
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});
document.getElementById('modalClose').onclick = closeModal;

function openAddPlayerModal() {
  if (players.length >= 30) {
    alert('Maximum 30 players reached.');
    return;
  }
  modalTitle.textContent = 'Add player';
  modalBody.innerHTML = `
    <input type="text" id="newPlayerName" placeholder="Player name" autocomplete="off" maxlength="30">
    <div class="modal-row">
      <button class="btn btn-secondary" id="cancelAdd">Cancel</button>
      <button class="btn btn-primary" id="confirmAdd">Add to queue</button>
    </div>`;
  overlay.classList.remove('hidden');

  const input = document.getElementById('newPlayerName');
  input.focus();

  const submit = () => {
    addPlayer(input.value);
    closeModal();
  };

  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  document.getElementById('confirmAdd').onclick = submit;
  document.getElementById('cancelAdd').onclick = closeModal;
}

function openEndGameModal(courtIndex) {
  const court = courts[courtIndex];
  if (!court) return;
  const gameStart = court.start; // remember which game this modal is for
  modalTitle.textContent = `Court ${courtIndex + 1} - Enter score`;
  modalBody.innerHTML = `
    <div style="display:grid;gap:14px;">
      <div style="display:grid;grid-template-columns:1fr 120px;gap:12px;align-items:center;">
        <div>
          <div style="font-size:0.78rem;font-weight:700;color:var(--text-muted);letter-spacing:.4px;text-transform:uppercase;margin-bottom:2px;">Team A</div>
          <div style="font-weight:700;color:var(--text);">${escapeHtml(teamName(court.teamA))}</div>
        </div>
        <input type="number" id="scoreA" min="0" step="1" inputmode="numeric" placeholder="0" aria-label="Team A score" style="margin-bottom:0;text-align:center;font-weight:700;">
      </div>
      <div style="display:grid;grid-template-columns:1fr 120px;gap:12px;align-items:center;">
        <div>
          <div style="font-size:0.78rem;font-weight:700;color:var(--text-muted);letter-spacing:.4px;text-transform:uppercase;margin-bottom:2px;">Team B</div>
          <div style="font-weight:700;color:var(--text);">${escapeHtml(teamName(court.teamB))}</div>
        </div>
        <input type="number" id="scoreB" min="0" step="1" inputmode="numeric" placeholder="0" aria-label="Team B score" style="margin-bottom:0;text-align:center;font-weight:700;">
      </div>
      <div id="scoreError" style="min-height:1.2em;color:var(--danger);font-size:0.9rem;font-weight:600;"></div>
      <div class="modal-row" style="margin-top:0;">
        <button class="btn btn-secondary" id="cancelEnd">Cancel</button>
        <button class="btn btn-primary" id="saveScore">Save score</button>
      </div>
    </div>`;
  overlay.classList.remove('hidden');

  const scoreA = document.getElementById('scoreA');
  const scoreB = document.getElementById('scoreB');
  const err = document.getElementById('scoreError');
  const submit = () => {
    const a = Number(scoreA.value);
    const b = Number(scoreB.value);
    if (scoreA.value === '' || scoreB.value === '' || !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      err.textContent = 'Enter a whole-number score for each team.';
      return;
    }
    if (a === b) {
      err.textContent = 'Scores cannot be tied. Enter the final score.';
      return;
    }
    err.textContent = '';
    endGame(courtIndex, a, b, gameStart);
  };

  scoreA.focus();
  [scoreA, scoreB].forEach(inp => {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    inp.addEventListener('input', () => { err.textContent = ''; });
  });
  document.getElementById('saveScore').onclick = submit;
  document.getElementById('cancelEnd').onclick = closeModal;
}

/* ---------- Event listeners ---------- */
document.getElementById('addPlayerBtn').onclick = openAddPlayerModal;
document.getElementById('resetAll').onclick = (e) => {
  e.preventDefault();
  resetAll();
};
document.getElementById('startGameBtn').onclick = (e) => {
  e.preventDefault();
  openStartGameModal();
};

/* ---------- Certificate ---------- */
function showCertificate(player) {
  const sorted = rankedPlayers();
  const rank = sorted.findIndex(p => p.id === player.id) + 1;
  const rankNames = ['1st Place', '2nd Place', '3rd Place'];
  const rankTitle = rank <= 3 ? rankNames[rank - 1] : `#${rank}`;

  const certificateHtml = `
    <div id="certificateContainer" style="background:#faf6f1;padding:40px;border:4px solid #1a9c4a;border-radius:8px;text-align:center;max-width:600px;margin:0 auto;font-family:Georgia,serif;">
      <div style="border:3px dashed #1a9c4a;padding:40px 30px;background:#fff;">
        <div style="font-size:12px;letter-spacing:2px;color:#1a9c4a;margin-bottom:20px;font-weight:bold;">CERTIFICATE OF ACHIEVEMENT</div>
        <div style="margin:30px 0;font-size:48px;">🏆</div>
        <div style="margin:20px 0;"><span style="font-size:14px;color:#666;">This certifies that</span></div>
        <div style="font-size:32px;font-weight:bold;color:#1a9c4a;margin:20px 0;border-bottom:2px solid #1a9c4a;padding-bottom:10px;">
          ${escapeHtml(player.name)}
        </div>
        <div style="margin:20px 0;"><span style="font-size:14px;color:#666;">has achieved</span></div>
        <div style="font-size:26px;font-weight:bold;color:#158a3f;margin:15px 0;">${rankTitle}</div>
        <div style="margin:20px 0;"><span style="font-size:13px;color:#666;">in Pickleball with</span></div>
        <div style="font-size:22px;font-weight:bold;color:#1a9c4a;margin:10px 0;">
          ${player.wins} ${player.wins === 1 ? 'Win' : 'Wins'}
        </div>
        <div style="margin-top:40px;padding-top:30px;border-top:1px solid #ccc;font-size:12px;color:#999;">
          <div>ABC Pickleyard Leaderboard</div>
          <div style="margin-top:5px;">${new Date().toLocaleDateString()}</div>
        </div>
      </div>
    </div>`;

  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <!DOCTYPE html><html><head><title>Certificate - ${escapeHtml(player.name)}</title>
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{background:#f5f4f1;padding:20px;font-family:Georgia,serif}
      @media print{body{background:white;padding:0} .no-print{display:none}}
      .action-buttons{text-align:center;margin-top:20px;display:flex;justify-content:center;gap:10px}
      button{padding:10px 20px;font-size:14px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
    </style></head><body>
    ${certificateHtml}
    <div class="action-buttons no-print">
      <button onclick="window.print()">🖨️ Print</button>
      <button onclick="window.close()">✕ Close</button>
    </div></body></html>`);
  printWindow.document.close();
}

/* ---------- Dark Mode ---------- */
const darkModeToggle = document.getElementById('darkModeToggle');
const isDarkMode = localStorage.getItem('darkMode') === 'true';
if (isDarkMode) {
  document.body.classList.add('dark-mode');
  darkModeToggle.innerHTML = '<i class="fas fa-sun"></i>';
}

darkModeToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem('darkMode', isDark);
  darkModeToggle.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
});

/* ---------- Init ---------- */
save();
render();
/* Refresh from Supabase when players register or another device changes data */
function reloadState() {
  players      = load('cq_players', []);
  queue        = load('cq_queue', []);
  courts       = loadCourts();
  history      = load('cq_history', []);
  oppHistory   = load('cq_oppHistory', []);
  matchHistory = load('cq_matchHistory', []);
  gameTimes    = load('cq_gameTimes', []);
  lockedPairs  = load('cq_lockedPairs', []);
  lockMode     = load('cq_lockMode', false) === true;
  teamsCache   = {};
  normalizePlayers();
  render();
}

window.cqOnRemoteChange = reloadState;