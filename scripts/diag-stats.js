// Diagnostyka statystyk Gmaila.
//
// Otwiera profil JUŻ ZALOGOWANEGO konta i uruchamia pełne zbieranie
// statystyk z gadatliwym logowaniem, żeby zobaczyć, która strategia
// (context.request / intercept XHR / parsowanie DOM) zwraca liczby,
// a która pada — i dlaczego.
//
// WAŻNE: profil jest zablokowany, dopóki serwer go trzyma otwarty.
// Zatrzymaj serwer przed uruchomieniem tego skryptu, np.:
//   fuser -k 8080/tcp   (albo: pm2 stop <nazwa> / systemctl stop <usługa>)
// potem:
//   node scripts/diag-stats.js [id_konta]
// a po diagnozie uruchom serwer z powrotem.
//
// Bez argumentu bierze pierwsze konto, którego startUrl wskazuje na Gmaila.

import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../src/config.js';
import { loadAccounts, getAccount } from '../src/accounts.js';
import { collectGmailStats, formatStatsForTelegram } from '../src/gmail-stats.js';

function log(...a) { console.log('[diag]', ...a); }

async function pickAccount(arg) {
  if (arg) {
    const acc = await getAccount(arg);
    if (!acc) throw new Error(`nie znaleziono konta o id "${arg}"`);
    return acc;
  }
  const accounts = await loadAccounts();
  const gmail = accounts.find((a) => /mail\.google\.com/i.test(a.startUrl || ''));
  if (!gmail) throw new Error('brak konta Gmail — podaj id konta jako argument');
  return gmail;
}

async function main() {
  const acc = await pickAccount(process.argv[2]);
  const dir = path.join(config.dataDir, 'profiles', acc.id);
  log(`konto: ${acc.id} (${acc.label})`);
  log(`profil: ${dir}`);

  let context;
  try {
    context = await chromium.launchPersistentContext(dir, {
      headless: true,
      channel: acc.channel || config.browserChannel || undefined,
      viewport: { width: 1366, height: 800 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-features=DnsOverHttps',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      // Gmail działa z tego VPS bezpośrednio — proxy wiesza ruch do Google.
    });
  } catch (err) {
    const msg = String(err.message || err);
    if (/ProcessSingleton|SingletonLock|already running|in use/i.test(msg)) {
      log('❌ profil jest zablokowany — serwer prawdopodobnie nadal działa.');
      log('   Zatrzymaj serwer (fuser -k 8080/tcp) i spróbuj ponownie.');
      process.exit(2);
    }
    throw err;
  }

  log('kontekst otwarty, start zbierania statystyk...\n');
  const t0 = Date.now();
  let stats;
  try {
    stats = await collectGmailStats(context, (m) => log('progress:', m), acc.id);
  } finally {
    await context.close().catch(() => {});
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n──────── WYNIK (surowy JSON) ────────');
  console.log(JSON.stringify(stats, null, 2));
  console.log('\n──────── WYNIK (format Telegram) ────────');
  console.log(formatStatsForTelegram(acc.label, stats));
  console.log(`\nźródło: ${stats && stats._source === 'api' ? 'Gmail API' : 'SPA (scraping)'} · czas: ${secs}s`);
}

main().catch((err) => {
  console.error('[diag] błąd:', err);
  process.exit(1);
});
