// Gmail API via OAuth2 — reliable message counts using resultSizeEstimate.
//
// Flow: Playwright navigates the already-logged-in browser context through
// Google's OAuth consent, captures the auth code, exchanges it for tokens,
// and stores the refresh token per-account for future use.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
const REDIRECT_URI = 'http://localhost/oauth2callback';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function tokenDir() {
  return path.join(config.dataDir, 'gmail-tokens');
}

function tokenPath(accountId) {
  return path.join(tokenDir(), `${accountId}.json`);
}

async function loadToken(accountId) {
  try {
    const raw = await fsp.readFile(tokenPath(accountId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveToken(accountId, token) {
  await fsp.mkdir(tokenDir(), { recursive: true });
  await fsp.writeFile(tokenPath(accountId), JSON.stringify(token, null, 2));
}

async function exchangeCode(code) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.gmailClientId,
      client_secret: config.gmailClientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`token exchange failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function refreshAccessToken(accountId) {
  const token = await loadToken(accountId);
  if (!token?.refresh_token) return null;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: token.refresh_token,
      client_id: config.gmailClientId,
      client_secret: config.gmailClientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    console.log('[gmail-api] refresh failed (' + res.status + '): ' + await res.text());
    return null;
  }
  const data = await res.json();
  const updated = {
    ...token,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  await saveToken(accountId, updated);
  return updated.access_token;
}

export async function getAccessToken(accountId) {
  const token = await loadToken(accountId);
  if (!token) return null;
  if (token.expires_at && Date.now() < token.expires_at) return token.access_token;
  return refreshAccessToken(accountId);
}

export function isConfigured() {
  return Boolean(config.gmailClientId && config.gmailClientSecret);
}

export async function hasToken(accountId) {
  const token = await loadToken(accountId);
  return Boolean(token?.refresh_token);
}

export async function startOAuthFlow(context, accountId) {
  if (!isConfigured()) throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set');

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: config.gmailClientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });

  const page = await context.newPage();
  try {
    // Intercept the redirect to localhost so it doesn't actually try to connect
    let capturedCode = null;
    await page.route('**/oauth2callback**', async (route) => {
      const url = new URL(route.request().url());
      capturedCode = url.searchParams.get('code');
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<h2>OK — możesz zamknąć tę kartę.</h2>' });
    });

    await page.goto(authUrl, { waitUntil: 'load', timeout: 30000 });

    // Wait for either: redirect captured, or user needs to click allow
    // Try clicking the "Allow" / "Zezwól" / "Continue" buttons
    const deadline = Date.now() + 60000;
    while (!capturedCode && Date.now() < deadline) {
      // Try common consent buttons
      for (const selector of [
        'button:has-text("Allow")',
        'button:has-text("Zezwól")',
        'button:has-text("Continue")',
        'button:has-text("Kontynuuj")',
        '#submit_approve_access',
        'button[id="submit_approve_access"]',
        '[data-idom-class*="allow"]',
      ]) {
        try {
          const btn = page.locator(selector).first();
          if (await btn.isVisible({ timeout: 500 })) {
            await btn.click();
            await new Promise(r => setTimeout(r, 2000));
          }
        } catch { /* button not found, try next */ }
      }
      // Also handle account chooser — pick first account
      try {
        const accountDiv = page.locator('[data-email]').first();
        if (await accountDiv.isVisible({ timeout: 500 })) {
          await accountDiv.click();
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch { /* no account chooser */ }

      // Check if we ended up on the checkbox consent screen
      try {
        const checkbox = page.locator('input[type="checkbox"]').first();
        if (await checkbox.isVisible({ timeout: 300 })) {
          if (!(await checkbox.isChecked())) await checkbox.check();
        }
      } catch {}

      await new Promise(r => setTimeout(r, 1000));
    }

    if (!capturedCode) {
      // Last resort: check if the URL has a code
      const finalUrl = page.url();
      if (finalUrl.includes('code=')) {
        capturedCode = new URL(finalUrl).searchParams.get('code');
      }
    }

    if (!capturedCode) throw new Error('OAuth flow timed out — consent not granted');

    const tokenData = await exchangeCode(capturedCode);
    const token = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokenData.expires_in - 60) * 1000,
    };
    await saveToken(accountId, token);
    console.log('[gmail-api] OAuth tokens saved for ' + accountId);
    return token.access_token;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function gmailApiRequest(accessToken, endpoint) {
  const res = await fetch(`${GMAIL_API}${endpoint}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API error (${res.status}): ${body}`);
  }
  return res.json();
}

export async function getMessageCount(accessToken, query) {
  const data = await gmailApiRequest(
    accessToken,
    `/messages?q=${encodeURIComponent(query)}&maxResults=1&fields=resultSizeEstimate`
  );
  return data.resultSizeEstimate ?? null;
}

export async function getProfile(accessToken) {
  return gmailApiRequest(accessToken, '/profile');
}

export async function revokeToken(accountId) {
  try { await fsp.unlink(tokenPath(accountId)); } catch {}
}
