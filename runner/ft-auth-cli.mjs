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

import { createServer } from 'node:http';
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

const redirectUri = `http://127.0.0.1:${PORT}/oauth/callback`;
let url;
try {
  url = await startAuth(redirectUri);
} catch (e) {
  console.error(`\nCould not start authorization: ${e.message}\n`);
  process.exit(1);
}

const done = new Promise((resolve) => {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (!u.pathname.startsWith('/oauth/callback')) {
      res.writeHead(404).end('not here');
      return;
    }
    try {
      await finishAuth({ code: u.searchParams.get('code'), state: u.searchParams.get('state') });
      res.writeHead(200, { 'content-type': 'text/html' })
        .end('<h2>FirstTouch connected.</h2><p>You can close this tab and go back to your terminal.</p>');
      server.close();
      resolve(true);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'text/html' })
        .end(`<h2>Authorization failed</h2><pre>${e.message}</pre>`);
      server.close();
      resolve(false);
    }
  });
  server.listen(PORT, '127.0.0.1');
});

console.log('\nOpening FirstTouch to authorize this agent…');
console.log(`If the browser does not open, paste this URL:\n\n${url}\n`);

// Best-effort browser open; the printed URL is the fallback.
const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
  : process.platform === 'darwin' ? ['open', [url]]
  : ['xdg-open', [url]];
try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* printed above */ }

const ok = await done;
if (ok) {
  console.log(`\n✅ FirstTouch connected. Token saved to ${authFile()} (mode 0600).`);
  console.log('The agent refreshes this itself from now on.\n');
  process.exit(0);
}
console.error('\n❌ Authorization did not complete. Run `npm run ft-auth` again.\n');
process.exit(1);
