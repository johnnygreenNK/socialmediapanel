// Gmail stats — tries Gmail REST API (OAuth2) first for accurate counts,
// falls back to SPA scraping with multiple strategies.

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

var SEARCHES = [
  { key: 'inbox',       query: 'in:inbox',       label: 'Skrzynka odbiorcza' },
  { key: 'sent',        query: 'in:sent',         label: 'Wysłane' },
  { key: 'social',      query: 'category:social',      label: 'Kategoria: Społecznościowe' },
  { key: 'promotions',  query: 'category:promotions',  label: 'Kategoria: Promocje' },
  { key: 'updates',     query: 'category:updates',     label: 'Kategoria: Powiadomienia' },
  { key: 'forums',      query: 'category:forums',      label: 'Kategoria: Fora' },
  { key: 'facebook',    query: 'from:facebook.com OR from:facebookmail.com', label: 'Od: Facebook' },
  { key: 'instagram',   query: 'from:instagram.com',   label: 'Od: Instagram' },
  { key: 'twitter',     query: 'from:twitter.com OR from:x.com', label: 'Od: Twitter/X' },
  { key: 'linkedin',    query: 'from:linkedin.com',    label: 'Od: LinkedIn' },
  { key: 'tiktok',      query: 'from:tiktok.com',      label: 'Od: TikTok' },
  { key: 'youtube',     query: 'from:youtube.com OR from:youtubemail.com', label: 'Od: YouTube' },
  { key: 'exchanges',   query: 'from:binance.com OR from:coinbase.com OR from:kraken.com OR from:bybit.com OR from:okx.com OR from:kucoin.com OR from:bitget.com OR from:gate.io OR from:bitmex.com', label: 'Od: Giełdy kryptowalut' },
];

function fmtN(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('pl-PL');
}

export function formatStatsForTelegram(label, s) {
  if (!s || s.error) {
    var reason = s && s.error === 'not_logged_in' ? 'konto nie jest zalogowane' : (s && s.error || 'nieznany');
    return '\u{1F4CA} Statystyki maili — ' + label + '\n\n❌ Błąd: ' + reason;
  }
  var source = s._source === 'api' ? ' (Gmail API)' : ' (SPA)';
  var lines = [
    '\u{1F4CA} Statystyki maili — ' + label + source,
    '',
    '\u{1F4E5} Skrzynka odbiorcza: ' + fmtN(s.inbox),
    '\u{1F4E4} Wysłane:            ' + fmtN(s.sent),
    '\u{1F465} Kontakty:           ' + fmtN(s.contacts),
    '',
    '\u{1F5C2} Kategorie Gmail:',
    '  Społecznościowe: ' + fmtN(s.social),
    '  Promocje:        ' + fmtN(s.promotions),
    '  Powiadomienia:   ' + fmtN(s.updates),
    '  Fora:            ' + fmtN(s.forums),
    '',
    '\u{1F4F1} Social Media:',
    '  Facebook:   ' + fmtN(s.facebook),
    '  Instagram:  ' + fmtN(s.instagram),
    '  Twitter/X:  ' + fmtN(s.twitter),
    '  LinkedIn:   ' + fmtN(s.linkedin),
    '  TikTok:     ' + fmtN(s.tiktok),
    '  YouTube:    ' + fmtN(s.youtube),
    '',
    '₿ Giełdy krypto: ' + fmtN(s.exchanges),
  ];
  if (s.storage) {
    lines.push('', '\u{1F4BE} Pamięć: ' + s.storage.used + ' z ' + s.storage.total + ' (' + s.storage.percent + '%)');
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

  var results = { _source: 'api' };

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

// Strategy 2: Parse the visible page text for count information
async function parsePageCount(page, label) {
  return page.evaluate(function() {
    var text = document.body.innerText || '';
    // Normalize whitespace and dashes
    var norm = text.replace(/[   ​]/g, ' ').replace(/[–—]/g, '-');

    // "No results" patterns (PL + EN)
    if (/nie pasuj|brak wynik|brak rozm|no results|nothing matched/i.test(norm)) {
      return { count: 0, src: 'no-results' };
    }

    // Pagination pattern: "1-50 z 1234" or "1-50 of 1,234" or "1–50 z 1 234"
    var patterns = [
      /(\d+)\s*[-–]\s*(\d+)\s+(?:z|of)\s+([\d\s,.]+\d)/,
      /(\d+)\s*[-–]\s*(\d+)\s+(?:z|of)\s+(?:wielu|many|approximately)\s+([\d\s,.]+\d)/,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = norm.match(patterns[i]);
      if (m) {
        var t = parseInt(m[3].replace(/[\s,.]/g, ''));
        if (!isNaN(t) && t >= 1) return { count: t, src: 'pagination' };
      }
    }

    // "z wielu" / "of many" — means >50 results, try to count visible rows
    if (/z wielu|of many/i.test(norm)) {
      // Count visible email rows — Gmail renders ~50 per page
      var rows = document.querySelectorAll('tr.zA, tr[role="row"], div.Cp tr');
      if (rows.length > 0) return { count: rows.length, src: 'z-wielu-rows', approx: true };
      return { count: 50, src: 'z-wielu-min', approx: true };
    }

    // Single result page — might just show messages without pagination
    // Try counting visible email rows
    var emailRows = document.querySelectorAll('tr.zA, tr[role="row"]');
    if (emailRows.length > 0 && emailRows.length < 50) {
      return { count: emailRows.length, src: 'row-count' };
    }

    // aria-label on search bar or result area sometimes contains count
    var ariaEls = document.querySelectorAll('[aria-label*="wynik"], [aria-label*="result"]');
    for (var j = 0; j < ariaEls.length; j++) {
      var label = ariaEls[j].getAttribute('aria-label');
      var am = label.match(/(\d[\d\s,.]*\d|\d+)\s+(?:wynik|result)/i);
      if (am) {
        var av = parseInt(am[1].replace(/[\s,.]/g, ''));
        if (!isNaN(av)) return { count: av, src: 'aria' };
      }
    }

    return { count: null, src: 'no-match' };
  }).catch(function() { return { count: null, src: 'error' }; });
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
  // Try context.request API first (fastest, no DOM)
  if (useContextReq) {
    var apiCount = await tryContextRequest(context, ik, at, query);
    if (apiCount !== null) {
      console.log('[gmail-stats] ' + label + ': ' + apiCount + ' (context.request)');
      return apiCount;
    }
  }

  // Try intercepting XHR responses during navigation
  var interceptResult = await interceptGmailData(page, query, label);
  if (interceptResult !== null) {
    console.log('[gmail-stats] ' + label + ': ' + interceptResult + ' (intercept)');
    return interceptResult;
  }

  // Wait for page to settle and parse visible text
  await new Promise(function(r) { setTimeout(r, 2000); });
  var parsed = await parsePageCount(page, label);
  console.log('[gmail-stats] ' + label + ': ' + parsed.count + ' (SPA ' + parsed.src + (parsed.approx ? ' ~approx' : '') + ')');
  return parsed.count;
}

async function collectViaSPA(context, onProgress) {
  var page = await context.newPage();

  try {
    var ik = null;
    var at = null;
    // Intercept ALL responses to capture tokens and data
    page.on('response', function(response) {
      var url = response.url();
      if (!ik) { var m = url.match(/[?&]ik=([a-f0-9]{6,14})/i); if (m) ik = m[1]; }
      if (!at) { var m2 = url.match(/[?&]at=([^&]{10,})/); if (m2) at = m2[1]; }
    });

    onProgress('Ładowanie Gmail...');
    await page.goto('https://mail.google.com/mail/u/0/#inbox', {
      waitUntil: 'load',
      timeout: NAV_TIMEOUT,
    });
    await new Promise(function(r) { setTimeout(r, 8000); });

    var url = page.url();
    console.log('[gmail-stats] Gmail loaded, url: ' + url);
    console.log('[gmail-stats] tokens: ik=' + (ik || 'NONE') + ' at=' + (at ? at.substring(0, 20) + '...' : 'NONE'));

    if (!url.includes('mail.google.com')) {
      return { error: 'not_logged_in', url: url };
    }

    // Also try to extract tokens from page JavaScript globals
    if (!ik || !at) {
      var tokens = await page.evaluate(function() {
        var result = {};
        // Gmail stores GLOBALS with ik and at tokens
        try {
          var scripts = document.querySelectorAll('script');
          for (var i = 0; i < scripts.length; i++) {
            var t = scripts[i].textContent || '';
            if (!result.ik) {
              var ikm = t.match(/\bik\s*[:=]\s*["']([a-f0-9]{6,14})["']/i);
              if (ikm) result.ik = ikm[1];
            }
            if (!result.at) {
              var atm = t.match(/\bat\s*[:=]\s*["']([^"']{10,})["']/);
              if (atm) result.at = atm[1];
            }
          }
        } catch {}
        // Try GM_ACTION_TOKEN
        try {
          if (typeof GM_ACTION_TOKEN !== 'undefined') result.at = GM_ACTION_TOKEN;
        } catch {}
        // Try GLOBALS
        try {
          if (typeof GLOBALS !== 'undefined' && GLOBALS[9]) result.at = GLOBALS[9];
          if (typeof GLOBALS !== 'undefined' && GLOBALS[10]) result.ik = GLOBALS[10];
        } catch {}
        return result;
      }).catch(function() { return {}; });

      if (tokens.ik && !ik) { ik = tokens.ik; console.log('[gmail-stats] ik from page: ' + ik); }
      if (tokens.at && !at) { at = tokens.at; console.log('[gmail-stats] at from page: ' + at.substring(0, 20) + '...'); }
    }

    // Test context.request
    var useContextReq = false;
    if (ik && at) {
      var testCount = await tryContextRequest(context, ik, at, 'in:sent');
      if (testCount !== null) {
        useContextReq = true;
        console.log('[gmail-stats] context.request works! in:sent = ' + testCount);
      }
    }

    var results = { _source: 'spa' };

    for (var i = 0; i < SEARCHES.length; i++) {
      var s = SEARCHES[i];
      onProgress('Zliczam: ' + s.label + '...');
      results[s.key] = await searchCount(context, page, ik, at, s.query, s.label, useContextReq);
    }

    // Contacts
    onProgress('Ładowanie kontaktów...');
    try {
      await page.goto('https://contacts.google.com/', {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT,
      });
      var deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        var cnt = await page.evaluate(function() {
          var text = document.body.innerText || '';
          // PL: "123 kontakty", EN: "123 contacts"
          var m = text.match(/(\d[\d\s,]*)\s+(?:kontakt|contact)/i);
          if (m) return parseInt(m[1].replace(/\D/g, ''));
          // Also try aria labels
          var els = document.querySelectorAll('[aria-label*="kontakt"], [aria-label*="contact"]');
          for (var i = 0; i < els.length; i++) {
            var am = els[i].getAttribute('aria-label').match(/(\d+)/);
            if (am) return parseInt(am[1]);
          }
          return null;
        });
        if (cnt !== null) { results.contacts = cnt; break; }
        await new Promise(function(r) { setTimeout(r, 500); });
      }
    } catch(e) {
      results.contacts = null;
    }

    // Storage
    onProgress('Pobieranie użycia pamięci...');
    try {
      await page.goto('https://mail.google.com/mail/u/0/#inbox', {
        waitUntil: 'load',
        timeout: NAV_TIMEOUT,
      });
      await new Promise(function(r) { setTimeout(r, 3000); });
      var storage = await page.evaluate(function() {
        var text = document.body.innerText;
        // PL: "Używasz 10% z 15 GB"
        var m = text.match(/Używasz\s+(\d+)\s*%\s+z\s+([\d,.]+\s*GB)/i);
        if (m) return { used: m[1] + '%', percent: parseInt(m[1]), total: m[2].trim() };
        // EN: "1.23 GB (10%) of 15 GB"
        var m2 = text.match(/([\d,.]+\s*(?:GB|MB|KB))\s*\((\d+)%\)\s+(?:of|z)\s+([\d,.]+\s*GB)/i);
        if (m2) return { used: m2[1].trim(), percent: parseInt(m2[2]), total: m2[3].trim() };
        // Generic: "X of Y GB used" / "X z Y GB"
        var m3 = text.match(/([\d,.]+\s*(?:GB|MB))\s+(?:of|z)\s+([\d,.]+\s*GB)\s+(?:used|wykorzystano)?/i);
        if (m3) return { used: m3[1].trim(), total: m3[2].trim() };
        return null;
      });
      if (storage) results.storage = storage;
    } catch(e) {}

    onProgress('Gotowe!');
    return results;

  } finally {
    await page.close().catch(function() {});
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
