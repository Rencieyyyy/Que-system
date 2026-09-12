/* ---------- State ---------- */
let players   = load('cq_players', []);
let queue     = load('cq_queue', []);
let courts    = loadCourts();          // [Court 1, Court 2] — each is null or {teamA, teamB, start}
let history   = load('cq_history', []);
let gameTimes = load('cq_gameTimes', []);

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
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

function save() {
  localStorage.setItem('cq_players', JSON.stringify(players));
  localStorage.setItem('cq_queue', JSON.stringify(queue));
  localStorage.setItem('cq_courts', JSON.stringify(courts));
  localStorage.setItem('cq_history', JSON.stringify(history));
  localStorage.setItem('cq_gameTimes', JSON.stringify(gameTimes));
  localStorage.removeItem('cq_court'); // legacy key no longer used
}

function uid() { return 'p' + Math.random().toString(36).slice(2, 9); }
function playerById(id) { return players.find(p => p.id === id); }
function pairKey(a, b) { return [a, b].sort().join('_'); }
function isPlayerOnAnyCourt(id) {
  return courts.some(c => c && (c.teamA.includes(id) || c.teamB.includes(id)));
}

/* ---------- Smart team formation ---------- */
function formTeams(ids) {
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

/* ---------- Actions ---------- */
function addPlayer(name) {
  name = name.trim();
  if (!name) return;

  if (players.length >= 30) {
    alert('Maximum 30 players reached.');
    return;
  }

  const p = { id: uid(), name, wins: 0 };
  players.push(p);
  queue.push(p.id);
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
  save();
  render();
}

/* Start a game on a specific court index (0 = Court 1, 1 = Court 2) */
function startGame(courtIndex) {
  if (courts[courtIndex]) {
    alert(`Court ${courtIndex + 1} already has a game in play.`);
    return;
  }
  if (queue.length < 4) {
    alert('Need at least 4 players in the queue to start a game.');
    return;
  }
  const ids = queue.slice(0, 4);
  queue = queue.slice(4);
  const teams = formTeams(ids);
  history.push(pairKey(teams.teamA[0], teams.teamA[1]));
  history.push(pairKey(teams.teamB[0], teams.teamB[1]));
  courts[courtIndex] = { teamA: teams.teamA, teamB: teams.teamB, start: Date.now() };
  save();
  render();
  closeModal();
}

/* Decide whether to ask which court, auto-pick the only free one, or block */
function openStartGameModal() {
  if (queue.length < 4) {
    alert('Need at least 4 players in the queue to start a game.');
    return;
  }

  const freeIndexes = courts.map((c, i) => (c ? -1 : i)).filter(i => i !== -1);

  if (freeIndexes.length === 0) {
    alert('Both courts are currently in play. End a game first.');
    return;
  }

  if (freeIndexes.length === 1) {
    // Only one court is free — just start on it, no need to ask
    startGame(freeIndexes[0]);
    return;
  }

  // Both courts free — let the admin pick
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

function endGame(winner, courtIndex) {
  const court = courts[courtIndex];
  if (!court) return;

  const winners = winner === 'A' ? court.teamA : court.teamB;
  const losers  = winner === 'A' ? court.teamB : court.teamA;

  winners.forEach(id => {
    const p = playerById(id);
    if (p) p.wins += 1;
  });

  gameTimes.push(Date.now() - court.start);
  if (gameTimes.length > 20) gameTimes = gameTimes.slice(-20);

  const q = [...queue];
  const skipForWinners = 4;
  const skipForLosers = 8;

  const insertAt = (arr, index, items) => {
    const i = Math.min(Math.max(0, index), arr.length);
    arr.splice(i, 0, ...items);
  };

  insertAt(q, Math.min(skipForWinners, q.length), winners);
  insertAt(q, Math.min(skipForLosers + winners.length, q.length), losers);

  queue = q;
  courts[courtIndex] = null;

  // Auto-start the next game on the court that just freed up, if enough players are waiting
  if (queue.length >= 4) {
    const nextIds = queue.slice(0, 4);
    queue = queue.slice(4);
    const teams = formTeams(nextIds);
    history.push(pairKey(teams.teamA[0], teams.teamA[1]));
    history.push(pairKey(teams.teamB[0], teams.teamB[1]));
    courts[courtIndex] = { teamA: teams.teamA, teamB: teams.teamB, start: Date.now() };
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
  gameTimes = [];
  save();
  render();
}

function replacePlayer(oldId, newName) {
  if (!newName) return;
  const oldIndex = players.findIndex(p => p.id === oldId);
  const newP = { id: uid(), name: newName, wins: 0 };
  if (oldIndex !== -1) {
    players.splice(oldIndex, 1, newP);
  } else {
    players.push(newP);
  }
  queue = queue.map(pid => pid === oldId ? newP.id : pid);
  save();
  render();
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
            <p>Court is free. ${queue.length < 4
              ? `Waiting on ${4 - queue.length} more player${4 - queue.length === 1 ? '' : 's'} to start a game.`
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
            <span>${teamName(court.teamA)}</span>
          </div>
          <div class="vs">VS</div>
          <div class="team">
            <i class="fas fa-users"></i>
            <span>${teamName(court.teamB)}</span>
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

function leaderRow(p, i, top3) {
  const rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
  const canPrint = i < 3;
  const medals = ['🥇', '🥈', '🥉'];
  const medal = i < 3 ? medals[i] : '';
  return `
    <div class="list-row leader-row ${top3 ? 'top3' : ''}">
      <div class="row-left">
        <span class="rank-badge ${rankClass}">${medal || i + 1}</span>
        <span class="name">${escapeHtml(p.name)}</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <span class="wins">${p.wins} win${p.wins === 1 ? '' : 's'}</span>
        ${canPrint ? `<button class="btn-certificate" data-cert="${p.id}" title="Print certificate">🎖️</button>` : ''}
      </div>
    </div>`;
}

function renderTop3() {
  const top = [...players].sort((a, b) => b.wins - a.wins).slice(0, 3);
  if (!top.length) {
    els.top3List.innerHTML = `<div class="empty-state">No games finished yet.</div>`;
    return;
  }
  els.top3List.innerHTML = `<div class="list-card">${top.map((p, i) => leaderRow(p, i, true)).join('')}</div>`;
  attachCertificateHandlers();
}

function renderLeaders() {
  const sorted = [...players].sort((a, b) => b.wins - a.wins);
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
    els.queueList.innerHTML = `<div class="empty-state">Nobody's waiting. Add players to build the queue.</div>`;
    return;
  }

  const groups = [];
  for (let i = 0; i < queue.length; i += 4) {
    groups.push(queue.slice(i, i + 4));
  }

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
            return `<span class="player-chip">${escapeHtml(p ? p.name : '—')}
              <button data-replace="${id}" title="Replace">↻</button>
              <button data-remove="${id}" title="Remove">&times;</button></span>`;
          }).join('')}
        </div>
      </div>`).join('')
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

  if (!queue.length) {
    el.innerHTML = `<div class="next-game"><div class="g-title">Next games</div><div class="g-list">No upcoming games</div></div>`;
    return;
  }

  const groups = [];
  for (let i = 0; i < queue.length; i += 4) groups.push(queue.slice(i, i + 4));

  el.innerHTML = groups.slice(0, 2).map((g, gi) => {
    const title = gi === 0 ? 'Next' : 'Later';
    const need = g.length < 4 ? ` · needs ${4 - g.length}` : '';
    if (g.length === 4) {
      const teams = formTeams(g);
      const a = teams.teamA.map(id => (playerById(id) || { name: '—' }).name).join(' & ');
      const b = teams.teamB.map(id => (playerById(id) || { name: '—' }).name).join(' & ');
      return `<div class="next-game"><div class="g-title">${title}${need}</div><div class="g-list">${escapeHtml(a)} vs ${escapeHtml(b)}</div></div>`;
    }
    const names = g.map(id => (playerById(id) || { name: '—' }).name).join(', ');
    return `<div class="next-game"><div class="g-title">${title}${need}</div><div class="g-list">${escapeHtml(names)}</div></div>`;
  }).join('');
}

function render() {
  renderCourt();
  renderTop3();
  renderQueue();
  renderLeaders();
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
  modalTitle.textContent = `Court ${courtIndex + 1} — Who won?`;
  modalBody.innerHTML = `
    <button class="win-option" data-winner="A">
      <span class="wl">WINNER</span>
      <span>${teamName(court.teamA)}</span>
    </button>
    <button class="win-option" data-winner="B">
      <span class="wl">WINNER</span>
      <span>${teamName(court.teamB)}</span>
    </button>
    <button class="btn btn-secondary" id="cancelEnd" style="width:100%;margin-top:8px">Cancel</button>`;
  overlay.classList.remove('hidden');

  modalBody.querySelectorAll('[data-winner]').forEach(btn => {
    btn.onclick = () => endGame(btn.getAttribute('data-winner'), courtIndex);
  });
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
  const sorted = [...players].sort((a, b) => b.wins - a.wins);
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