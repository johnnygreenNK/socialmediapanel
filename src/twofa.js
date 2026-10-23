// Reference: 2FA methods and whether they work inside a remote/streamed browser.
//
// The rule: anything where YOU enter a code or approve on YOUR phone works,
// because the remote browser only needs the typed code / the approval happens
// off-browser. Anything that needs a FIDO authenticator (passkey, hardware
// security key) attached to the machine running the browser does NOT work here
// — that machine is the server, not your device. (Same limitation remote-browser
// products like AWS WorkSpaces Secure Browser document for WebAuthn.)
//
// Google specifically is moving away from SMS toward passkeys / Google prompt /
// authenticator, so for a Google account prefer an app code or Google prompt and
// keep a backup method that isn't a passkey.

export const TWOFA_METHODS = [
  { id: 'sms',        label: 'Kod SMS / połączenie',        works: true,  note: 'Wpisujesz kod w zdalnej przeglądarce.' },
  { id: 'totp',       label: 'Aplikacja authenticator (TOTP)', works: true,  note: 'Wpisujesz 6-cyfrowy kod.' },
  { id: 'prompt',     label: 'Google prompt / push w aplikacji', works: true,  note: 'Zatwierdzasz na swoim telefonie, poza przeglądarką.' },
  { id: 'backup',     label: 'Kody zapasowe',               works: true,  note: 'Wpisujesz jeden z zapisanych kodów.' },
  { id: 'passkey',    label: 'Passkey',                     works: false, note: 'Wymaga uwierzytelniacza przy maszynie z przeglądarką (serwer), nie przy Tobie.' },
  { id: 'securitykey',label: 'Klucz bezpieczeństwa (FIDO/USB/NFC)', works: false, note: 'Jak wyżej — klucz musiałby być fizycznie przy serwerze.' },
];

export const TWOFA_ADVICE =
  'Dla kont z passkey/kluczem dodaj metodę zapasową opartą o kod (authenticator) ' +
  'lub powiadomienie na telefon, żeby móc zalogować się w zdalnej przeglądarce. ' +
  'Logujesz się tylko raz — potem trwały profil utrzymuje sesję.';
