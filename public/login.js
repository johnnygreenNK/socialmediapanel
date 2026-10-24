const $ = (s) => document.querySelector(s);

// Already authenticated? Skip straight to the panel.
// The session cookie is sent automatically — no JS-side PIN needed.
(async () => {
  try {
    const res = await fetch('/api/accounts', { credentials: 'same-origin' });
    if (res.ok) location.replace('/');
  } catch {}
})();

let countdownTimer = null;

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearInterval(countdownTimer);

  const pin = $('#pinInput').value;
  const errEl = $('#pinError');
  errEl.classList.remove('visible');

  const res = await fetch('/api/auth', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  });

  if (res.ok) {
    location.replace('/');
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (data.retryAfterMs) {
    const until = Date.now() + data.retryAfterMs;
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(countdownTimer);
        errEl.textContent = 'Spróbuj ponownie';
        return;
      }
      errEl.textContent = `Zbyt wiele prób — poczekaj ${left}s`;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  } else {
    errEl.textContent = 'Nieprawidłowy PIN';
  }
  errEl.classList.add('visible');
  $('#pinInput').select();
});
