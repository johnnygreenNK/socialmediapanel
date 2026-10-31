document.getElementById('log-start-time').textContent = new Date().toLocaleTimeString('pl-PL');

/* ── Session uptime ── */
const sessionStart = Date.now();
let linkCount = 0;

setInterval(() => {
  const sec = Math.floor((Date.now() - sessionStart) / 1000);
  const h = String(Math.floor(sec/3600)).padStart(2,'0');
  const m = String(Math.floor((sec%3600)/60)).padStart(2,'0');
  const s = String(sec%60).padStart(2,'0');
  const el = document.getElementById('stat-uptime');
  if (el) el.textContent = `${h}:${m}:${s}`;
}, 1000);

/* ── Logs ── */
window.addLog = function(msg, type='info') {
  const list = document.getElementById('logsList');
  if (!list) return;
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('pl-PL');
  const text = document.createElement('span');
  text.className = 'log-msg';
  text.textContent = msg;
  entry.append(time, text);
  list.prepend(entry);
  if (list.children.length > 100) list.lastElementChild.remove();
};

window.clearLogs = function() {
  const list = document.getElementById('logsList');
  if (list) list.innerHTML = '';
};

/* ── Tab label ── */
const crumbMap = {
  generate: 'Generate LINK',
  accounts: 'Accounts',
  logs: 'LIVE TIME LOGS',
  stats: 'Statistics'
};
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const crumb = document.getElementById('crumb-label');
      if (crumb) crumb.textContent = crumbMap[btn.dataset.tab] || btn.dataset.tab;
      if (btn.dataset.tab === 'stats') loadStats();
    });
  });
});

/* ── Stats ── */
async function loadStats() {
  try {
    const res = await fetch('/api/accounts', { credentials: 'same-origin' });
    if (!res.ok) return;
    const accounts = await res.json();
    document.getElementById('stat-total').textContent = accounts.length;
    document.getElementById('stat-active').textContent = accounts.length;
    document.getElementById('stat-links').textContent = linkCount;
  } catch {}
}

/* ── Intercept copy to count links ── */
document.addEventListener('click', e => {
  if (e.target.id === 'genCopy') { linkCount++; addLog('Link skopiowany', 'success'); }
});
