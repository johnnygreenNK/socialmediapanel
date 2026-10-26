// Playwright request filter — blocks heavyweight tracking / analytics requests
// and feed media to speed up login flows, especially over mobile proxies.
//
// Rules:
//   · Login/2FA/checkpoint URLs always pass through unconditionally (SAFE ZONE).
//   · Video streams are aborted everywhere.
//   · Facebook/Instagram feed images (fbcdn/cdninstagram) are aborted after login.
//   · Known tracking and analytics endpoints are always blocked.
//
// Pass this function to context.route('**/*', routeFilter).

const BLOCKED_PATTERNS = [
  // Facebook / Meta tracking (NOT graphqlbatch — login/2FA uses it)
  /facebook\.com\/tr(\/|\?|$)/,
  /facebook\.com\/plugins\//,
  /facebook\.com\/.*\/qpl\//,
  /facebook\.com\/.*\/ls_report/,
  /facebook\.com\/.*\/ajax\/bz/,
  /connect\.facebook\.net/,
  /falco\.facebook/,
  // Instagram (NOT graphql/batch)
  /instagram\.com\/.*\/logging/,
  // Google telemetry (NOT Gmail itself)
  /google-analytics\.com/,
  /googletagmanager\.com/,
  /doubleclick\.net/,
  /googlesyndication\.com/,
  /googleadservices\.com/,
  // Twitter / X
  /\/i\/jot\//,
  /api\.twitter\.com\/1\.1\/jot/,
  // Third-party trackers
  /segment\.(io|com)/,
  /mixpanel\.com/,
  /amplitude\.com/,
  /hotjar\.com/,
  /sentry\.io/,
  /fullstory\.com/,
  /scorecardresearch\.com/,
  /chartbeat\.(com|net)/,
  /optimizely\.com/,
  /newrelic\.com/,
  /datadoghq\.com/,
];

export function routeFilter(route) {
  const req  = route.request();
  const url  = req.url();
  const type = req.resourceType();

  // SAFE ZONE: all login/2FA/checkpoint paths — let through unconditionally.
  if (/\/(login|checkpoint|two_factor|two[-_ ]step|security|approvals|code|verif|identif|recover|totp|otp)\b/i.test(url)) {
    return route.continue();
  }

  // Video streams (Facebook feed, Instagram Reels).
  if (type === 'media' && /videoplayback|\.mp4(?:$|\?)|\.webm(?:$|\?)|\.m3u8(?:$|\?)/.test(url)) {
    return route.abort();
  }

  // Facebook / Instagram feed images — only block outside the login safe zone
  // (already handled above) so login profile pics still load.
  if (type === 'image' && /scontent[^.]*\.fbcdn\.net|scontent\.cdninstagram/.test(url)) {
    return route.abort();
  }

  if (BLOCKED_PATTERNS.some((rx) => rx.test(url))) {
    return route.abort();
  }

  return route.continue();
}
