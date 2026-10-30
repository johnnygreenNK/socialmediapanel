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
// How many Gmail tabs run in parallel. 4 tabs → Gmail's cross-tab sync
// (BroadcastChannel) causes views to clobber each other. 3 works reliably
// after we added auto-retry + warm-up.
var CONCURRENCY = 3;

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

// Section definitions for pretty grouping in Telegram and the panel.
// Each section matches keys by prefix OR explicit list; items keep the
// order they appeared in keywords.txt.
var SECTIONS = [
  { title: '📬 Skrzynka',         keys: ['inbox', 'sent', 'unread', 'starred', 'important', 'spam', 'trash'] },
  { title: '🗂 Kategorie Gmail',  prefix: 'cat_' },
  { title: '📱 Social media',     keys: ['facebook', 'instagram', 'whatsapp', 'linkedin', 'twitter_x', 'tiktok', 'youtube', 'discord', 'telegram'] },
  { title: '₿ Giełdy / krypto',  keys: ['binance', 'bybit', 'kraken', 'kucoin', 'bitget', 'gateio', 'mexc', 'cryptocom', 'htx', 'gemini', 'bitstamp', 'whitebit', 'trustwallet'] },
  { title: '🔐 Bezpieczeństwo',  prefix: 'sec_' },
  { title: '💼 Finanse / Zakupy', keys: ['paypal', 'revolut', 'stripe', 'allegro', 'olx', 'amazon', 'apple', 'microsoft', 'netflix', 'spotify', 'steam'] },
];

function keyMatchesSection(key, section) {
  if (section.prefix && key.indexOf(section.prefix) === 0) return true;
  if (section.keys && section.keys.indexOf(key) >= 0) return true;
  return false;
}

// Group searches into sections (preserving keywords.txt order within).
// Unknown keys land in a trailing "Inne" section.
function groupSearches(searches) {
  var groups = SECTIONS.map(function(sec) { return { title: sec.title, items: [] }; });
  var other = { title: 'ℹ️ Inne', items: [] };
  for (var i = 0; i < searches.length; i++) {
    var s = searches[i];
    var placed = false;
    for (var j = 0; j < SECTIONS.length; j++) {
      if (keyMatchesSection(s.key, SECTIONS[j])) { groups[j].items.push(s); placed = true; break; }
    }
    if (!placed) other.items.push(s);
  }
  var result = groups.filter(function(g) { return g.items.length > 0; });
  if (other.items.length > 0) result.push(other);
  return result;
}

export function formatStatsForTelegram(label, s) {
  if (!s || s.error) {
    var reason = s && s.error === 'not_logged_in' ? 'konto nie jest zalogowane' : (s && s.error || 'nieznany');
    return '📊 <b>Statystyki maili — ' + escapeHtml(label) + '</b>\n\n❌ Błąd: ' + escapeHtml(reason);
  }
  var source = s._source === 'api' ? 'Gmail API' : 'SPA';
  var out = '📊 <b>Statystyki maili — ' + escapeHtml(label) + '</b>  <i>· ' + source + '</i>\n';

  var searches = s._searches || SEARCHES;
  var groups = groupSearches(searches);

  // Each section = bold title line, then its own <pre> block so column
  // alignment survives in Telegram (which doesn't allow nested tags in <pre>).
  for (var g = 0; g < groups.length; g++) {
    var grp = groups[g];
    var items = grp.items;
    var maxLen = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].label.length > maxLen) maxLen = items[i].label.length;
    }
    var rows = '';
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var val = s[it.key];
      // Skip zero / null / undefined entries
      if (val === 0 || val === null || val === undefined) continue;
      var pad = ' '.repeat(Math.max(0, maxLen - it.label.length));
      rows += escapeHtml(it.label) + pad + '  ' + escapeHtml(fmtN(val)) + '\n';
    }
    if (!rows) continue; // skip entire section if all zeros
    out += '\n' + escapeHtml(grp.title) + '\n<pre>' + rows + '</pre>';
  }

  // Account tail (contacts/storage)
  if (s.contacts !== undefined || s.storage) {
    var tailRows = '';
    var tailMax = 0;
    if (s.contacts !== undefined) tailMax = Math.max(tailMax, 'Kontakty'.length);
    if (s.storage) tailMax = Math.max(tailMax, 'Pamięć'.length);
    if (s.contacts !== undefined) {
      var p = ' '.repeat(Math.max(0, tailMax - 'Kontakty'.length));
      tailRows += '👥 Kontakty' + p + '  ' + fmtN(s.contacts) + '\n';
    }
    if (s.storage) {
      var p2 = ' '.repeat(Math.max(0, tailMax - 'Pamięć'.length));
      tailRows += '💾 Pamięć' + p2 + '    ' + s.storage.used + ' z ' + s.storage.total + ' (' + s.storage.percent + '%)\n';
    }
    out += '\n👤 Konto\n<pre>' + tailRows + '</pre>';
  }

  return out;
}

function escapeHtml(x) {
  return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    var before = await page.evaluate(function() {
      return (document.body.innerText || '').substring(0, 200);
    }).catch(function() { return ''; });
    await page.evaluate(function(h) { window.location.hash = h; },
      '#search/' + encoded + '/p' + n).catch(function() {});
    await page.waitForFunction(function(prev) {
      var raw = (document.body.innerText || '');
      if (raw.substring(0, 200) === prev) return false;
      var t = raw.replace(/[   ]/g, ' ');
      if (/z wielu|of many/i.test(t)) return true;
      if (/\d+\s*[-–]\s*\d+\s+(?:z|of)\s+\d/i.test(t)) return true;
      if (/nie znaleziono|nie pasuj|brak wynik|brak wiadom|no messages|no results|nothing matched|didn't match/i.test(t)) return true;
      return document.querySelectorAll('tr.zA, tr[role="row"]').length > 0;
    }, { timeout: 5000 }, before).catch(function() {});
    await new Promise(function(r) { setTimeout(r, 400); });
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

// ─── Debug dump: forensic snapshot of a search page ──────────────────────
// Writes a dir with the full state (URL, html, innerText, screenshot,
// regex probes) so we can see exactly what the parser sees. Only used
// when DEBUG=1 or when a count comes back null/0.
var DEBUG_ENABLED = process.env.GMAIL_STATS_DEBUG === '1' || process.env.DEBUG === '1';
var DEBUG_SESSION = null;
function debugDir() {
  if (!DEBUG_SESSION) {
    var ts = new Date().toISOString().replace(/[:.]/g, '-');
    DEBUG_SESSION = path.join(config.dataDir || '/tmp', 'gmail-debug', ts);
    try { fs.mkdirSync(DEBUG_SESSION, { recursive: true }); } catch {}
    console.log('[gmail-stats] DEBUG dumps → ' + DEBUG_SESSION);
  }
  return DEBUG_SESSION;
}
async function debugDump(page, label, query, parsed, tag) {
  if (!DEBUG_ENABLED) return;
  try {
    var dir = debugDir();
    var safe = (label + '-' + (tag || '')).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    var base = path.join(dir, safe);
    var info = await page.evaluate(function() {
      var text = document.body.innerText || '';
      var norm = text.replace(/[    ​]/g, ' ').replace(/[–—]/g, '-');
      // Probe every regex we care about
      var probes = {
        has_z_wielu: /\bz wielu\b|\bof many\b/i.test(norm),
        pagination: norm.match(/(\d+)\s*-\s*(\d+)\s+(?:z|of)\s+(\d[\d\s,.]*\d|\d+)\b/i),
        no_results: /nie znaleziono|nie pasuj|brak wynik|brak rozm|brak wiadom|no messages|no results|nothing matched|didn't match/i.test(norm),
      };
      // Collect everything that looks like a count-with-label on the page
      var ariaHits = [];
      document.querySelectorAll('[aria-label]').forEach(function(el) {
        var al = el.getAttribute('aria-label') || '';
        if (/wynik|result|wiadom|message|rozm|conversation/i.test(al) || /\d/.test(al)) {
          if (ariaHits.length < 40) ariaHits.push(al.substring(0, 200));
        }
      });
      // Table/toolbar signposts
      var topbar = (document.querySelector('div[gh="tm"]') || {}).innerText || '';
      var searchBox = (document.querySelector('input[aria-label*="Szukaj"], input[aria-label*="Search"]') || {}).value || '';
      return {
        url: location.href,
        title: document.title,
        bodyTextFirst2k: text.substring(0, 2000),
        bodyTextLen: text.length,
        rowsZA: document.querySelectorAll('tr.zA').length,
        rowsRole: document.querySelectorAll('tr[role="row"]').length,
        topbarText: topbar.substring(0, 500),
        searchBoxValue: searchBox,
        ariaHits: ariaHits,
        probes: probes,
      };
    }).catch(function(e) { return { error: String(e.message || e) }; });

    var txt = [
      '=== DEBUG DUMP: ' + label + ' (' + (tag || '-') + ') ===',
      'Query: ' + query,
      'Parsed: ' + JSON.stringify(parsed),
      'URL: ' + info.url,
      'Title: ' + info.title,
      'Rows (tr.zA): ' + info.rowsZA + ' | Rows (role=row): ' + info.rowsRole,
      'SearchBox value: ' + info.searchBoxValue,
      'Topbar text: ' + info.topbarText,
      '--- Regex probes ---',
      'has_z_wielu: ' + info.probes.has_z_wielu,
      'pagination match: ' + JSON.stringify(info.probes.pagination),
      'no_results: ' + info.probes.no_results,
      '--- aria-label hits (first 40) ---',
      info.ariaHits.map(function(a, i) { return '[' + i + '] ' + a; }).join('\n'),
      '--- body.innerText (first 2000 chars, len=' + info.bodyTextLen + ') ---',
      info.bodyTextFirst2k,
    ].join('\n');
    fs.writeFileSync(base + '.txt', txt);
    await page.screenshot({ path: base + '.png', fullPage: false, timeout: 5000 }).catch(function() {});
    var html = await page.content().catch(function() { return ''; });
    if (html) fs.writeFileSync(base + '.html', html);
    console.log('[gmail-stats] DEBUG dumped: ' + base + '.{txt,png,html}');
  } catch (e) {
    console.log('[gmail-stats] debugDump error: ' + e.message);
  }
}

// Core: navigate to a search and parse the result page. Retries on
// "no-match" (race condition: view hadn't finished loading yet).
async function navigateAndParse(page, query, label, attempt) {
  var before = await page.evaluate(function() {
    return (document.body.innerText || '').substring(0, 200);
  }).catch(function() { return ''; });

  await page.evaluate(function(h) { window.location.hash = h; },
    '#search/' + encodeURIComponent(query)).catch(function() {});

  var swapped = await page.waitForFunction(function(prev) {
    var raw = (document.body.innerText || '');
    if (raw.substring(0, 200) === prev) return false;
    var t = raw.replace(/[   ]/g, ' ');
    if (/z wielu|of many/i.test(t)) return true;
    if (/\d+\s*[-–]\s*\d+\s+(?:z|of)\s+\d/i.test(t)) return true;
    if (/nie znaleziono|nie pasuj|brak wynik|brak wiadom|no messages|no results|nothing matched|didn't match/i.test(t)) return true;
    return document.querySelectorAll('tr.zA, tr[role="row"]').length > 0;
  }, { timeout: 6000 }, before).then(function() { return true; }, function() { return false; });
  // Longer settle on retry — give Gmail time to finish loading
  await new Promise(function(r) { setTimeout(r, attempt > 0 ? 1500 : 500); });

  var parsed = await parsePageCount(page);
  var currentUrl = await page.evaluate(function() { return location.href; }).catch(function() { return '?'; });
  console.log('[gmail-stats] ' + label + ' | q=' + query + ' | try=' + attempt + ' | swap=' + swapped + ' | url-hash=' + (currentUrl.split('#')[1] || '').substring(0, 60) + ' | parse: ' + parsed.src + '/' + parsed.count);
  return parsed;
}

async function searchCount(context, page, ik, at, query, label, useContextReq) {
  var parsed = await navigateAndParse(page, query, label, 0);

  // Retry up to 2x on no-match / error (Gmail wasn't ready; happens on
  // first query per tab and on long/complex OR queries that render slower)
  var retries = 0;
  while ((parsed.src === 'no-match' || parsed.src === 'error') && retries < 2) {
    retries++;
    console.log('[gmail-stats] ' + label + ' RETRY ' + retries + ' (parse was ' + parsed.src + ')');
    // Reset the view first so the next navigation definitely re-renders
    await page.evaluate(function() { window.location.hash = '#inbox'; }).catch(function() {});
    await new Promise(function(r) { setTimeout(r, 800); });
    parsed = await navigateAndParse(page, query, label, retries);
  }

  // Dump forensic snapshot if parse looked wrong even after retries
  if (DEBUG_ENABLED || parsed.src === 'no-match' || parsed.src === 'error') {
    await debugDump(page, label, query, parsed, parsed.src);
  }

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
  console.log('[gmail-stats] ' + tabs.length + ' tabs ready, warming up...');

  // Warm-up: each tab performs a throwaway search so Gmail's SPA router,
  // XHR cache and view scaffolding are initialized BEFORE the real queries
  // start. Without this, the first search on each tab reliably races and
  // returns no-match. Done in parallel across tabs.
  await Promise.all(tabs.map(async function(page, idx) {
    try {
      await page.evaluate(function() { window.location.hash = '#search/in%3Ainbox'; });
      await page.waitForFunction(function() {
        var t = (document.body.innerText || '');
        return /z wielu|of many/i.test(t) ||
               /\d+\s*[-–]\s*\d+\s+(?:z|of)\s+\d/i.test(t) ||
               /nie znaleziono|brak wynik|no results/i.test(t) ||
               document.querySelectorAll('tr.zA, tr[role="row"]').length > 0;
      }, { timeout: 8000 });
      await new Promise(function(r) { setTimeout(r, 300); });
      console.log('[gmail-stats] tab#' + idx + ' warm');
    } catch (e) {
      console.log('[gmail-stats] tab#' + idx + ' warmup failed: ' + e.message);
    }
  }));

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
