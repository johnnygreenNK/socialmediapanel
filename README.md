# Social Panel — backend

Self-hosted backend that keeps a **persistent, logged-in browser session** for
each of **your own** accounts (Facebook, Gmail, …) and exposes it to a panel
you open in your browser. There is no PIN: the server only listens on
127.0.0.1, so only the computer it runs on can open it.

You log in **once, manually**, inside the remote browser — including typing your
own 2FA/SMS code. The backend keeps that session alive and stores the browser
profile on disk. It does not store passwords and does not automate
the login or the 2FA step. Only your own accounts; nothing is shared.

## How it works

- One persistent Chromium profile per account (`src/accounts.js`), stored in
  `DATA_DIR/profiles/<id>`.
- Every account's browser is launched when the server starts and stays running
  24/7, so opening an account in the panel is instant (`src/browser.js`).
  Chromium writes cookies to the profile continuously, so your login survives
  restarts.
- The viewer resizes the remote page to fill the panel's full width.
- No PIN or login: the server always binds to 127.0.0.1 (`src/config.js`).
  Anyone who can reach it controls your accounts, so never expose it (no
  port forwarding / tunnels) without adding protection back first.
- Profiles are plain Chromium profiles on disk: protect `DATA_DIR` with disk
  encryption (BitLocker / FileVault / LUKS).

```
Browser (any device) ──HTTPS──> Caddy ──> backend (Fastify)
                                             ├─ /api/accounts
                                             └─ /api/accounts/:id/{start,stop,status}
                                                   └─ Playwright persistent Chromium
                                                        └─ persistent profile on /data
```

## Setup (local-first)

```bash
cd backend
cp .env.example .env

npm install
npx playwright install chromium
npm start                            # http://localhost:8080
```

## API
## API

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/api/accounts` | — | list accounts + running status |
| POST | `/api/accounts/:id/start` | — | starts the persistent browser for that account |
| POST | `/api/accounts/:id/stop` | — | stops the browser (profile stays on disk) |
| GET | `/api/accounts/:id/status` | — | running / lastActivity |
| GET | `/healthz` | — | health check |

Plus a **viewer WebSocket**:

| Protocol | Path | Notes |
| --- | --- | --- |
| WS | `/api/accounts/:id/viewer` | live screen + input; requires a started session |

The frontend (plain HTML/CSS) calls the REST endpoints and connects the viewer
WebSocket. A working reference client ships in `public/` — see "Viewer" below.

## Adding a service

Add one entry in `src/accounts.js`:

```js
{ id: 'instagram', label: 'Instagram', startUrl: 'https://www.instagram.com/' }
```

## Access

Local only (127.0.0.1). The Docker/Caddy files are from the earlier PIN-protected
setup and don't work as-is now, because the server no longer listens on other
interfaces.

## Viewer

The live viewer is implemented (`src/viewer.js`): a WebSocket streams the remote
page as JPEG frames via CDP `Page.startScreencast`, and mouse/keyboard events
from the browser are dispatched back via CDP `Input.*`.

A plain HTML/CSS/JS reference client is served from `public/`:

- `public/viewer.js` — the `SocialPanelViewer` class (no framework, no build).
  Point it at an `<img>` and call `connect(accountId)`:

  ```html
  <img id="screen" />
  <script src="/viewer.js"></script>
  <script>
    const v = new SocialPanelViewer(document.getElementById('screen'));
    v.connect('facebook'); // after POST /api/accounts/facebook/start
  </script>
  ```

- `public/index.html`, `public/app.js`, `public/style.css` — a full demo panel
  (account buttons → link → full-screen viewer at `/v/<id>`). Replace or restyle freely; it only
  uses the documented REST + WS API. Open `http://localhost:8080/` to try it.

Coordinates are scaled automatically from the displayed `<img>` to the remote
page's pixel space, so your CSS can size the viewer however you like.

## Signing in & 2FA (incl. Google)

You log in **once, manually**, in the remote browser. 2FA behaves like this:

| Method | Works remotely? | Why |
| --- | --- | --- |
| SMS / voice code | ✅ | you type the code |
| Authenticator app (TOTP) | ✅ | you type the code |
| Google prompt / app push | ✅ | you approve on your own phone (off-browser) |
| Backup codes | ✅ | you type the code |
| Passkey | ❌ | needs a FIDO authenticator on the machine running Chromium (the server) |
| Security key (USB/NFC) | ❌ | same — the key would have to be physically at the server |

The rule: anything you **type** or **approve on your phone** works; anything that
needs a passkey/security key **attached to the browser's machine** does not —
that machine is the server, not your device (remote-browser products like AWS
WorkSpaces Secure Browser document the same WebAuthn limitation).

**Google** is moving away from SMS toward passkeys / Google prompt / authenticator.
For a Google account, use an **authenticator app code** or **Google prompt**, and
if the account only has a passkey, add an app/prompt method as backup first. You
log in once; the persistent profile then keeps the session — no repeated 2FA.

This guidance is served at `GET /api/twofa` and shown per account in the panel
(`signinHint` in `src/accounts.js`, data in `src/twofa.js`).

## Security notes

- Passwords and 2FA codes are only ever typed by you into the remote browser.
- Profiles hold your live sessions: keep `DATA_DIR` on an encrypted disk.
- Keep the server on 127.0.0.1; there is no PIN in front of your accounts.
- Only connect your own accounts.
