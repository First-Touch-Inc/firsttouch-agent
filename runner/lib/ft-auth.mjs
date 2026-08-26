// FirstTouch MCP authentication.
//
// Two paths, in priority order:
//
//   1. FT_MCP_TOKEN — a static bearer. The simple path, and the one to use
//      once FirstTouch ships its API-key release. Set it and nothing else
//      here runs.
//   2. OAuth — dynamic client registration + authorization_code + PKCE +
//      refresh_token against gateway.firsttouch.ai. One human click during
//      setup, then this holds a self-refreshing token forever.
//
// Ported from the FirstTouch approval hub, which has run this in production
// since 2026. Deliberately the same flow: proven beats novel for auth.
//
// The token file lives on the writable volume (FT_OAUTH_FILE, default
// <STATE_DIR>/ft-oauth.json), mode 0600, and is deny-listed from the model's
// Read/Glob like every other credential — the tool server reads it, the model
// never sees it. FT_OAUTH_SEED (base64 of the file) hydrates a fresh volume on
// first cloud boot so a redeploy never forces re-consent.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveStateDir } from './config.mjs';

const GATEWAY = process.env.FT_OAUTH_GATEWAY || 'https://gateway.firsttouch.ai';
const RESOURCE = process.env.FT_MCP_URL || 'https://mcp.firsttouch.ai';
const SCOPE = 'mcp';

export function authFile() {
  return process.env.FT_OAUTH_FILE || join(resolveStateDir(), 'ft-oauth.json');
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function load() {
  const file = authFile();
  // A fresh volume can be hydrated from FT_OAUTH_SEED so a redeploy does not
  // force the operator through consent again.
  if (!existsSync(file) && process.env.FT_OAUTH_SEED) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(process.env.FT_OAUTH_SEED, 'base64'), { mode: 0o600 });
    } catch { /* fall through to empty */ }
  }
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

function save(data) {
  const file = authFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

let pending = null; // { verifier, state, redirectUri }

/** Register this deployment as an OAuth client (once per redirect_uri). */
async function ensureClient(redirectUri) {
  const auth = load();
  if (auth.client_id && auth.redirect_uri === redirectUri) return auth;
  const res = await fetch(`${GATEWAY}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'FirstTouch Agent',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
  });
  if (!res.ok) {
    throw new Error(`FirstTouch client registration failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const reg = await res.json();
  const next = { ...auth, client_id: reg.client_id, redirect_uri: redirectUri };
  save(next);
  return next;
}

/** Step 1 of consent: the URL the operator opens in a browser. */
export async function startAuth(redirectUri) {
  const auth = await ensureClient(redirectUri);
  const verifier = b64u(randomBytes(48));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const state = b64u(randomBytes(16));
  pending = { verifier, state, redirectUri };
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: auth.client_id,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
  });
  return `${GATEWAY}/authorize?${p}`;
}

/** Step 2: exchange the code from the callback for tokens. */
export async function finishAuth({ code, state }) {
  if (!pending || state !== pending.state) {
    throw new Error('state mismatch — restart the authorization');
  }
  const auth = load();
  const res = await fetch(`${GATEWAY}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: auth.client_id,
      code_verifier: pending.verifier,
      resource: RESOURCE,
    }),
  });
  if (!res.ok) {
    throw new Error(`FirstTouch token exchange failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const tok = await res.json();
  save({
    ...auth,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || auth.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
  });
  pending = null;
  return true;
}

/** Report which auth path is live, for preflight and the host's boot log. */
export function authStatus() {
  if (process.env.FT_MCP_TOKEN) return { mode: 'static', ok: true };
  const auth = load();
  if (auth.refresh_token || (auth.access_token && Date.now() < (auth.expires_at || 0))) {
    return { mode: 'oauth', ok: true, expires_at: auth.expires_at ?? null };
  }
  return { mode: 'none', ok: false };
}

/**
 * A currently-valid bearer token, or null. Refreshes 60s before expiry so a
 * call never races the boundary. This is what the provider calls before every
 * request — the token is never cached anywhere the model can reach.
 */
export async function getAccessToken() {
  if (process.env.FT_MCP_TOKEN) return process.env.FT_MCP_TOKEN;
  const auth = load();
  if (!auth.access_token && !auth.refresh_token) return null;
  if (auth.access_token && Date.now() < (auth.expires_at || 0) - 60_000) return auth.access_token;
  if (!auth.refresh_token) return null;

  const res = await fetch(`${GATEWAY}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refresh_token,
      client_id: auth.client_id,
      resource: RESOURCE,
    }),
  });
  if (!res.ok) {
    // Do not throw: the caller surfaces this as "reconnect FirstTouch", which
    // is actionable, rather than crashing a run mid-sweep.
    return null;
  }
  const tok = await res.json();
  save({
    ...auth,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || auth.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
  });
  return tok.access_token;
}
