// Tests for the trusted tool surface.
//
// This is the security boundary: the model's ONLY door to the outside world.
// Each section pins either an enforcement rule (suppression, caps, owner,
// allowlists) or an attack path that must stay closed (mode escape, free-string
// dispatch, path traversal, protected config, campaign from a motion session).
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../runner/lib/ledger.mjs';
import { ToolCore, ToolError, ENRICHMENT_KINDS } from '../runner/lib/tools-core.mjs';

const NOW = new Date('2030-06-01T12:00:00Z');

function fixtureConfig(overrides = {}) {
  return {
    client: { name: 'Northwind', timezone: 'America/New_York' },
    icp: 'B2B SaaS sales leaders',
    run_mode: 'supervised',
    providers: {
      outreach: { kind: 'firsttouch' },
      crm: { kind: 'hubspot', customer_signal: [{ property: 'active_seats', equals: 'yes' }] },
    },
    motions: [
      { id: 'outbound', kind: 'outbound', enabled: true, schedule: '0 8 * * 1-5',
        play: 'outbound-daily', daily_cap: 3, allow_open_deals: false,
        sources: [{ type: 'social.engagers' }] },
      { id: 'deal-followup', kind: 'deal_followup', enabled: true, schedule: '0 11 * * 1-5',
        play: 'deal-desk', pipeline_id: 'p1', stall_days: 10,
        crm_fields_may_change: ['dealstage', 'closedate'] },
    ],
    approval: { digest_channel: 'C0DIGEST00', undo_seconds: 45, expiry_hours: 72 },
    approval_routing: {
      owners: [
        { id: 'primary', name: 'Ada', provider_user_id: 'usr_ada',
          slack_user_id: 'U0ADA0000', slack_channel: 'C0ADA0000', match: 'default' },
        { id: 'emily', name: 'Emily', provider_user_id: 'usr_emily',
          slack_user_id: 'U0EMILY00', slack_channel: 'C0EMILY00', match: 'cs_account_owner' },
      ],
      approval_overrides: [],
    },
    limits: {
      per_day: 10, per_week: 50, per_contact_per_quarter: 2,
      per_company_per_quarter: 4, enrichment_credits_per_run: 2,
    },
    dedupe: { rework_cooldown_days: 90 },
    suppression: ['crm_customer_signal'],
    excluded_domains: [],
    flows: [{ id: 'flow_1', name: 'Welcome sequence' }],
    chat: { enabled: true, allowed_users: ['U0ADA0000'], campaigns_enabled: true },
    slack: { operator: 'U0ADA0000' },
    state: { ledger: 'state/ledger.db' },
    ...overrides,
  };
}

function makeCore({ mode = 'motion', motionId = 'outbound', cfg = fixtureConfig(), calls = [] } = {}) {
  const ledger = openLedger(':memory:');
  const record = (name) => (...args) => { calls.push([name, ...args]); return { ok: true, name }; };
  const core = new ToolCore({
    cfg, ledger, mode, motionId,
    providers: {
      ft: {
        enrichPerson: record('enrichPerson'),
        enrichCompany: record('enrichCompany'),
        findEmail: record('findEmail'),
        listTeamMembers: record('listTeamMembers'),
        listSenderConnections: record('listSenderConnections'),
      },
      crm: {
        searchContacts: record('searchContacts'),
        getList: record('getList'),
        listDeals: record('listDeals'),
      },
      writeConfig: record('writeConfig'),
      writeWorkspaceFile: record('writeWorkspaceFile'),
    },
    now: () => NOW,
  });
  return { core, ledger, calls };
}

const SUBJECT = {
  name: 'Jamie Rivers', title: 'VP Sales', email: 'jamie@acme.com',
  company_domain: 'acme.com',
};
const STEPS = [{ channel: 'email', copy: 'Saw you stepped into the VP seat…' }];

// --- mode gating: absence IS the denial --------------------------------------

test('a motion session does not have propose_campaign at all', () => {
  const { core } = makeCore({ mode: 'motion' });
  assert.ok(!core.availableTools().includes('propose_campaign'),
    'campaign authoring must be absent from motion sessions, not merely refused');
  assert.throws(() => core.call('propose_campaign', {}), ToolError);
});

test('a motion session cannot write config or plays', () => {
  const { core } = makeCore({ mode: 'motion' });
  for (const tool of ['set_config', 'write_play', 'write_voice_pack']) {
    assert.ok(!core.availableTools().includes(tool), `${tool} must be absent in motion mode`);
    assert.throws(() => core.call(tool, {}), ToolError);
  }
});

test('an onboarding session cannot stage outreach or spend enrichment credits', () => {
  const { core } = makeCore({ mode: 'onboarding', motionId: null });
  for (const tool of ['propose_outreach', 'propose_campaign', 'start_enrichment']) {
    assert.ok(!core.availableTools().includes(tool), `${tool} must be absent in onboarding`);
  }
});

test('an unknown tool name throws — there is no fallback dispatch', () => {
  const { core } = makeCore({ mode: 'chat' });
  assert.throws(() => core.call('send_email', {}), /unknown tool/);
  assert.throws(() => core.call('complete_task', {}), /unknown tool/);
});

// --- enrichment: closed enum, hard ceiling -----------------------------------

test('enrichment kind is a closed enum — "send_email" is refused, nothing dispatched', () => {
  const calls = [];
  const { core } = makeCore({ calls });
  const r = core.call('start_enrichment', { kind: 'send_email', subject: SUBJECT });
  assert.match(r.refused, /must be one of/);
  assert.equal(calls.length, 0, 'no provider call may happen on a refused kind');
});

test('the enrichment credit ceiling is enforced', () => {
  const { core } = makeCore(); // ceiling is 2 in the fixture
  for (const kind of ENRICHMENT_KINDS.slice(0, 2)) {
    const r = core.call('start_enrichment', { kind, subject: SUBJECT });
    assert.ok(!r.refused, `${kind} should be allowed under the ceiling`);
  }
  const third = core.call('start_enrichment', { kind: 'email_finder', subject: SUBJECT });
  assert.match(third.refused, /ceiling/);
});

// --- propose_outreach: the full gauntlet -------------------------------------

test('outreach without a researched reason is refused — a floor is not a quota', () => {
  const { core } = makeCore();
  const r = core.call('propose_outreach', { subject: SUBJECT, why: '  ', steps: STEPS });
  assert.match(r.refused, /short day beats a manufactured one/);
});

test('a suppressed domain is refused with the reason, even for a brand-new email', () => {
  const { core, ledger } = makeCore();
  ledger.suppress('domain', 'acme.com', 'closed lost 2030-01-01', 'deal-followup', '2031-01-01T00:00:00Z');
  const r = core.call('propose_outreach', {
    subject: { ...SUBJECT, email: 'someone.new@acme.com' }, why: 'hiring', steps: STEPS,
  });
  assert.match(r.refused, /suppressed/);
  assert.match(r.refused, /closed lost/);
});

test('an owner_ref not in config is refused — the model cannot invent a sender', () => {
  const { core } = makeCore();
  const r = core.call('propose_outreach', {
    subject: SUBJECT, why: 'hiring', steps: STEPS, owner_ref: 'attacker',
  });
  assert.match(r.refused, /not in approval_routing\.owners/);
});

test('no owner_ref falls back to the config default owner, never the API user', () => {
  const { core, ledger } = makeCore();
  const r = core.call('propose_outreach', { subject: SUBJECT, why: 'hiring', steps: STEPS });
  assert.equal(r.owner, 'primary');
  const item = ledger.getWorkItem(r.staged);
  assert.equal(item.owner_provider_id, 'usr_ada');
});

test('the per-contact cap refuses the second touch and names the cap', () => {
  const cfg = fixtureConfig();
  cfg.limits.per_contact_per_quarter = 1;
  const { core } = makeCore({ cfg });
  const first = core.call('propose_outreach', { subject: SUBJECT, why: 'hiring', steps: STEPS });
  assert.ok(first.staged);
  const second = core.call('propose_outreach', { subject: SUBJECT, why: 'still hiring', steps: STEPS });
  assert.match(second.refused, /per_contact_per_quarter/);
  assert.match(second.refused, /hard cap/);
});

test('a staged item carries the payload, expiry, and a touch reservation', () => {
  const { core, ledger } = makeCore();
  const r = core.call('propose_outreach', { subject: SUBJECT, why: 'hiring', steps: STEPS });
  const item = ledger.getWorkItem(r.staged);
  assert.equal(item.kind, 'outreach');
  assert.equal(item.status, 'pending_approval');
  assert.ok(item.payload.touch_id, 'the reservation id must travel with the item');
  assert.equal(item.expires_at, '2030-06-04T12:00:00.000Z', '72h from the fixed clock');
});

// --- propose_crm_change: the field allowlist is the permission ----------------

test('a CRM field outside crm_fields_may_change cannot even be proposed', () => {
  const { core } = makeCore({ motionId: 'deal-followup' });
  const r = core.call('propose_crm_change', {
    changes: [{ object_type: 'deal', object_id: 'd1', field: 'amount', from: '100', to: '900000' }],
  });
  assert.match(r.refused, /not in crm_fields_may_change/);
});

test('a change without explicit from/to is refused — compare-and-set needs both', () => {
  const { core } = makeCore({ motionId: 'deal-followup' });
  const r = core.call('propose_crm_change', {
    changes: [{ object_type: 'deal', object_id: 'd1', field: 'dealstage', to: 'closedwon' }],
  });
  assert.match(r.refused, /explicit from and to/);
});

test('an allowed change stages a crm_change work item', () => {
  const { core, ledger } = makeCore({ motionId: 'deal-followup' });
  const r = core.call('propose_crm_change', {
    changes: [{ object_type: 'deal', object_id: 'd1', field: 'dealstage',
                from: 'demo', to: 'negotiation' }],
    why: 'proposal sent last week',
  });
  assert.ok(r.staged);
  assert.equal(ledger.getWorkItem(r.staged).kind, 'crm_change');
});

test('the outbound motion cannot propose CRM changes at all', () => {
  const { core } = makeCore({ motionId: 'outbound' });
  const r = core.call('propose_crm_change', {
    changes: [{ object_type: 'deal', object_id: 'd1', field: 'dealstage', from: 'a', to: 'b' }],
  });
  assert.match(r.refused, /crm_fields_may_change is empty/);
});

// --- flow enrolment: allowlist + suppression on EVERY path --------------------

test('an undeclared flow is refused — the flows list is the only permission', () => {
  const { core } = makeCore();
  const r = core.call('enroll_declared_flow', { flow_id: 'flow_evil', subject: SUBJECT });
  assert.match(r.refused, /not declared in config/);
});

test('a declared flow still checks suppression — the historically skipped path', () => {
  const { core, ledger } = makeCore();
  ledger.suppress('domain', 'acme.com', 'asked to stop', 'operator', null);
  const r = core.call('enroll_declared_flow', { flow_id: 'flow_1', subject: SUBJECT });
  assert.match(r.refused, /suppressed/);
});

test('a declared flow on a clean subject stages an approval item, never enrols directly', () => {
  const { core, ledger } = makeCore();
  const r = core.call('enroll_declared_flow', { flow_id: 'flow_1', subject: SUBJECT });
  assert.ok(r.staged, 'enrolment is staged for approval, not performed');
  const item = ledger.getWorkItem(r.staged);
  assert.equal(item.payload.flow_enrolment.flow_id, 'flow_1');
  assert.equal(item.status, 'pending_approval');
});

// --- campaigns: chat-only, screened per member, honest exclusions -------------

test('a campaign screens every member and reports exclusions on the result', () => {
  const { core, ledger } = makeCore({ mode: 'chat', motionId: null });
  ledger.suppress('domain', 'lost.com', 'closed lost', 'deal-followup', null);
  const audience = [
    { name: 'A', email: 'a@fresh.com' },
    { name: 'B', email: 'b@lost.com' },              // suppressed
    { name: 'A again', email: 'A@FRESH.COM' },        // duplicate (case)
    { name: 'C', email: 'c@fresh2.com' },
  ];
  const r = core.call('propose_campaign', {
    name: 'closed-lost win-back', why: 'discount running', audience,
    steps: [{ channel: 'email', copy: 'We are running a discount…' }],
  });
  assert.equal(r.audience, 2);
  assert.equal(r.excluded, 2);
  const reasons = r.exclusions.map((e) => e.reason).join('\n');
  assert.match(reasons, /suppressed/);
  assert.match(reasons, /duplicate/);
});

test('a campaign whose whole audience is excluded refuses instead of staging', () => {
  const { core, ledger } = makeCore({ mode: 'chat', motionId: null });
  ledger.suppress('domain', 'lost.com', 'closed lost', 'deal-followup', null);
  const r = core.call('propose_campaign', {
    name: 'x', why: 'y', audience: [{ email: 'a@lost.com' }],
    steps: [{ channel: 'email', copy: 'hi' }],
  });
  assert.match(r.refused, /every member of the audience was excluded/);
});

test('campaigns_enabled: false turns the tool off even in chat', () => {
  const cfg = fixtureConfig();
  cfg.chat.campaigns_enabled = false;
  const { core } = makeCore({ mode: 'chat', motionId: null, cfg });
  const r = core.call('propose_campaign', {
    name: 'x', why: 'y', audience: [{ email: 'a@b.com' }],
    steps: [{ channel: 'email', copy: 'hi' }],
  });
  assert.match(r.refused, /disabled in config/);
});

// --- set_config: protected keys and repointing --------------------------------

test('the operator binding can never be written by the agent', () => {
  const { core, calls } = makeCore({ mode: 'chat', motionId: null });
  const r = core.call('set_config', { patch: { slack: { operator: 'U0EVIL000' } } });
  assert.match(r.refused, /operator-only/);
  assert.ok(!calls.some(([n]) => n === 'writeConfig'), 'nothing may be written');
});

test('approval overrides can never be written by the agent', () => {
  const { core } = makeCore({ mode: 'chat', motionId: null });
  const r = core.call('set_config', {
    patch: { approval_routing: { approval_overrides: ['U0EVIL000'] } },
  });
  assert.match(r.refused, /operator-only/);
});

test('a URL anywhere in a patch is refused — repointing needs a confirmed card', () => {
  const { core } = makeCore({ mode: 'chat', motionId: null });
  const r = core.call('set_config', {
    patch: { motions: { dashboard: { base_url: 'https://evil.example.com' } } },
  });
  assert.match(r.refused, /repoints a data source/);
});

test('a patch producing an invalid config is refused with the validation problems', () => {
  const { core, calls } = makeCore({ mode: 'chat', motionId: null });
  const r = core.call('set_config', { patch: { run_mode: 'yolo' } });
  assert.match(r.refused, /run_mode/);
  assert.ok(!calls.some(([n]) => n === 'writeConfig'));
});

test('a valid patch is validated then written', () => {
  const { core, calls } = makeCore({ mode: 'chat', motionId: null });
  const r = core.call('set_config', { patch: { limits: { per_day: 15 } } });
  assert.equal(r.written, true);
  const write = calls.find(([n]) => n === 'writeConfig');
  assert.equal(write[1].limits.per_day, 15);
  assert.equal(write[1].__meta, undefined, 'derived metadata must not be persisted');
});

// --- workspace writes: no traversal ------------------------------------------

test('write_play refuses path traversal toward the guard', () => {
  const { core, calls } = makeCore({ mode: 'chat', motionId: null });
  for (const filename of ['../.claude/hooks/guard-send.mjs', 'a/../../b.md', '.hidden.md', 'sub/dir.md']) {
    const r = core.call('write_play', { filename, content: 'x' });
    assert.ok(r.refused, `"${filename}" must be refused`);
  }
  assert.ok(!calls.some(([n]) => n === 'writeWorkspaceFile'));
});

test('a bare .md filename writes into the plays workspace', () => {
  const { core, calls } = makeCore({ mode: 'chat', motionId: null });
  const r = core.call('write_play', { filename: 'competitor-downsizing.md', content: '# Play' });
  assert.equal(r.written, 'plays/competitor-downsizing.md');
  assert.deepEqual(calls.find(([n]) => n === 'writeWorkspaceFile').slice(1),
    ['plays/competitor-downsizing.md', '# Play']);
});
