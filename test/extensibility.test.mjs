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

// --- external tools: any MCP server, tokens never near the model --------------

import { externalToolProviders } from '../runner/lib/providers.mjs';
import { validateConfig } from '../runner/lib/config.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { ROOT } from '../runner/lib/config.mjs';

function baseCfg() {
  const cfg = load(readFileSync(join(ROOT, 'config', 'agent.example.yaml'), 'utf8'));
  cfg.client.name = 'T';
  cfg.providers.crm.customer_signal = [{ property: 'x', equals: 'y' }];
  const outbound = cfg.motions.find((m) => m.kind === 'outbound');
  for (const s of outbound.sources) if (s.type === 'crm.list') s.list_id = 'l1';
  cfg.approval.digest_channel = 'C01234ABCDE';
  cfg.approval_routing.owners = [{
    id: 'p', name: 'Ada', provider_user_id: 'u1',
    slack_user_id: 'U01234ABCDE', slack_channel: 'C01234ABCDE', match: 'default',
  }];
  cfg.chat.allowed_users = ['U01234ABCDE'];
  return cfg;
}

test('a literal token in token_env is refused — secrets do not belong in config', () => {
  const cfg = baseCfg();
  cfg.external_tools = [{ name: 'clay', url: 'https://mcp.clay.com',
    token_env: 'sk-live-abc123xyz', allow: ['search_people'] }];
  const p = validateConfig(cfg).join('\n');
  assert.match(p, /never the token itself/);
});

test('external tools use a READ-verb ALLOWLIST that fails closed', () => {
  // A denylist of mutating verbs fails open — place_order/charge_card slip
  // through. The allowlist refuses anything not starting with a read verb.
  const cfg = baseCfg();
  for (const name of [
    'send_message', 'create_contact', 'add_to_sequence', 'enrollLead', 'trigger_workflow',
    'place_order', 'charge_card', 'subscribe_profile_to_marketing', 'submit_form',
    'do_thing', 'foo', 'process_payment',           // ambiguous/unknown → refused
  ]) {
    cfg.external_tools = [{ name: 'x', url: 'https://mcp.x.com', token_env: 'X_TOKEN', allow: [name] }];
    assert.match(validateConfig(cfg).join('\n'), /READ tools only/, `${name} must be refused`);
  }
  // Read verbs (snake and camel) are fine.
  for (const reads of [['search_people', 'get_transcript'], ['listCalls', 'findContact'], ['enrich_company']]) {
    cfg.external_tools = [{ name: 'x', url: 'https://mcp.x.com', token_env: 'X_TOKEN', allow: reads }];
    assert.deepEqual(validateConfig(cfg), [], `${reads.join(',')} should be allowed`);
  }
  // allow_mutations is not an escape hatch.
  cfg.external_tools = [{ name: 'x', url: 'https://mcp.x.com', token_env: 'X_TOKEN',
    allow: ['send_message'], allow_mutations: true }];
  assert.match(validateConfig(cfg).join('\n'), /READ tools only/);
});

test('an empty allow list is refused — there is no wildcard', () => {
  const cfg = baseCfg();
  cfg.external_tools = [{ name: 'x', url: 'https://mcp.x.com', token_env: 'X_TOKEN', allow: [] }];
  assert.match(validateConfig(cfg).join('\n'), /allowlist IS the permission/);
});

test('allowed external tools appear namespaced; unlisted ones do not exist at all', () => {
  const cfg = baseCfg();
  cfg.external_tools = [{ name: 'clay', url: 'https://mcp.clay.com',
    token_env: 'CLAY_TOKEN', allow: ['search_people', 'enrich_person'] }];
  const core = new ToolCore({
    cfg, ledger: openLedger(':memory:'), mode: 'chat', motionId: null,
    providers: { external: { clay: { call: (tool, args) => ({ tool, args }) } } },
  });
  const tools = core.availableTools();
  assert.ok(tools.includes('ext_clay_search_people'));
  assert.ok(tools.includes('ext_clay_enrich_person'));
  assert.ok(!tools.includes('ext_clay_delete_everything'));
  assert.throws(() => core.call('ext_clay_delete_everything', {}),
    /external tools exist only if config allows them/);
  assert.deepEqual(core.call('ext_clay_search_people', { q: 'VPs' }),
    { tool: 'search_people', args: { q: 'VPs' } });
});

test('onboarding sessions get no external tools', () => {
  const cfg = baseCfg();
  cfg.external_tools = [{ name: 'clay', url: 'https://mcp.clay.com',
    token_env: 'CLAY_TOKEN', allow: ['search_people'] }];
  const core = new ToolCore({
    cfg, ledger: openLedger(':memory:'), mode: 'onboarding', motionId: null,
    providers: {},
  });
  assert.ok(!core.availableTools().some((t) => t.startsWith('ext_')));
});

test('the provider re-checks the allowlist and reports a missing token as a refusal', async () => {
  const cfg = { external_tools: [{ name: 'clay', url: 'https://mcp.clay.com',
    token_env: 'CLAY_TOKEN_TEST', allow: ['search_people'] }] };
  const servers = externalToolProviders(cfg, { env: {}, connectImpl: async () => { throw new Error('must not connect'); } });
  const denied = await servers.clay.call('delete_everything', {});
  assert.match(denied.refused, /not in the allow list/);
  const noToken = await servers.clay.call('search_people', {});
  assert.match(noToken.refused, /CLAY_TOKEN_TEST/);
});

test('the provider calls through with the token and parses the result', async () => {
  const cfg = { external_tools: [{ name: 'clay', url: 'https://mcp.clay.com',
    token_env: 'CLAY_TOKEN_TEST', allow: ['search_people'] }] };
  const seen = [];
  const servers = externalToolProviders(cfg, {
    env: { CLAY_TOKEN_TEST: 'tok_123' },
    connectImpl: async ({ url, token }) => {
      seen.push([url, token]);
      return { callTool: async (name, args) => ({ text: JSON.stringify({ name, args }), isError: false }) };
    },
  });
  const r = await servers.clay.call('search_people', { q: 'VPs in Nebraska' });
  assert.deepEqual(r, { name: 'search_people', args: { q: 'VPs in Nebraska' } });
  assert.deepEqual(seen, [['https://mcp.clay.com', 'tok_123']], 'lazy: one connection, with the env token');
});

// --- DRY_RUN blocks all mutations at the provider (B-05) ---------------------

import { firsttouchProvider } from '../runner/lib/providers.mjs';

test('DRY_RUN makes the FirstTouch provider refuse every mutation, reads still work', async () => {
  const fakeConnect = async () => ({
    callTool: async (name) => ({ text: JSON.stringify({ tool: name }), isError: false }),
  });
  const provider = await firsttouchProvider({ token: 'x', dryRun: true, connectImpl: fakeConnect });

  for (const [method, args] of [
    ['createAction', { subject: {}, steps: [], ownerProviderId: 'u1' }],
    ['completeTask', 't1'],
    ['cancelAction', ['t1']],
    ['enrolFlow', { flow_id: 'f', subject: {}, ownerProviderId: 'u1' }],
  ]) {
    await assert.rejects(() => provider[method](args), /DRY_RUN is on/, `${method} must refuse in a dry run`);
  }
  // A read is still allowed — a dry run researches and drafts.
  assert.deepEqual(await provider.listTeamMembers(), { tool: 'list_team_members' });

  // And with dryRun off, mutations are wired through.
  const live = await firsttouchProvider({ token: 'x', dryRun: false, connectImpl: fakeConnect });
  assert.equal(typeof live.completeTask, 'function');
  assert.deepEqual(await live.completeTask('t1'), { tool: 'complete_task' });
});

// --- FirstTouch provider sends the REAL argument shapes (verified vs live MCP)

test('createAction sends one add_dynamic_action per step, chained, with real fields', async () => {
  const calls = [];
  const fakeConnect = async () => ({
    callTool: async (name, args) => {
      calls.push([name, args]);
      return { text: JSON.stringify({ enrollmentId: 'enr_1', taskIds: [`t_${calls.length}`] }), isError: false };
    },
  });
  const p = await firsttouchProvider({ token: 'x', dryRun: false, connectImpl: fakeConnect });
  const r = await p.createAction({
    subject: { name: 'Jamie Rivers', email: 'jamie@acme.com', company_domain: 'acme.com' },
    steps: [
      { channel: 'email', copy: 'Hi Jamie', subject: 'Quick note' },
      { channel: 'linkedin', copy: 'Following up' },
    ],
    ownerProviderId: 'usr_ada',
  });
  assert.deepEqual(r.task_ids, ['t_1', 't_2']);
  assert.equal(r.enrollment_id, 'enr_1');

  const [name0, a0] = calls[0];
  assert.equal(name0, 'add_dynamic_action');
  assert.equal(a0.action.type, 'email');
  assert.equal(a0.action.isHumanApprovalRequired, true, 'must materialise a task, not auto-send');
  assert.equal(a0.action.assignedUserId, 'usr_ada', 'sender is explicit — the wrong-owner bug');
  assert.equal(a0.action.subjectType, 'new_thread');
  assert.equal(a0.action.subject, 'Quick note');
  assert.equal(a0.action.message, 'Hi Jamie');
  assert.equal(a0.contact.firstName, 'Jamie');
  assert.equal(a0.contact.lastName, 'Rivers', 'first+last are required by the real tool');
  assert.equal(a0.company.domain, 'acme.com');
  assert.equal(a0.enrollmentId, undefined, 'first step opens a new enrollment');

  const [, a1] = calls[1];
  assert.equal(a1.enrollmentId, 'enr_1', 'later steps chain onto the enrollment');
  assert.equal(a1.action.type, 'linkedin_message');
});

test('enrolFlow sends the nested manualEnrollment shape', async () => {
  const calls = [];
  const fakeConnect = async () => ({
    callTool: async (name, args) => { calls.push([name, args]); return { text: '{}', isError: false }; },
  });
  const p = await firsttouchProvider({ token: 'x', dryRun: false, connectImpl: fakeConnect });
  await p.enrolFlow({ flow_id: 'flow_1', subject: { name: 'Sam Lee', email: 'sam@x.com', company_domain: 'x.com' } });
  const [name, args] = calls[0];
  assert.equal(name, 'add_manual_flow_enrollment');
  assert.equal(args.flowPlanId, 'flow_1');
  assert.equal(args.manualEnrollment.prospect.firstName, 'Sam');
  assert.equal(args.manualEnrollment.prospect.lastName, 'Lee');
  assert.equal(args.manualEnrollment.prospect.email, 'sam@x.com');
  assert.equal(args.manualEnrollment.company.domain, 'x.com');
});

test('findAction filters by todo status and the owner', async () => {
  const calls = [];
  const fakeConnect = async () => ({
    callTool: async (name, args) => {
      calls.push([name, args]);
      return { text: JSON.stringify({ tasks: [{ taskId: 'task_9' }] }), isError: false };
    },
  });
  const p = await firsttouchProvider({ token: 'x', dryRun: false, connectImpl: fakeConnect });
  const r = await p.findAction({ subject: { email: 'a@b.com' }, ownerProviderId: 'usr_1' });
  assert.deepEqual(r.task_ids, ['task_9']);
  assert.deepEqual(calls[0][1].statuses, ['todo']);
  assert.equal(calls[0][1].assignedUserId, 'usr_1');
});
