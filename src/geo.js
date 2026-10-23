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

// Near-full ISO-3166 country coverage (primary official/majority language +
// a representative IANA timezone, usually the capital's) — a missing entry
// here means the page silently falls back to English, which is exactly the
// bug this list exists to avoid (first seen: North Macedonia wasn't in an
// earlier, much shorter version of this map).
const COUNTRY_LOCALE = {
  // Europe
  PL: { locale: 'pl-PL', timezoneId: 'Europe/Warsaw' },
  GB: { locale: 'en-GB', timezoneId: 'Europe/London' },
  IE: { locale: 'en-IE', timezoneId: 'Europe/Dublin' },
  DE: { locale: 'de-DE', timezoneId: 'Europe/Berlin' },
  AT: { locale: 'de-AT', timezoneId: 'Europe/Vienna' },
  CH: { locale: 'de-CH', timezoneId: 'Europe/Zurich' },
  FR: { locale: 'fr-FR', timezoneId: 'Europe/Paris' },
  BE: { locale: 'nl-BE', timezoneId: 'Europe/Brussels' },
  NL: { locale: 'nl-NL', timezoneId: 'Europe/Amsterdam' },
  LU: { locale: 'fr-LU', timezoneId: 'Europe/Luxembourg' },
  ES: { locale: 'es-ES', timezoneId: 'Europe/Madrid' },
  PT: { locale: 'pt-PT', timezoneId: 'Europe/Lisbon' },
  IT: { locale: 'it-IT', timezoneId: 'Europe/Rome' },
  SM: { locale: 'it-SM', timezoneId: 'Europe/Rome' },
  VA: { locale: 'it-VA', timezoneId: 'Europe/Rome' },
  MT: { locale: 'mt-MT', timezoneId: 'Europe/Malta' },
  SE: { locale: 'sv-SE', timezoneId: 'Europe/Stockholm' },
  NO: { locale: 'nb-NO', timezoneId: 'Europe/Oslo' },
  DK: { locale: 'da-DK', timezoneId: 'Europe/Copenhagen' },
  IS: { locale: 'is-IS', timezoneId: 'Atlantic/Reykjavik' },
  FI: { locale: 'fi-FI', timezoneId: 'Europe/Helsinki' },
  EE: { locale: 'et-EE', timezoneId: 'Europe/Tallinn' },
  LV: { locale: 'lv-LV', timezoneId: 'Europe/Riga' },
  LT: { locale: 'lt-LT', timezoneId: 'Europe/Vilnius' },
  CZ: { locale: 'cs-CZ', timezoneId: 'Europe/Prague' },
  SK: { locale: 'sk-SK', timezoneId: 'Europe/Bratislava' },
  HU: { locale: 'hu-HU', timezoneId: 'Europe/Budapest' },
  RO: { locale: 'ro-RO', timezoneId: 'Europe/Bucharest' },
  MD: { locale: 'ro-MD', timezoneId: 'Europe/Chisinau' },
  BG: { locale: 'bg-BG', timezoneId: 'Europe/Sofia' },
  GR: { locale: 'el-GR', timezoneId: 'Europe/Athens' },
  CY: { locale: 'el-CY', timezoneId: 'Asia/Nicosia' },
  AL: { locale: 'sq-AL', timezoneId: 'Europe/Tirane' },
  MK: { locale: 'mk-MK', timezoneId: 'Europe/Skopje' },
  RS: { locale: 'sr-RS', timezoneId: 'Europe/Belgrade' },
  ME: { locale: 'sr-ME', timezoneId: 'Europe/Podgorica' },
  BA: { locale: 'bs-BA', timezoneId: 'Europe/Sarajevo' },
  HR: { locale: 'hr-HR', timezoneId: 'Europe/Zagreb' },
  SI: { locale: 'sl-SI', timezoneId: 'Europe/Ljubljana' },
  XK: { locale: 'sq-XK', timezoneId: 'Europe/Belgrade' },
  UA: { locale: 'uk-UA', timezoneId: 'Europe/Kyiv' },
  BY: { locale: 'be-BY', timezoneId: 'Europe/Minsk' },
  RU: { locale: 'ru-RU', timezoneId: 'Europe/Moscow' },
  TR: { locale: 'tr-TR', timezoneId: 'Europe/Istanbul' },
  GE: { locale: 'ka-GE', timezoneId: 'Asia/Tbilisi' },
  AM: { locale: 'hy-AM', timezoneId: 'Asia/Yerevan' },
  AZ: { locale: 'az-AZ', timezoneId: 'Asia/Baku' },
  AD: { locale: 'ca-AD', timezoneId: 'Europe/Andorra' },
  MC: { locale: 'fr-MC', timezoneId: 'Europe/Monaco' },
  LI: { locale: 'de-LI', timezoneId: 'Europe/Vaduz' },

  // North America
  US: { locale: 'en-US', timezoneId: 'America/New_York' },
  CA: { locale: 'en-CA', timezoneId: 'America/Toronto' },
  MX: { locale: 'es-MX', timezoneId: 'America/Mexico_City' },
  GT: { locale: 'es-GT', timezoneId: 'America/Guatemala' },
  BZ: { locale: 'en-BZ', timezoneId: 'America/Belize' },
  SV: { locale: 'es-SV', timezoneId: 'America/El_Salvador' },
  HN: { locale: 'es-HN', timezoneId: 'America/Tegucigalpa' },
  NI: { locale: 'es-NI', timezoneId: 'America/Managua' },
  CR: { locale: 'es-CR', timezoneId: 'America/Costa_Rica' },
  PA: { locale: 'es-PA', timezoneId: 'America/Panama' },
  CU: { locale: 'es-CU', timezoneId: 'America/Havana' },
  DO: { locale: 'es-DO', timezoneId: 'America/Santo_Domingo' },
  HT: { locale: 'fr-HT', timezoneId: 'America/Port-au-Prince' },
  JM: { locale: 'en-JM', timezoneId: 'America/Jamaica' },
  TT: { locale: 'en-TT', timezoneId: 'America/Port_of_Spain' },
  BS: { locale: 'en-BS', timezoneId: 'America/Nassau' },
  BB: { locale: 'en-BB', timezoneId: 'America/Barbados' },

  // South America
  BR: { locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' },
  AR: { locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires' },
  CL: { locale: 'es-CL', timezoneId: 'America/Santiago' },
  CO: { locale: 'es-CO', timezoneId: 'America/Bogota' },
  PE: { locale: 'es-PE', timezoneId: 'America/Lima' },
  VE: { locale: 'es-VE', timezoneId: 'America/Caracas' },
  EC: { locale: 'es-EC', timezoneId: 'America/Guayaquil' },
  BO: { locale: 'es-BO', timezoneId: 'America/La_Paz' },
  PY: { locale: 'es-PY', timezoneId: 'America/Asuncion' },
  UY: { locale: 'es-UY', timezoneId: 'America/Montevideo' },
  GY: { locale: 'en-GY', timezoneId: 'America/Guyana' },
  SR: { locale: 'nl-SR', timezoneId: 'America/Paramaribo' },

  // Middle East
  IL: { locale: 'he-IL', timezoneId: 'Asia/Jerusalem' },
  SA: { locale: 'ar-SA', timezoneId: 'Asia/Riyadh' },
  AE: { locale: 'ar-AE', timezoneId: 'Asia/Dubai' },
  QA: { locale: 'ar-QA', timezoneId: 'Asia/Qatar' },
  KW: { locale: 'ar-KW', timezoneId: 'Asia/Kuwait' },
  BH: { locale: 'ar-BH', timezoneId: 'Asia/Bahrain' },
  OM: { locale: 'ar-OM', timezoneId: 'Asia/Muscat' },
  JO: { locale: 'ar-JO', timezoneId: 'Asia/Amman' },
  LB: { locale: 'ar-LB', timezoneId: 'Asia/Beirut' },
  IQ: { locale: 'ar-IQ', timezoneId: 'Asia/Baghdad' },
  SY: { locale: 'ar-SY', timezoneId: 'Asia/Damascus' },
  YE: { locale: 'ar-YE', timezoneId: 'Asia/Aden' },
  IR: { locale: 'fa-IR', timezoneId: 'Asia/Tehran' },

  // Asia
  IN: { locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  PK: { locale: 'ur-PK', timezoneId: 'Asia/Karachi' },
  BD: { locale: 'bn-BD', timezoneId: 'Asia/Dhaka' },
  LK: { locale: 'si-LK', timezoneId: 'Asia/Colombo' },
  NP: { locale: 'ne-NP', timezoneId: 'Asia/Kathmandu' },
  AF: { locale: 'fa-AF', timezoneId: 'Asia/Kabul' },
  KZ: { locale: 'kk-KZ', timezoneId: 'Asia/Almaty' },
  UZ: { locale: 'uz-UZ', timezoneId: 'Asia/Tashkent' },
  TM: { locale: 'tk-TM', timezoneId: 'Asia/Ashgabat' },
  TJ: { locale: 'tg-TJ', timezoneId: 'Asia/Dushanbe' },
  KG: { locale: 'ky-KG', timezoneId: 'Asia/Bishkek' },
  MN: { locale: 'mn-MN', timezoneId: 'Asia/Ulaanbaatar' },
  CN: { locale: 'zh-CN', timezoneId: 'Asia/Shanghai' },
  HK: { locale: 'zh-HK', timezoneId: 'Asia/Hong_Kong' },
  TW: { locale: 'zh-TW', timezoneId: 'Asia/Taipei' },
  MO: { locale: 'zh-MO', timezoneId: 'Asia/Macau' },
  JP: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
  KR: { locale: 'ko-KR', timezoneId: 'Asia/Seoul' },
  KP: { locale: 'ko-KP', timezoneId: 'Asia/Pyongyang' },
  VN: { locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' },
  TH: { locale: 'th-TH', timezoneId: 'Asia/Bangkok' },
  KH: { locale: 'km-KH', timezoneId: 'Asia/Phnom_Penh' },
  LA: { locale: 'lo-LA', timezoneId: 'Asia/Vientiane' },
  MM: { locale: 'my-MM', timezoneId: 'Asia/Yangon' },
  MY: { locale: 'ms-MY', timezoneId: 'Asia/Kuala_Lumpur' },
  SG: { locale: 'en-SG', timezoneId: 'Asia/Singapore' },
  ID: { locale: 'id-ID', timezoneId: 'Asia/Jakarta' },
  PH: { locale: 'en-PH', timezoneId: 'Asia/Manila' },
  BN: { locale: 'ms-BN', timezoneId: 'Asia/Brunei' },
  TL: { locale: 'pt-TL', timezoneId: 'Asia/Dili' },
  BT: { locale: 'dz-BT', timezoneId: 'Asia/Thimphu' },
  MV: { locale: 'dv-MV', timezoneId: 'Indian/Maldives' },

  // Africa
  EG: { locale: 'ar-EG', timezoneId: 'Africa/Cairo' },
  LY: { locale: 'ar-LY', timezoneId: 'Africa/Tripoli' },
  TN: { locale: 'ar-TN', timezoneId: 'Africa/Tunis' },
  DZ: { locale: 'ar-DZ', timezoneId: 'Africa/Algiers' },
  MA: { locale: 'ar-MA', timezoneId: 'Africa/Casablanca' },
  SD: { locale: 'ar-SD', timezoneId: 'Africa/Khartoum' },
  ZA: { locale: 'en-ZA', timezoneId: 'Africa/Johannesburg' },
  NG: { locale: 'en-NG', timezoneId: 'Africa/Lagos' },
  KE: { locale: 'en-KE', timezoneId: 'Africa/Nairobi' },
  ET: { locale: 'am-ET', timezoneId: 'Africa/Addis_Ababa' },
  GH: { locale: 'en-GH', timezoneId: 'Africa/Accra' },
  TZ: { locale: 'sw-TZ', timezoneId: 'Africa/Dar_es_Salaam' },
  UG: { locale: 'en-UG', timezoneId: 'Africa/Kampala' },
  CM: { locale: 'fr-CM', timezoneId: 'Africa/Douala' },
  CI: { locale: 'fr-CI', timezoneId: 'Africa/Abidjan' },
  SN: { locale: 'fr-SN', timezoneId: 'Africa/Dakar' },
  ML: { locale: 'fr-ML', timezoneId: 'Africa/Bamako' },
  BF: { locale: 'fr-BF', timezoneId: 'Africa/Ouagadougou' },
  NE: { locale: 'fr-NE', timezoneId: 'Africa/Niamey' },
  TD: { locale: 'fr-TD', timezoneId: 'Africa/Ndjamena' },
  GN: { locale: 'fr-GN', timezoneId: 'Africa/Conakry' },
  RW: { locale: 'rw-RW', timezoneId: 'Africa/Kigali' },
  BI: { locale: 'fr-BI', timezoneId: 'Africa/Bujumbura' },
  SO: { locale: 'so-SO', timezoneId: 'Africa/Mogadishu' },
  ZM: { locale: 'en-ZM', timezoneId: 'Africa/Lusaka' },
  ZW: { locale: 'en-ZW', timezoneId: 'Africa/Harare' },
  MZ: { locale: 'pt-MZ', timezoneId: 'Africa/Maputo' },
  AO: { locale: 'pt-AO', timezoneId: 'Africa/Luanda' },
  CD: { locale: 'fr-CD', timezoneId: 'Africa/Kinshasa' },
  CG: { locale: 'fr-CG', timezoneId: 'Africa/Brazzaville' },
  GA: { locale: 'fr-GA', timezoneId: 'Africa/Libreville' },
  NA: { locale: 'en-NA', timezoneId: 'Africa/Windhoek' },
  BW: { locale: 'en-BW', timezoneId: 'Africa/Gaborone' },
  MW: { locale: 'en-MW', timezoneId: 'Africa/Blantyre' },
  MG: { locale: 'mg-MG', timezoneId: 'Indian/Antananarivo' },
  MU: { locale: 'en-MU', timezoneId: 'Indian/Mauritius' },
  LS: { locale: 'en-LS', timezoneId: 'Africa/Maseru' },
  SZ: { locale: 'en-SZ', timezoneId: 'Africa/Mbabane' },
  DJ: { locale: 'fr-DJ', timezoneId: 'Africa/Djibouti' },
  ER: { locale: 'ti-ER', timezoneId: 'Africa/Asmara' },
  SS: { locale: 'en-SS', timezoneId: 'Africa/Juba' },
  LR: { locale: 'en-LR', timezoneId: 'Africa/Monrovia' },
  SL: { locale: 'en-SL', timezoneId: 'Africa/Freetown' },
  TG: { locale: 'fr-TG', timezoneId: 'Africa/Lome' },
  BJ: { locale: 'fr-BJ', timezoneId: 'Africa/Porto-Novo' },
  GM: { locale: 'en-GM', timezoneId: 'Africa/Banjul' },
  GW: { locale: 'pt-GW', timezoneId: 'Africa/Bissau' },
  MR: { locale: 'ar-MR', timezoneId: 'Africa/Nouakchott' },
  CV: { locale: 'pt-CV', timezoneId: 'Atlantic/Cape_Verde' },
  KM: { locale: 'ar-KM', timezoneId: 'Indian/Comoro' },
  ST: { locale: 'pt-ST', timezoneId: 'Africa/Sao_Tome' },
  SC: { locale: 'en-SC', timezoneId: 'Indian/Mahe' },
  GQ: { locale: 'es-GQ', timezoneId: 'Africa/Malabo' },
  CF: { locale: 'fr-CF', timezoneId: 'Africa/Bangui' },

  // Oceania
  AU: { locale: 'en-AU', timezoneId: 'Australia/Sydney' },
  NZ: { locale: 'en-NZ', timezoneId: 'Pacific/Auckland' },
  FJ: { locale: 'en-FJ', timezoneId: 'Pacific/Fiji' },
  PG: { locale: 'en-PG', timezoneId: 'Pacific/Port_Moresby' },
  SB: { locale: 'en-SB', timezoneId: 'Pacific/Guadalcanal' },
  VU: { locale: 'fr-VU', timezoneId: 'Pacific/Efate' },
  WS: { locale: 'en-WS', timezoneId: 'Pacific/Apia' },
  TO: { locale: 'en-TO', timezoneId: 'Pacific/Tongatapu' },
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
