const $ = (s) => document.querySelector(s);

// Already authenticated? Skip straight to the panel.
(async () => {
  try {
    const res = await fetch('/api/accounts', { credentials: 'same-origin' });
    if (res.ok) location.replace('/');
  } catch {}
})();

// Show/hide password toggle
$('#togglePassword').addEventListener('click', () => {
  const input = $('#passwordInput');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#togglePassword').classList.toggle('active', input.type === 'text');
});

let countdownTimer = null;

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearInterval(countdownTimer);

  const username = $('#usernameInput').value.trim();
  const password = $('#passwordInput').value;
  const errEl = $('#loginError');
  const btn = $('#loginBtn');

  errEl.textContent = '';
  errEl.classList.remove('visible');
  btn.disabled = true;
  btn.textContent = 'Logowanie…';

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
      location.replace('/');
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (res.status === 429 && data.retryAfterMs) {
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
      errEl.textContent = 'Nieprawidłowa nazwa użytkownika lub hasło';
    }
    errEl.classList.add('visible');
    $('#passwordInput').select();
  } catch {
    errEl.textContent = 'Błąd połączenia — spróbuj ponownie';
    errEl.classList.add('visible');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Zaloguj się';
  }
});
