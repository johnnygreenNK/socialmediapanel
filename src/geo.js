// IP-based locale detection.
//
// Geolocates the ADMIN's own IP — whoever opened the panel / clicked start
// — not the account session's own network path (VPS or proxy). The point
// is to show the page in the language that makes sense to the person
// actually watching it, not to make the session's exit IP "look natural"
// to Google (a separate, harder problem we aren't solving here).
//
// The lookup must never block or fail an account launch: on any error,
// timeout, private/local IP, or unmapped country it silently falls back to
// a default.

const COUNTRY_LOCALE = {
  PL: { locale: 'pl-PL', timezoneId: 'Europe/Warsaw' },
  US: { locale: 'en-US', timezoneId: 'America/New_York' },
  GB: { locale: 'en-GB', timezoneId: 'Europe/London' },
  IE: { locale: 'en-IE', timezoneId: 'Europe/Dublin' },
  DE: { locale: 'de-DE', timezoneId: 'Europe/Berlin' },
  AT: { locale: 'de-AT', timezoneId: 'Europe/Vienna' },
  CH: { locale: 'de-CH', timezoneId: 'Europe/Zurich' },
  FR: { locale: 'fr-FR', timezoneId: 'Europe/Paris' },
  BE: { locale: 'nl-BE', timezoneId: 'Europe/Brussels' },
  NL: { locale: 'nl-NL', timezoneId: 'Europe/Amsterdam' },
  ES: { locale: 'es-ES', timezoneId: 'Europe/Madrid' },
  PT: { locale: 'pt-PT', timezoneId: 'Europe/Lisbon' },
  IT: { locale: 'it-IT', timezoneId: 'Europe/Rome' },
  SE: { locale: 'sv-SE', timezoneId: 'Europe/Stockholm' },
  NO: { locale: 'nb-NO', timezoneId: 'Europe/Oslo' },
  DK: { locale: 'da-DK', timezoneId: 'Europe/Copenhagen' },
  FI: { locale: 'fi-FI', timezoneId: 'Europe/Helsinki' },
  CZ: { locale: 'cs-CZ', timezoneId: 'Europe/Prague' },
  SK: { locale: 'sk-SK', timezoneId: 'Europe/Bratislava' },
  HU: { locale: 'hu-HU', timezoneId: 'Europe/Budapest' },
  RO: { locale: 'ro-RO', timezoneId: 'Europe/Bucharest' },
  BG: { locale: 'bg-BG', timezoneId: 'Europe/Sofia' },
  GR: { locale: 'el-GR', timezoneId: 'Europe/Athens' },
  UA: { locale: 'uk-UA', timezoneId: 'Europe/Kyiv' },
  RU: { locale: 'ru-RU', timezoneId: 'Europe/Moscow' },
  TR: { locale: 'tr-TR', timezoneId: 'Europe/Istanbul' },
  CA: { locale: 'en-CA', timezoneId: 'America/Toronto' },
  MX: { locale: 'es-MX', timezoneId: 'America/Mexico_City' },
  BR: { locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' },
  IN: { locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  AU: { locale: 'en-AU', timezoneId: 'Australia/Sydney' },
  JP: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
  KR: { locale: 'ko-KR', timezoneId: 'Asia/Seoul' },
  CN: { locale: 'zh-CN', timezoneId: 'Asia/Shanghai' },
};
const DEFAULT_LOCALE = { locale: 'en-US', timezoneId: 'UTC' };

const LOOKUP_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 60 * 60 * 1000; // an admin's own IP rarely changes mid-session

const cache = new Map(); // ip -> { value, expiresAt }

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function isPrivateOrLocal(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  return (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith('127.') ||
    ip.startsWith('fc') || ip.startsWith('fd') // IPv6 unique local
  );
}

async function lookupCountryCode(ip) {
  try {
    const raw = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode`).then((r) => r.text());
    const data = JSON.parse(raw);
    return data.status === 'success' ? data.countryCode : null;
  } catch {
    return null;
  }
}

// Resolves { locale, timezoneId } for the given admin IP, caching per IP.
// Never throws and never hangs the caller for long.
export async function resolveLocaleForIp(ip) {
  if (isPrivateOrLocal(ip)) return DEFAULT_LOCALE;

  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const countryCode = await withTimeout(lookupCountryCode(ip), LOOKUP_TIMEOUT_MS);
  const value = (countryCode && COUNTRY_LOCALE[countryCode]) || DEFAULT_LOCALE;
  cache.set(ip, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}
