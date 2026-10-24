const $ = (s) => document.querySelector(s);

// Already have a valid session? Go straight to the panel.
(async () => {
  try {
    const res = await fetch('/api/accounts', { credentials: 'same-origin' });
    if (res.ok) { location.replace('/'); }
  } catch {}
})();

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('#loginError');
  errorEl.textContent = '';
  errorEl.classList.remove('visible');

  const username = $('#usernameInput').value.trim();
  const password = $('#passwordInput').value;

  if (!username || !password) {
    errorEl.textContent = 'Please enter your username and password.';
    errorEl.classList.add('visible');
    return;
  }

  const btn = $('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const res = await fetch('/api/login', {
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
    if (res.status === 429) {
      const sec = Math.ceil((data.retryAfterMs || 30000) / 1000);
      errorEl.textContent = `Too many failed attempts. Try again in ${sec} seconds.`;
    } else {
      errorEl.textContent = 'Invalid username or password.';
    }
    errorEl.classList.add('visible');
    $('#passwordInput').value = '';
    $('#passwordInput').focus();
  } catch {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.classList.add('visible');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
