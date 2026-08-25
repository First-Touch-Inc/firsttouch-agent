// Tests for the extensibility surface: the dashboard reader, the dashboard
// tool, and private-adapter loading. This is what lets a deployment (ours
// included) customise fully while running the SAME engine it shares — so the
// rules here are what keep "customisable" from quietly meaning "forked" or
// "unsafe".
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../runner/lib/ledger.mjs';
import { ToolCore } from '../runner/lib/tools-core.mjs';
import { dashboardReader, validateAdaptersDir } from '../runner/lib/providers.mjs';

// --- the dashboard tool -------------------------------------------------------

function coreWithDash({ mode = 'motion', motionId = 'cs', dashProvider } = {}) {
  const cfg = {
    motions: [
      { id: 'cs', kind: 'cs_postclose', enabled: true, schedule: '0 10 * * 1-5', play: 'cs',
        owner_match: 'cs_account_owner',
        dashboard: { base_url: 'https://dash.example.com', identity: 'acme-cs-dash-v1' } },
      { id: 'outbound', kind: 'outbound', enabled: true, schedule: '0 8 * * 1-5', play: 'o',
        daily_cap: 3, sources: [{ type: 'social.engagers' }] },
    ],
    approval: { expiry_hours: 72 },
    approval_routing: { owners: [{ id: 'p', provider_user_id: 'u1', match: 'default' }] },
    limits: { per_day: 5, per_week: 20, per_contact_per_quarter: 2, per_company_per_quarter: 4, enrichment_credits_per_run: 5 },
    flows: [], chat: {},
  };
  const calls = [];
  const core = new ToolCore({
    cfg, ledger: openLedger(':memory:'), mode, motionId,
    providers: {
      dash: dashProvider ?? { read: (args) => { calls.push(args); return { ok: true }; } },
      ft: {}, crm: {},
      writeConfig() {}, writeWorkspaceFile() {},
    },
  });
  return { core, calls };
}

test('dashboard_read passes only the path — base URL and identity come from config', () => {
  const { core, calls } = coreWithDash();
  const r = core.call('dashboard_read', { path: '/api/at-risk' });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls[0], {
    baseUrl: 'https://dash.example.com', identity: 'acme-cs-dash-v1', path: '/api/at-risk',
  });
});

test('a full URL or traversal in the path is refused — injected text cannot repoint it', () => {
  const { core, calls } = coreWithDash();
  for (const path of ['https://evil.example.com/x', '/api/../secrets', 'api/relative']) {
    const r = core.call('dashboard_read', { path });
    assert.ok(r.refused, `"${path}" must be refused`);
  }
  assert.equal(calls.length, 0);
});

test('a motion without a dashboard gets a refusal, not a guess', () => {
  const { core } = coreWithDash({ motionId: 'outbound' });
  const r = core.call('dashboard_read', { path: '/api/x' });
  assert.match(r.refused, /no dashboard is configured/);
});

test('chat mode reads the enabled cs motion dashboard', () => {
  const { core, calls } = coreWithDash({ mode: 'chat', motionId: null });
  core.call('dashboard_read', { path: '/api/milestones' });
  assert.equal(calls[0].baseUrl, 'https://dash.example.com');
});

// --- the identity assertion ---------------------------------------------------

function fakeFetch(routes) {
  const seen = [];
  const impl = async (url) => {
    seen.push(String(url));
    const hit = routes[String(url)] ?? { status: 404, body: 'not found' };
    return {
      ok: (hit.status ?? 200) < 400,
      status: hit.status ?? 200,
      text: async () => hit.body ?? '',
    };
  };
  return { impl, seen };
}

test('a live host WITHOUT the identity string is refused — liveness is not identity', async () => {
  const { impl } = fakeFetch({
    'https://dash.example.com': { body: '{"ok":true,"service":"something-else"}' },
  });
  const dash = dashboardReader({ fetchImpl: impl });
  const r = await dash.read({ baseUrl: 'https://dash.example.com', identity: 'acme-cs-dash-v1', path: '/api/x' });
  assert.match(r.refused, /identity/);
  assert.match(r.refused, /merely ANSWERS/);
});

test('the identity is asserted once, then reads flow; a failure forces re-verification', async () => {
  const routes = {
    'https://dash.example.com': { body: 'service: acme-cs-dash-v1' },
    'https://dash.example.com/api/a': { body: '{"accounts":[1]}' },
    'https://dash.example.com/api/b': { body: '{"accounts":[2]}' },
  };
  const { impl, seen } = fakeFetch(routes);
  const dash = dashboardReader({ fetchImpl: impl });
  const a = await dash.read({ baseUrl: 'https://dash.example.com', identity: 'acme-cs-dash-v1', path: '/api/a' });
  const b = await dash.read({ baseUrl: 'https://dash.example.com', identity: 'acme-cs-dash-v1', path: '/api/b' });
  assert.deepEqual(a, { accounts: [1] });
  assert.deepEqual(b, { accounts: [2] });
  const identityChecks = seen.filter((u) => u === 'https://dash.example.com').length;
  assert.equal(identityChecks, 1, 'identity verified once per healthy base, not per read');
});

test('a missing identity string in config refuses rather than trusting liveness', async () => {
  const { impl } = fakeFetch({ 'https://dash.example.com': { body: 'anything' } });
  const dash = dashboardReader({ fetchImpl: impl });
  const r = await dash.read({ baseUrl: 'https://dash.example.com', identity: '', path: '/api/x' });
  assert.match(r.refused, /refusing to trust liveness/);
});

// --- private adapter loading: image-only, never the volume --------------------

test('an adapters dir on the writable volume is refused with the reason', () => {
  const opts = { configDir: '/data/config', stateDir: '/data/state' };
  for (const dir of ['/data/config/adapters', '/data/state/evil', '/data/config']) {
    const r = validateAdaptersDir(dir, opts);
    assert.equal(r.ok, false, `${dir} must be refused`);
    assert.match(r.reason, /writable volume/);
    assert.match(r.reason, /the agent could have authored/);
  }
});

test('an adapters dir baked into the image is accepted', () => {
  const opts = { configDir: '/data/config', stateDir: '/data/state' };
  assert.equal(validateAdaptersDir('/app/private-adapters', opts).ok, true);
});

test('windows-style paths are normalised before the volume check', () => {
  const r = validateAdaptersDir('C:\\data\\config\\adapters', {
    configDir: 'C:\\data\\config', stateDir: 'C:\\data\\state',
  });
  assert.equal(r.ok, false);
});

test('a prefix that merely LOOKS like the volume path is not refused', () => {
  // /data/config-extra is a sibling, not inside /data/config — the check must
  // compare path segments, not raw string prefixes.
  const r = validateAdaptersDir('/data/config-extra', {
    configDir: '/data/config', stateDir: '/data/state',
  });
  assert.equal(r.ok, true);
});
