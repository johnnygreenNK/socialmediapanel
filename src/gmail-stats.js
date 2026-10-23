// Gmail stats — tries Gmail REST API (OAuth2) first for accurate counts,
// falls back to SPA scraping with multiple strategies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import {
  isConfigured as gmailApiConfigured,
  hasToken,
  getAccessToken,
  startOAuthFlow,
  getMessageCount,
  getProfile,
} from './gmail-api.js';

var NAV_TIMEOUT = 30000;
var SEARCH_WAIT = 5000;
// Cap for binary search — anything above this reports ">MAX_EXACT" instead
// of a precise number, to keep the whole collection fast. 2500 = 50 pages.
var MAX_EXACT = 2500;
// How many Gmail tabs run in parallel (each driving its own hash navigation).
var CONCURRENCY = 4;

var DEFAULT_SEARCHES = [
  { key: 'inbox',       query: 'in:inbox',             label: 'Skrzynka odbiorcza' },
  { key: 'sent',        query: 'in:sent',              label: 'Wysłane' },
  { key: 'cat_social',  query: 'category:social',      label: 'Kat. Społecznościowe' },
  { key: 'cat_promotions', query: 'category:promotions', label: 'Kat. Promocje' },
  { key: 'facebook',    query: 'from:facebookmail.com', label: 'Facebook' },
  { key: 'linkedin',    query: 'from:(e.linkedin.com OR linkedin.com)', label: 'LinkedIn' },
];

// Load keyword list from keywords.txt — first from DATA_DIR, then repo root.
// Returns an array of {key, label, query}. Falls back to DEFAULT_SEARCHES.
function loadSearches() {
  var __filename = fileURLToPath(import.meta.url);
  var __dirname = path.dirname(__filename);
  var candidates = [
    path.join(config.dataDir, 'keywords.txt'),
    path.resolve(__dirname, '..', 'keywords.txt'),
  ];
  for (var i = 0; i < candidates.length; i++) {
    try {
      var txt = fs.readFileSync(candidates[i], 'utf8');
      var list = [];
      var lines = txt.split('\n');
      for (var j = 0; j < lines.length; j++) {
        var ln = lines[j].trim();
        if (!ln || ln[0] === '#') continue;
        var parts = ln.split('|').map(function(s) { return s.trim(); });
        if (parts.length < 3) continue;
        if (!parts[0] || !parts[1] || !parts[2]) continue;
        list.push({ key: parts[0], label: parts[1], query: parts[2] });
      }
      if (list.length > 0) {
        console.log('[gmail-stats] loaded ' + list.length + ' searches from ' + candidates[i]);
        return list;
      }
    } catch (e) { /* file not there, try next */ }
  }
  console.log('[gmail-stats] no keywords.txt found, using built-in defaults');
  return DEFAULT_SEARCHES;
}

var SEARCHES = loadSearches();

function fmtN(n) {
  if (n === null || n === undefined) return '—';
  if (typeof n === 'string') return n; // ">5000" etc.
  return n.toLocaleString('pl-PL');
}

export function formatStatsForTelegram(label, s) {
  if (!s || s.error) {
    var reason = s && s.error === 'not_logged_in' ? 'konto nie jest zalogowane' : (s && s.error || 'nieznany');
    return '\u{1F4CA} Statystyki maili — ' + label + '\n\n❌ Błąd: ' + reason;
  }
  var source = s._source === 'api' ? ' (Gmail API)' : ' (SPA)';
  var lines = ['\u{1F4CA} Statystyki maili — ' + label + source, ''];
  // Render in SEARCHES order so users control grouping via keywords.txt
  var searches = s._searches || SEARCHES;
  var maxLabelLen = 0;
  for (var i = 0; i < searches.length; i++) {
    if (searches[i].label.length > maxLabelLen) maxLabelLen = searches[i].label.length;
  }
  for (var k = 0; k < searches.length; k++) {
    var sch = searches[k];
    var val = s[sch.key];
    var pad = ' '.repeat(Math.max(0, maxLabelLen - sch.label.length));
    lines.push('  ' + sch.label + ':' + pad + ' ' + fmtN(val));
  }
  if (s.contacts !== undefined) {
    lines.push('', '\u{1F465} Kontakty: ' + fmtN(s.contacts));
  }
  if (s.storage) {
    lines.push('\u{1F4BE} Pamięć: ' + s.storage.used + ' z ' + s.storage.total + ' (' + s.storage.percent + '%)');
  }
  return lines.join('\n');
}

// ─── Gmail API approach (accurate) ───────────────────────────────────────

async function collectViaApi(context, accountId, onProgress) {
  if (!gmailApiConfigured()) return null;

  var accessToken = await getAccessToken(accountId);

  if (!accessToken) {
    onProgress('Autoryzacja Gmail API (jednorazowo)...');
    try {
      accessToken = await startOAuthFlow(context, accountId);
    } catch (err) {
      console.log('[gmail-stats] OAuth flow failed: ' + err.message);
      return null;
    }
  }

  var results = { _source: 'api', _searches: SEARCHES };

  for (var i = 0; i < SEARCHES.length; i++) {
    var s = SEARCHES[i];
    onProgress('Gmail API: ' + s.label + '...');
    try {
      results[s.key] = await getMessageCount(accessToken, s.query);
      console.log('[gmail-stats] API ' + s.label + ': ' + results[s.key]);
    } catch (err) {
      console.log('[gmail-stats] API error for ' + s.key + ': ' + err.message);
      if (err.message.includes('401')) {
        accessToken = await getAccessToken(accountId);
        if (!accessToken) return null;
        try {
          results[s.key] = await getMessageCount(accessToken, s.query);
        } catch {
          results[s.key] = null;
        }
      } else {
        results[s.key] = null;
      }
    }
  }

  onProgress('Gmail API: profil...');
  try {
    var profile = await getProfile(accessToken);
    if (profile.emailAddress) results.profileEmail = profile.emailAddress;
    if (profile.messagesTotal) results.totalMessages = profile.messagesTotal;
  } catch {}

  return results;
}

// ─── SPA scraping approach (fallback) ────────────────────────────────────

// Strategy 1: Intercept Gmail's internal XHR responses to find thread counts
// Gmail loads data via fetch/XHR that contains thread count metadata
async function interceptGmailData(page, query, label) {
  return new Promise(function(resolve) {
    var timeout = setTimeout(function() { resolve(null); }, 12000);
    var found = false;

    var handler = async function(response) {
      if (found) return;
      try {
        var url = response.url();
        // Gmail data endpoints contain thread/message counts
        if (url.includes('mail.google.com') && (url.includes('?') || url.includes('/u/0/'))) {
          var ct = response.headers()['content-type'] || '';
          if (ct.includes('json') || ct.includes('javascript') || ct.includes('text/plain')) {
            var text = await response.text().catch(function() { return ''; });
            // Look for result count patterns in Gmail's internal data format
            // Pattern: ["te",<count>] — total estimated count
            var m = text.match(/\["te",\s*(\d+)/);
            if (m) {
              found = true;
              clearTimeout(timeout);
              page.off('response', handler);
              resolve(parseInt(m[1]));
              return;
            }
            // Pattern: "resultCount":"<count>"
            var m2 = text.match(/"resultCount"\s*:\s*"?(\d+)"?/);
            if (m2) {
              found = true;
              clearTimeout(timeout);
              page.off('response', handler);
              resolve(parseInt(m2[1]));
              return;
            }
          }
        }
      } catch {}
    };

    page.on('response', handler);

    // Navigate to search
    page.evaluate(function(h) { window.location.hash = h; }, '#search/' + encodeURIComponent(query))
      .catch(function() {});

    // Cleanup on timeout
    setTimeout(function() {
      page.off('response', handler);
    }, 12500);
  });
}

// Strategy 2: Parse the visible page text for count information.
// Returns one of:
//   { count: <num>, src: 'pagination' }   — exact "N-M z TOTAL"
//   { count: 0,     src: 'no-results'|'no-rows' } — empty category
//   { count: <num>, src: 'row-count' }    — <50 results, counted rows
//   { count: null,  src: 'z-wielu' }      — >50, caller must jump to last page
//   { count: null,  src: 'no-match'|'error' }
async function parsePageCount(page) {
  return page.evaluate(function() {
    var text = document.body.innerText || '';
    // Normalize unicode whitespace (NBSP, thin space, zero-width) and dashes.
    var norm = text.replace(/[    ​]/g, ' ').replace(/[–—]/g, '-');

    // "z wielu" / "of many" — >50 results. Return early BEFORE trying the
    // pagination regex, because that regex would match the literal word
    // "wielu" lookahead-free in some locales.
    if (/\bz wielu\b|\bof many\b/i.test(norm)) return { count: null, src: 'z-wielu' };

    // Exact pagination: "1-50 z 1234" / "51-100 of 1,234" / "1151-1187 z 1187".
    // Rejects "z wielu" by requiring the group to be purely digits/separators.
    var pm = norm.match(/(\d+)\s*-\s*(\d+)\s+(?:z|of)\s+(\d[\d\s,.]*\d|\d+)\b/i);
    if (pm) {
      var t = parseInt(pm[3].replace(/[\s,.]/g, ''), 10);
      if (!isNaN(t) && t >= 1) return { count: t, src: 'pagination' };
    }

    // No-results patterns (PL + EN, broad to catch empty categories like Fora)
    if (/nie znaleziono|nie pasuj|brak wynik|brak rozm|brak wiadom|no messages|no results|nothing matched|didn't match/i.test(norm)) {
      return { count: 0, src: 'no-results' };
    }

    // <50 results, no pagination shown — count visible rows
    var rows = document.querySelectorAll('tr.zA, tr[role="row"]');
    if (rows.length > 0 && rows.length < 50) {
      return { count: rows.length, src: 'row-count' };
    }
    if (rows.length === 0) {
      return { count: 0, src: 'no-rows' };
    }

    return { count: null, src: 'no-match' };
  }).catch(function() { return { count: null, src: 'error' }; });
}

// Strategy 2b: Find the last page via URL pagination.
// Gmail's hash is "#search/<encoded-query>/p<N>" (page N, 50 per page).
// We binary-search for the highest N that still has results, then compute
// total = (N-1)*50 + <rows on that page>.
async function jumpToLastPageViaUrl(page, query, label) {
  var encoded = encodeURIComponent(query);
  async function tryPage(n) {
    await page.evaluate(function(h) { window.location.hash = h; },
      '#search/' + encoded + '/p' + n).catch(function() {});
    // Wait until the page settles on a state we can read, instead of a
    // fixed sleep. Usually resolves in 400-900ms.
    await page.waitForFunction(function() {
      var t = (document.body.innerText || '').replace(/[   ]/g, ' ');
      if (/z wielu|of many/i.test(t)) return true;
      if (/\d+\s*[-–]\s*\d+\s+(?:z|of)\s+\d/i.test(t)) return true;
      if (/nie znaleziono|nie pasuj|brak wynik|brak wiadom|no messages|no results|nothing matched|didn't match/i.test(t)) return true;
      // Any visible row count also means the page rendered
      return document.querySelectorAll('tr.zA, tr[role="row"]').length > 0;
    }, { timeout: 4000 }).catch(function() {});
    // Small settle delay for pagination text to appear (fast)
    await new Promise(function(r) { setTimeout(r, 250); });
    var p = await parsePageCount(page);
    var rows = await page.evaluate(function() {
      return document.querySelectorAll('tr.zA, tr[role="row"]').length;
    }).catch(function() { return 0; });
    return { parsed: p, rows: rows, n: n };
  }

  // Max page: MAX_EXACT / 50. Above this we report ">MAX_EXACT" to stay fast.
  var MAX_PAGE = Math.ceil(MAX_EXACT / 50);
  // Binary search: lo always has results, hi doesn't (or unknown)
  var lo = 1, hi = MAX_PAGE, lastGood = null;
  // Fast exponential probe up to find the first empty page
  var probe = 2;
  var firstEmpty = null;
  while (probe <= MAX_PAGE) {
    var r = await tryPage(probe);
    if (r.parsed.src === 'pagination') {
      console.log('[gmail-stats] ' + label + ': probe p' + probe + ' → pagination ' + r.parsed.count);
      return r.parsed.count; // Exact total already shown
    }
    if (r.rows > 0 && r.rows < 50 && r.parsed.src !== 'z-wielu') {
      // Partial page = this IS the last page
      var total = (probe - 1) * 50 + r.rows;
      console.log('[gmail-stats] ' + label + ': probe p' + probe + ' partial (' + r.rows + ' rows) → ' + total);
      return total;
    }
    if (r.rows === 0 || r.parsed.src === 'no-results' || r.parsed.src === 'no-rows') {
      firstEmpty = probe;
      hi = probe - 1;
      break;
    }
    // Full page of 50, still "z wielu" — go higher
    lo = probe;
    lastGood = r;
    probe = probe * 2;
  }
  if (firstEmpty === null) {
    // Even the cap page had 50 rows → more than MAX_EXACT messages
    console.log('[gmail-stats] ' + label + ': >' + MAX_EXACT + ' (capped)');
    return '>' + MAX_EXACT;
  }

  // Binary search between lo (has 50) and hi (one below first empty)
  while (lo < hi) {
    var mid = Math.floor((lo + hi + 1) / 2);
    var rm = await tryPage(mid);
    if (rm.parsed.src === 'pagination') {
      console.log('[gmail-stats] ' + label + ': bsearch p' + mid + ' → pagination ' + rm.parsed.count);
      return rm.parsed.count;
    }
    if (rm.rows > 0 && rm.rows < 50 && rm.parsed.src !== 'z-wielu') {
      var tot = (mid - 1) * 50 + rm.rows;
      console.log('[gmail-stats] ' + label + ': bsearch p' + mid + ' partial → ' + tot);
      return tot;
    }
    if (rm.rows === 0 || rm.parsed.src === 'no-results' || rm.parsed.src === 'no-rows') {
      hi = mid - 1;
    } else {
      lo = mid;
      lastGood = rm;
    }
  }
  // Final: lo has full page, lo+1 was empty → total = lo*50
  console.log('[gmail-stats] ' + label + ': bsearch converged at p' + lo + ' full → ' + (lo * 50));
  return lo * 50;
}


// Strategy 3: Use context.request to call Gmail's internal API
async function tryContextRequest(context, ik, at, query) {
  try {
    var apiUrl = 'https://mail.google.com/mail/u/0/?ui=2&ik=' + ik + '&at=' + at +
      '&view=tl&start=0&num=1&rt=c&q=' + encodeURIComponent(query);
    var response = await context.request.get(apiUrl, {
      headers: {
        'X-Same-Domain': '1',
        'X-Requested-With': 'XMLHttpRequest',
      }
    });
    var text = await response.text();
    if (text && text.charAt(0) !== '<') {
      var m = text.match(/\["te",\s*(\d+)/);
      if (m) return parseInt(m[1]);
      // Try alternate patterns
      var m2 = text.match(/"totalSize"\s*:\s*(\d+)/);
      if (m2) return parseInt(m2[1]);
      console.log('[gmail-stats] context.request non-HTML but no count: ' + text.substring(0, 300));
      return null;
    }
    console.log('[gmail-stats] context.request HTML (' + response.status() + ')');
    return null;
  } catch(e) {
    console.log('[gmail-stats] context.request error: ' + e.message);
    return null;
  }
}

async function searchCount(context, page, ik, at, query, label, useContextReq) {
  // Navigate to the search via hash and wait for the page to render.
  await page.evaluate(function(h) { window.location.hash = h; },
    '#search/' + encodeURIComponent(query)).catch(function() {});
  await page.waitForFunction(function() {
    var t = (document.body.innerText || '').replace(/[   ]/g, ' ');
    if (/z wielu|of many/i.test(t)) return true;
    if (/\d+\s*[-–]\s*\d+\s+(?:z|of)\s+\d/i.test(t)) return true;
    if (/nie znaleziono|nie pasuj|brak wynik|brak wiadom|no messages|no results|nothing matched|didn't match/i.test(t)) return true;
    return document.querySelectorAll('tr.zA, tr[role="row"]').length > 0;
  }, { timeout: 5000 }).catch(function() {});
  await new Promise(function(r) { setTimeout(r, 250); });

  var parsed = await parsePageCount(page);

  // If Gmail shows "z wielu", binary-search page URLs to find the last page.
  if (parsed.src === 'z-wielu') {
    try {
      var total = await jumpToLastPageViaUrl(page, query, label);
      if (total !== null && total !== undefined) {
        console.log('[gmail-stats] ' + label + ': ' + total + ' (SPA url-bsearch)');
        return total;
      }
    } catch (e) {
      console.log('[gmail-stats] ' + label + ': bsearch failed: ' + e.message);
    }
  }

  console.log('[gmail-stats] ' + label + ': ' + parsed.count + ' (SPA ' + parsed.src + ')');
  return parsed.count;
}

// Open one Gmail tab and make sure it's logged in and settled.
async function openGmailTab(context) {
  var page = await context.newPage();
  await page.goto('https://mail.google.com/mail/u/0/#inbox', {
    waitUntil: 'load',
    timeout: NAV_TIMEOUT,
  });
  // Wait for the real Gmail UI (search box, nav list) instead of a fixed 8s
  await page.waitForFunction(function() {
    return !!document.querySelector('div[gh="s"], input[aria-label*="Szukaj"], input[aria-label*="Search"], tr.zA, tr[role="row"]');
  }, { timeout: 15000 }).catch(function() {});
  return page;
}

async function collectViaSPA(context, onProgress) {
  // Open 1 tab first to verify login, then spin up the rest for the pool.
  var primary = await openGmailTab(context);
  var url = primary.url();
  console.log('[gmail-stats] Gmail loaded, url: ' + url);
  if (!url.includes('mail.google.com')) {
    await primary.close().catch(function() {});
    return { error: 'not_logged_in', url: url };
  }

  // Open additional tabs in parallel
  onProgress('Otwieram ' + CONCURRENCY + ' kart Gmaila...');
  var extraCount = Math.max(0, CONCURRENCY - 1);
  var extras = await Promise.all(
    Array.from({ length: extraCount }, function() { return openGmailTab(context); })
  );
  var tabs = [primary].concat(extras);
  console.log('[gmail-stats] ' + tabs.length + ' tabs ready');

  var results = { _source: 'spa', _searches: SEARCHES };
  var done = 0;

  try {
    // Work-stealing pool: tabs pull next search from a shared queue.
    var queue = SEARCHES.slice();
    var workers = tabs.map(function(page, idx) {
      return (async function() {
        while (queue.length > 0) {
          var s = queue.shift();
          if (!s) break;
          try {
            results[s.key] = await searchCount(null, page, null, null, s.query, s.label, false);
          } catch (e) {
            console.log('[gmail-stats] ' + s.label + ' error: ' + e.message);
            results[s.key] = null;
          }
          done++;
          onProgress('[' + done + '/' + SEARCHES.length + '] ' + s.label + ' ✓');
        }
      })();
    });
    await Promise.all(workers);

    // Contacts
    // Contacts & storage run on the primary tab in parallel with each other.
    onProgress('Kontakty + pamięć...');
    var [contacts, storage] = await Promise.all([
      (async function() {
        try {
          var p2 = tabs[1] || primary; // use a worker tab if available
          await p2.goto('https://contacts.google.com/', {
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT,
          });
          var deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            var cnt = await p2.evaluate(function() {
              var text = document.body.innerText || '';
              var m = text.match(/(\d[\d\s,]*)\s+(?:kontakt|contact)/i);
              if (m) return parseInt(m[1].replace(/\D/g, ''));
              var els = document.querySelectorAll('[aria-label*="kontakt"], [aria-label*="contact"]');
              for (var i = 0; i < els.length; i++) {
                var am = els[i].getAttribute('aria-label').match(/(\d+)/);
                if (am) return parseInt(am[1]);
              }
              return null;
            });
            if (cnt !== null) return cnt;
            await new Promise(function(r) { setTimeout(r, 400); });
          }
        } catch(e) {}
        return null;
      })(),
      (async function() {
        try {
          // Primary tab is already on Gmail — just wait for the storage line
          await primary.evaluate(function(h) { window.location.hash = h; }, '#inbox').catch(() => {});
          var deadline = Date.now() + 6000;
          while (Date.now() < deadline) {
            var storage = await primary.evaluate(function() {
              var text = document.body.innerText || '';
              var m = text.match(/Używasz\s+(\d+)\s*%\s+z\s+([\d,.]+\s*GB)/i);
              if (m) return { used: m[1] + '%', percent: parseInt(m[1]), total: m[2].trim() };
              var m2 = text.match(/([\d,.]+\s*(?:GB|MB|KB))\s*\((\d+)%\)\s+(?:of|z)\s+([\d,.]+\s*GB)/i);
              if (m2) return { used: m2[1].trim(), percent: parseInt(m2[2]), total: m2[3].trim() };
              return null;
            }).catch(() => null);
            if (storage) return storage;
            await new Promise(function(r) { setTimeout(r, 400); });
          }
        } catch(e) {}
        return null;
      })(),
    ]);
    if (contacts !== null) results.contacts = contacts;
    if (storage) results.storage = storage;

    onProgress('Gotowe!');
    return results;

  } finally {
    for (var i = 0; i < tabs.length; i++) {
      await tabs[i].close().catch(function() {});
    }
  }
}

// ─── Main entry point ────────────────────────────────────────────────────

export async function collectGmailStats(context, onProgress, accountId) {
  if (!onProgress) onProgress = function() {};

  // Try Gmail API first
  if (accountId && gmailApiConfigured()) {
    onProgress('Próba Gmail API...');
    try {
      var apiResults = await collectViaApi(context, accountId, onProgress);
      if (apiResults) {
        onProgress('Gotowe (Gmail API)!');
        return apiResults;
      }
    } catch (err) {
      console.log('[gmail-stats] API failed, falling back to SPA: ' + err.message);
    }
    onProgress('Gmail API niedostępne, przełączam na SPA...');
  }

  return collectViaSPA(context, onProgress);
}
