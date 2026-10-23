// Głęboka diagnostyka JEDNEGO wyszukiwania w Gmailu.
//
// Otwiera Gmail, wykonuje podany query, czeka, i zrzuca pełny stan strony
// (html, screenshot, innerText, aria-label, regex probes) do katalogu
// DATA_DIR/gmail-debug/<ts>/.
//
// Użycie (serwer zatrzymany):
//   fuser -k 8080/tcp
//   DATA_DIR=/opt/social-panel/data node scripts/diag-query.js \
//     <account-id> "<gmail-query>"
//   np. ... diag-query.js ddd-gmail "from:paypal"
//        ... diag-query.js ddd-gmail "in:inbox"

import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../src/config.js';
import { getAccount } from '../src/accounts.js';

function log(...a) { console.log('[diag]', ...a); }

async function main() {
  var accountId = process.argv[2];
  var query = process.argv[3];
  if (!accountId || !query) {
    console.error('Użycie: node scripts/diag-query.js <account-id> "<query>"');
    console.error('Przykłady:');
    console.error('  node scripts/diag-query.js ddd-gmail "from:paypal"');
    console.error('  node scripts/diag-query.js ddd-gmail "in:inbox"');
    process.exit(1);
  }
  var acc = await getAccount(accountId);
  if (!acc) throw new Error('Nie znaleziono konta: ' + accountId);
  var dir = path.join(config.dataDir, 'profiles', accountId);
  log('konto: ' + accountId + ' (' + acc.label + ')');
  log('profil: ' + dir);
  log('query: ' + query);

  // Force debug on for this script
  process.env.GMAIL_STATS_DEBUG = '1';

  var context = await chromium.launchPersistentContext(dir, {
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
  }).catch(function(err) {
    var msg = String(err.message || err);
    if (/ProcessSingleton|SingletonLock|already running|in use/i.test(msg)) {
      log('❌ profil jest zablokowany — serwer prawdopodobnie nadal działa.');
      log('   Zatrzymaj go (fuser -k 8080/tcp) i spróbuj ponownie.');
      process.exit(2);
    }
    throw err;
  });

  var page = await context.newPage();

  // Trace network: capture every XHR response that might carry counts
  var xhrLog = [];
  page.on('response', async function(response) {
    try {
      var url = response.url();
      if (!url.includes('mail.google.com')) return;
      var ct = response.headers()['content-type'] || '';
      if (!/json|javascript|text\/plain/.test(ct)) return;
      var text = await response.text().catch(function() { return ''; });
      if (!text || text.charAt(0) === '<') return;
      // Find any count-like pattern
      var hits = [];
      var mTe = text.match(/\["te",\s*(\d+)/g);
      if (mTe) hits.push({ type: 'te', matches: mTe });
      var mRc = text.match(/"resultCount"\s*:\s*"?(\d+)"?/g);
      if (mRc) hits.push({ type: 'resultCount', matches: mRc });
      var mTot = text.match(/"totalSize"\s*:\s*(\d+)/g);
      if (mTot) hits.push({ type: 'totalSize', matches: mTot });
      if (hits.length > 0) {
        xhrLog.push({ url: url.substring(0, 200), status: response.status(), ct: ct, hits: hits, textPeek: text.substring(0, 300) });
      } else if (text.includes('te,') || text.includes('resultCount')) {
        xhrLog.push({ url: url.substring(0, 200), status: response.status(), ct: ct, textPeek: text.substring(0, 500) });
      }
    } catch {}
  });

  log('otwieram Gmail...');
  await page.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(function() {
    return !!document.querySelector('div[gh="s"], input[aria-label*="Szukaj"], input[aria-label*="Search"], tr.zA, tr[role="row"]');
  }, { timeout: 15000 }).catch(function() {});
  await new Promise(function(r) { setTimeout(r, 2000); });

  log('url po załadowaniu: ' + page.url());
  if (!page.url().includes('mail.google.com')) {
    log('❌ konto nie jest zalogowane');
    await context.close();
    process.exit(3);
  }

  log('wykonuję wyszukiwanie...');
  var before = await page.evaluate(function() { return (document.body.innerText || '').substring(0, 200); });

  // Try via search box (simulates a real user typing) — most realistic.
  await page.evaluate(function(q) {
    var box = document.querySelector('input[aria-label*="Szukaj"], input[aria-label*="Search"], input[name="q"]');
    if (box) {
      box.focus();
      box.value = q;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, query).catch(function() {});
  await page.keyboard.press('Enter').catch(function() {});

  // Fallback: hash nav
  await new Promise(function(r) { setTimeout(r, 500); });
  var curUrl = page.url();
  if (!/[#?]search\//.test(curUrl)) {
    log('search box nie zadziałał, próba przez hash...');
    await page.evaluate(function(h) { window.location.hash = h; },
      '#search/' + encodeURIComponent(query));
  }

  log('czekam na render (do 8s)...');
  await page.waitForFunction(function(prev) {
    var raw = (document.body.innerText || '');
    if (raw.substring(0, 200) === prev) return false;
    var t = raw.replace(/[   ]/g, ' ');
    if (/z wielu|of many/i.test(t)) return true;
    if (/\d+\s*[-–]\s*\d+\s+(?:z|of)\s+\d/i.test(t)) return true;
    if (/nie znaleziono|nie pasuj|brak wynik|brak wiadom|no messages|no results|nothing matched|didn't match/i.test(t)) return true;
    return document.querySelectorAll('tr.zA, tr[role="row"]').length > 0;
  }, { timeout: 8000 }, before).catch(function() { log('⚠ waitForFunction timeout — strona nie zdążyła się zmienić'); });

  await new Promise(function(r) { setTimeout(r, 1500); });

  // Full dump
  var ts = new Date().toISOString().replace(/[:.]/g, '-');
  var dumpDir = path.join(config.dataDir, 'gmail-debug', ts + '-' + query.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40));
  var fs = (await import('node:fs')).default;
  fs.mkdirSync(dumpDir, { recursive: true });
  log('zrzut: ' + dumpDir);

  var state = await page.evaluate(function() {
    var text = document.body.innerText || '';
    var norm = text.replace(/[    ​]/g, ' ').replace(/[–—]/g, '-');
    var probes = {
      has_z_wielu: /\bz wielu\b|\bof many\b/i.test(norm),
      pagination_full: norm.match(/(\d+)\s*-\s*(\d+)\s+(?:z|of)\s+(\d[\d\s,.]*\d|\d+)\b/i),
      pagination_relaxed: norm.match(/(\d+)[\s\S]{0,10}(\d+)[\s\S]{0,10}(?:z|of)[\s\S]{0,10}(\d+)/i),
      no_results: /nie znaleziono|nie pasuj|brak wynik|brak rozm|brak wiadom|no messages|no results|nothing matched|didn't match/i.test(norm),
    };
    var aria = [];
    document.querySelectorAll('[aria-label]').forEach(function(el) {
      var al = el.getAttribute('aria-label') || '';
      if (aria.length < 100) aria.push({ label: al.substring(0, 300), tag: el.tagName.toLowerCase() });
    });
    return {
      url: location.href,
      title: document.title,
      bodyText: text,
      bodyLen: text.length,
      rowsZA: document.querySelectorAll('tr.zA').length,
      rowsRole: document.querySelectorAll('tr[role="row"]').length,
      topbar: (document.querySelector('div[gh="tm"]') || {}).innerText || '',
      searchBoxVal: (document.querySelector('input[aria-label*="Szukaj"], input[aria-label*="Search"]') || {}).value || '',
      aria: aria,
      probes: probes,
    };
  });

  fs.writeFileSync(path.join(dumpDir, 'state.json'), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(dumpDir, 'body.txt'), state.bodyText);
  fs.writeFileSync(path.join(dumpDir, 'xhr-log.json'), JSON.stringify(xhrLog, null, 2));
  var html = await page.content();
  fs.writeFileSync(path.join(dumpDir, 'page.html'), html);
  await page.screenshot({ path: path.join(dumpDir, 'screenshot.png'), fullPage: true, timeout: 10000 }).catch(function() {});

  log('');
  log('═══════════ WYNIK ═══════════');
  log('URL: ' + state.url);
  log('Wartość w pasku wyszukiwania: ' + JSON.stringify(state.searchBoxVal));
  log('Liczba wierszy: tr.zA=' + state.rowsZA + ', tr[role=row]=' + state.rowsRole);
  log('Pasek paginacji (topbar): ' + JSON.stringify(state.topbar.substring(0, 200)));
  log('');
  log('Probe: z wielu? ' + state.probes.has_z_wielu);
  log('Probe: pagination (strict): ' + (state.probes.pagination_full ? JSON.stringify(state.probes.pagination_full[0]) : 'NIE DOPASOWAŁO'));
  log('Probe: pagination (luźny):  ' + (state.probes.pagination_relaxed ? JSON.stringify(state.probes.pagination_relaxed[0]) : 'NIE DOPASOWAŁO'));
  log('Probe: no_results? ' + state.probes.no_results);
  log('');
  log('XHR hits: ' + xhrLog.length + ' responses contained count-like data');
  if (xhrLog.length > 0) {
    log('Pierwszy XHR hit: ' + JSON.stringify(xhrLog[0], null, 2).substring(0, 500));
  }
  log('');
  log('Początek body.innerText (500 znaków):');
  log(state.bodyText.substring(0, 500));
  log('');
  log('Pliki: ' + dumpDir);
  log('  - state.json  (parser state + probes + aria)');
  log('  - body.txt    (cały body.innerText)');
  log('  - page.html   (surowy HTML)');
  log('  - screenshot.png');
  log('  - xhr-log.json (XHR z liczbowymi danymi)');

  await context.close();
}

main().catch(function(err) {
  console.error('[diag] błąd:', err);
  process.exit(1);
});
