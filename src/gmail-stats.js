// Gmail stats — uses context.request (bypasses Service Worker) with intercepted tokens,
// falls back to SPA pagination for small result sets

var NAV_TIMEOUT = 30000;
var SEARCH_WAIT = 4000;

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
  var lines = [
    '\u{1F4CA} Statystyki maili — ' + label,
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

async function tryContextRequest(context, ik, at, query) {
  // Use Playwright context.request — makes HTTP from Node.js with browser cookies,
  // completely bypasses Service Worker
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
      // Log for debugging
      console.log('[gmail-stats] context.request got non-HTML but no te: ' + text.substring(0, 200));
      return null;
    }
    console.log('[gmail-stats] context.request returned HTML (' + response.status() + '): ' + text.substring(0, 100));
    return null;
  } catch(e) {
    console.log('[gmail-stats] context.request error: ' + e.message);
    return null;
  }
}

async function searchCountSPA(page, query, label) {
  try {
    await page.evaluate(function(h) { window.location.hash = h; }, '#search/' + encodeURIComponent(query));
    await new Promise(function(r) { setTimeout(r, SEARCH_WAIT); });
    var parsed = await page.evaluate(function() {
      var text = document.body.innerText || '';
      var norm = text.replace(/[   ​]/g, ' ').replace(/[–—]/g, '-');
      if (/nie pasuj|brak wynik|brak rozm/i.test(norm)) return { count: 0, src: 'no-results' };
      var m = norm.match(/(\d+)\s*-\s*(\d+)\s+z\s+([\d ]+\d)/);
      if (m) {
        var t = parseInt(m[3].replace(/\s/g, ''));
        if (!isNaN(t) && t >= 1) return { count: t, src: 'pagination' };
      }
      if (/z wielu/i.test(norm)) return { count: null, src: 'z-wielu' };
      return { count: null, src: 'no-match' };
    });
    console.log('[gmail-stats] ' + label + ': ' + parsed.count + ' (SPA ' + parsed.src + ')');
    return parsed.count;
  } catch(e) {
    console.log('[gmail-stats] ' + label + ': SPA error ' + e.message);
    return null;
  }
}

export async function collectGmailStats(context, onProgress) {
  if (!onProgress) onProgress = function() {};
  var page = await context.newPage();

  try {
    // Capture tokens from Gmail's own requests
    var ik = null;
    var at = null;
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

    // Test context.request approach (bypasses Service Worker)
    var useContextReq = false;
    if (ik && at) {
      var testCount = await tryContextRequest(context, ik, at, 'in:sent');
      if (testCount !== null) {
        useContextReq = true;
        console.log('[gmail-stats] context.request API works! Test in:sent = ' + testCount);
      }
    }

    var results = {};

    for (var i = 0; i < SEARCHES.length; i++) {
      var s = SEARCHES[i];
      onProgress('Zliczam: ' + s.label + '...');

      // Try context.request API first
      if (useContextReq) {
        var apiCount = await tryContextRequest(context, ik, at, s.query);
        if (apiCount !== null) {
          results[s.key] = apiCount;
          console.log('[gmail-stats] ' + s.label + ': ' + apiCount + ' (API)');
          continue;
        }
      }

      // Fallback: SPA navigation
      results[s.key] = await searchCountSPA(page, s.query, s.label);
    }

    // Contacts
    onProgress('Ładowanie kontaktów...');
    try {
      await page.goto('https://contacts.google.com/', {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT,
      });
      var deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        var cnt = await page.evaluate(function() {
          var m = document.body.innerText.match(/(\d[\d\s,]*)\s+(?:kontakt|contact)/i);
          return m ? parseInt(m[1].replace(/\D/g, '')) : null;
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
        var m = text.match(/Używasz\s+(\d+)\s*%\s+z\s+([\d,.]+\s*GB)/i);
        if (m) return { used: m[1] + '%', percent: parseInt(m[1]), total: m[2].trim() };
        var m2 = text.match(/([\d,.]+\s*(?:GB|MB|KB))\s*\((\d+)%\)\s+(?:of|z)\s+([\d,.]+\s*GB)/i);
        if (m2) return { used: m2[1].trim(), percent: parseInt(m2[2]), total: m2[3].trim() };
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
