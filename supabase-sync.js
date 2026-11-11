/* ABCDink Pickleyard – Supabase sync
   Keeps localStorage and the shared Supabase table `kv` in step, so the admin
   page, the TV display and players' phones all see the same queue.
   Load this BEFORE index.js (admin) and display.js (TV). */
(function () {
  const URL = 'https://dtdlkcdpncuqkokwptjr.supabase.co';
  const KEY = 'sb_publishable_gH7j1ua0wYziNI4_VyvxqA_6HR0Jyrl';
  const KEYS = ['cq_players', 'cq_queue', 'cq_courts', 'cq_history', 'cq_oppHistory', 'cq_gameTimes'];
  const POLL_MS = 2000;

  async function api(path, opts) {
    const o = opts || {};
    const res = await fetch(URL + '/rest/v1/' + path, {
      method: o.method || 'GET',
      headers: Object.assign({ apikey: KEY, 'Content-Type': 'application/json' }, o.headers || {}),
      body: o.body
    });
    if (!res.ok) throw new Error(await res.text());
    return res.status === 204 ? null : res.json();
  }

  /* Used by register.html */
  window.CQ = {
    register: name => api('rpc/register_player', { method: 'POST', body: JSON.stringify({ p_name: name }) })
  };

  if (window.CQ_NOSYNC) return; // register page only needs CQ.register

  const origSet = Storage.prototype.setItem;
  const rawSet = (k, v) => origSet.call(localStorage, k, v);
  let ready = false;            // nothing is pushed until the first pull finished
  const holdUntil = {};         // ignore server copy of a key right after we pushed it
  const lastPushed = {};
  const lastServer = {};

  /* Every app save() to a shared key is also sent to Supabase */
  Storage.prototype.setItem = function (k, v) {
    origSet.call(this, k, v);
    if (this !== localStorage || !KEYS.includes(k) || !ready) return;
    if (lastPushed[k] === v) return;
    lastPushed[k] = v;
    holdUntil[k] = Date.now() + 2500;
    api('kv?on_conflict=key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: k, value: JSON.parse(v), updated_at: new Date().toISOString() })
    }).catch(e => console.error('Sync push failed', e));
  };

  async function pull() {
    try {
      const rows = await api('kv?select=key,value');
      let changed = false;
      rows.forEach(r => {
        if (!KEYS.includes(r.key)) return;
        if (Date.now() < (holdUntil[r.key] || 0)) return;
        const s = JSON.stringify(r.value);
        if (s === lastServer[r.key]) return;   // server copy unchanged since last poll
        lastServer[r.key] = s;
        if (localStorage.getItem(r.key) !== s) { rawSet(r.key, s); changed = true; }
      });
      const first = !ready;
      ready = true;
      if ((changed || first) && typeof window.cqOnRemoteChange === 'function') window.cqOnRemoteChange();
    } catch (e) {
      console.error('Sync pull failed', e);
    }
  }

  pull();
  setInterval(pull, POLL_MS);
})();