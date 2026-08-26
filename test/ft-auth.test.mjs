// Tests for FirstTouch auth: the static-token path and the OAuth path that
// the agent refreshes itself. Ported from the hub's proven flow, so these pin
// the contract rather than re-deriving it.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { firsttouchProvider } from '../runner/lib/providers.mjs';

function withAuthFile(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ftauth-'));
  const file = join(dir, 'ft-oauth.json');
  writeFileSync(file, JSON.stringify(contents));
  const saved = process.env.FT_OAUTH_FILE;
  process.env.FT_OAUTH_FILE = file;
  try { return fn(file); } finally {
    if (saved === undefined) delete process.env.FT_OAUTH_FILE; else process.env.FT_OAUTH_FILE = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

const fakeConnect = (seen) => async ({ token }) => {
  seen.push(token);
  return { callTool: async (name) => ({ text: JSON.stringify({ tool: name }), isError: false }) };
};

test('a static token is used directly, with no OAuth involvement', async () => {
  const seen = [];
  const p = await firsttouchProvider({
    token: 'static-abc', dryRun: false, connectImpl: fakeConnect(seen),
    getToken: async () => { throw new Error('OAuth must not be consulted'); },
  });
  await p.listTeamMembers();
  assert.deepEqual(seen, ['static-abc']);
});

test('with no static token, the OAuth access token is used', async () => {
  const seen = [];
  const p = await firsttouchProvider({
    dryRun: false, connectImpl: fakeConnect(seen),
    getToken: async () => 'oauth-xyz',
  });
  await p.listTeamMembers();
  assert.deepEqual(seen, ['oauth-xyz']);
});

test('no credential at all fails with an actionable message', async () => {
  await assert.rejects(
    () => firsttouchProvider({ dryRun: false, connectImpl: fakeConnect([]), getToken: async () => null }),
    /npm run ft-auth|FT_MCP_TOKEN/,
  );
});

test('a 401 mid-run reconnects with a FRESHLY refreshed token', async () => {
  // First call rejects the token (expired); the retry must use the new one.
  const seen = [];
  let issued = 0;
  let failNext = true;
  const connectImpl = async ({ token }) => {
    seen.push(token);
    return {
      callTool: async (name) => {
        if (failNext) { failNext = false; throw new Error('The outreach platform rejected the token — 401'); }
        return { text: JSON.stringify({ tool: name }), isError: false };
      },
    };
  };
  const p = await firsttouchProvider({
    dryRun: false, connectImpl,
    getToken: async () => `token-${++issued}`,
  });
  const r = await p.listTeamMembers();
  assert.deepEqual(r, { tool: 'list_team_members' });
  assert.deepEqual(seen, ['token-1', 'token-2'], 'the retry reconnected with a refreshed token');
});

test('authStatus reports oauth from a stored refresh token, static from the env', async () => {
  const { authStatus } = await import('../runner/lib/ft-auth.mjs');
  const savedTok = process.env.FT_MCP_TOKEN;
  delete process.env.FT_MCP_TOKEN;
  try {
    withAuthFile({ client_id: 'c', refresh_token: 'r', expires_at: 0 }, () => {
      const s = authStatus();
      assert.equal(s.mode, 'oauth', 'a refresh token on disk means the OAuth path is live');
      assert.equal(s.ok, true);
    });
    // No token file and no env var → not connected.
    withAuthFile({}, () => {
      assert.equal(authStatus().ok, false);
    });
    // A static token always wins.
    process.env.FT_MCP_TOKEN = 'static-abc';
    assert.equal(authStatus().mode, 'static');
  } finally {
    if (savedTok === undefined) delete process.env.FT_MCP_TOKEN; else process.env.FT_MCP_TOKEN = savedTok;
  }
});
