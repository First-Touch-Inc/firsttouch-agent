#!/usr/bin/env node
// One-time FirstTouch authorization.
//
//   npm run ft-auth
//
// Opens a consent page in your browser, catches the callback on a temporary
// local port, and writes the self-refreshing token to the state volume. After
// this the agent refreshes on its own — you never do this again unless you
// revoke access.
//
// FOR A CONTAINER: run this locally, then either mount the resulting file at
// FT_OAUTH_FILE, or base64 it into FT_OAUTH_SEED as an env var (the agent
// hydrates a fresh volume from the seed on first boot):
//
//   node -e "console.log(require('fs').readFileSync(process.argv[1]).toString('base64'))" state/ft-oauth.json
//
// If FT_MCP_TOKEN is set you do not need this at all.

import './lib/env.mjs'; // MUST be first: populates process.env from .env
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startAuth, finishAuth, authStatus, authFile } from './lib/ft-auth.mjs';

const PORT = Number(process.env.FT_OAUTH_PORT || 8765);

if (process.env.FT_MCP_TOKEN) {
  console.log('FT_MCP_TOKEN is set — the agent will use that static token. Nothing to do here.');
  process.exit(0);
}

const before = authStatus();
if (before.ok && !process.argv.includes('--force')) {
  console.log(`FirstTouch is already authorized (${before.mode}). Token file: ${authFile()}`);
  console.log('Re-authorize anyway with:  npm run ft-auth -- --force');
  process.exit(0);
}

// Bind the callback listener BEFORE registering a client or opening a browser.
// Doing it the other way round meant a busy port crashed with a raw
// EADDRINUSE stack trace *after* having already opened the consent page.
// Walks a small range so a leftover listener from an abandoned run does not
// wedge every future attempt.
let server;
let PORT_IN_USE = PORT;
for (let attempt = 0; attempt < 10; attempt++) {
  const candidate = PORT + attempt;
  try {
    server = await new Promise((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(candidate, '127.0.0.1', () => resolve(s));
    });
    PORT_IN_USE = candidate;
    break;
  } catch (e) {
    if (e.code !== 'EADDRINUSE') {
      console.error(`\nCould not open a local callback port: ${e.message}\n`);
      process.exit(1);
    }
    // else: try the next port
  }
}
if (!server) {
  console.error(
    `\nPorts ${PORT}-${PORT + 9} are all busy on 127.0.0.1. Close whatever is using them, ` +
    `or pick another with FT_OAUTH_PORT=9000 npm run ft-auth\n`,
  );
  process.exit(1);
}

const redirectUri = `http://127.0.0.1:${PORT_IN_USE}/oauth/callback`;
let url;
try {
  url = await startAuth(redirectUri);
} catch (e) {
  server.close();
  console.error(`\nCould not start authorization: ${e.message}\n`);
  process.exit(1);
}

const TIMEOUT_MS = Number(process.env.FT_OAUTH_TIMEOUT_MS || 5 * 60 * 1000);
const done = new Promise((resolve) => {
  // Never hang forever waiting for a consent nobody is going to give.
  const timer = setTimeout(() => {
    console.error(`\n⏱  No response within ${Math.round(TIMEOUT_MS / 60000)} minutes — giving up.`);
    console.error('   Run `npm run ft-auth` again when you are ready to click Allow.\n');
    try { server.close(); } catch {}
    resolve(false);
  }, TIMEOUT_MS);
  timer.unref?.();

  server.on('request', async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT_IN_USE}`);
    // A short, un-mistypeable local link that redirects to the real (long)
    // consent URL — so nobody ever has to copy 340 characters out of a
    // wrapped terminal, which is what produced "missing client_id".
    if (u.pathname === '/' || u.pathname === '/start') {
      res.writeHead(302, { location: url }).end();
      return;
    }
    if (!u.pathname.startsWith('/oauth/callback')) {
      res.writeHead(404).end('not here');
      return;
    }
    const err = u.searchParams.get('error');
    if (err) {
      res.writeHead(400, { 'content-type': 'text/html' })
        .end(`<h2>Authorization declined</h2><pre>${err}: ${u.searchParams.get('error_description') ?? ''}</pre>`);
      clearTimeout(timer); server.close(); resolve(false);
      return;
    }
    try {
      await finishAuth({ code: u.searchParams.get('code'), state: u.searchParams.get('state') });
      res.writeHead(200, { 'content-type': 'text/html' })
        .end('<h2>FirstTouch connected.</h2><p>You can close this tab and go back to your terminal.</p>');
      clearTimeout(timer); server.close(); resolve(true);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'text/html' })
        .end(`<h2>Authorization failed</h2><pre>${e.message}</pre>`);
      clearTimeout(timer); server.close(); resolve(false);
    }
  });
});

// A clickable file as a second fallback, for when the browser does not launch
// and the terminal will not make the localhost line clickable either.
const linkFile = join(process.cwd(), 'authorize-firsttouch.html');
try {
  writeFileSync(linkFile,
    `<!doctype html><meta charset="utf-8"><title>Authorize FirstTouch</title>` +
    `<meta http-equiv="refresh" content="0;url=${url.replace(/&/g, '&amp;')}">` +
    `<p>Redirecting to FirstTouch… <a href="${url.replace(/&/g, '&amp;')}">click here if nothing happens</a>.</p>`);
} catch { /* the redirect link below still works */ }

console.log('\nOpening FirstTouch to authorize this agent…\n');
console.log(`  If the browser did not open, click this short link instead:`);
console.log(`      http://127.0.0.1:${PORT_IN_USE}/start\n`);
console.log(`  (or open the file: ${linkFile})\n`);
console.log('  Waiting for you to click Allow…\n');

// Best-effort browser open; the short local link above is the fallback.
const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
  : process.platform === 'darwin' ? ['open', [url]]
  : ['xdg-open', [url]];
try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* link printed above */ }

const ok = await done;
if (ok) {
  console.log(`\n✅ FirstTouch connected. Token saved to ${authFile()} (mode 0600).`);
  console.log('The agent refreshes this itself from now on.\n');
  process.exit(0);
}
console.error('\n❌ Authorization did not complete. Run `npm run ft-auth` again.\n');
process.exit(1);
