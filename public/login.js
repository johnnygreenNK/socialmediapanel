const $ = (s) => document.querySelector(s);

function setPin(p) { try { localStorage.setItem('pin', p); } catch {} }

// Already logged in? Skip straight to the panel.
(async () => {
  try {
    const pin = localStorage.getItem('pin') || '';
    const res = await fetch('/api/accounts', { headers: pin ? { 'x-pin': pin } : {} });
    if (res.ok) { location.replace('/'); }
  } catch {}
})();

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#pinInput').value;
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (res.ok) {
    setPin(pin);
    location.replace('/');
  } else {
    $('#pinError').classList.add('visible');
    $('#pinInput').select();
  }
});
