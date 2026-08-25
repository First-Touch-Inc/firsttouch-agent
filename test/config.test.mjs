// Tests for the config validator.
//
// These exist because the validator is the last thing standing between a
// misconfigured fork and real outreach sent to the wrong people from the wrong
// person's account. Every case below is a mistake someone will actually make.
//
// Onboarding writes config through this same validator, so every rejection
// here is also a thing the onboarding conversation cannot produce.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { dump, load } from 'js-yaml';
import { loadConfig, validateConfig, ConfigError, ROOT, MOTION_KINDS } from '../runner/lib/config.mjs';

const EXAMPLE = join(ROOT, 'config', 'agent.example.yaml');

// A minimal config that SHOULD pass, built from the shipped example so the two
// can never drift apart silently.
function validConfig() {
  const cfg = load(readFileSync(EXAMPLE, 'utf8'));
  cfg.client.name = 'Northwind Analytics';
  cfg.providers.crm.customer_signal = [{ property: 'active_seats', equals: 'yes' }];
  const outbound = cfg.motions.find((m) => m.kind === 'outbound');
  for (const s of outbound.sources) if (s.type === 'crm.list') s.list_id = 'list_123';
  cfg.approval.digest_channel = 'C01234ABCDE';
  cfg.approval_routing.owners = [{
    id: 'primary',
    name: 'Ada Lovelace',
    provider_user_id: 'usr_test_123',
    slack_user_id: 'U01234ABCDE',
    slack_channel: 'C09876ZYXWV',
    match: 'default',
  }];
  cfg.chat.allowed_users = ['U01234ABCDE'];
  return cfg;
}

// Write a config into config/ under a throwaway name and load it.
function loadWith(mutate) {
  const cfg = validConfig();
  if (mutate) mutate(cfg);
  const name = `__test_${Math.random().toString(36).slice(2, 10)}`;
  const path = join(ROOT, 'config', `${name}.yaml`);
  writeFileSync(path, dump(cfg));
  try {
    return loadConfig(name);
  } finally {
    rmSync(path, { force: true });
  }
}

function problemsFrom(mutate) {
  try {
    loadWith(mutate);
    return null; // no error thrown
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected ConfigError, got ${e}`);
    return e.problems.join('\n');
  }
}

test('the shipped example is valid YAML and has all four motion kinds', () => {
  const cfg = load(readFileSync(EXAMPLE, 'utf8'));
  assert.equal(typeof cfg, 'object');
  assert.deepEqual(
    cfg.motions.map((m) => m.kind).sort(),
    [...MOTION_KINDS].sort(),
    'the example must demonstrate every motion kind',
  );
});

test('a fully specified config loads, with enabled motions in __meta', () => {
  const cfg = loadWith();
  assert.equal(cfg.client.name, 'Northwind Analytics');
  assert.equal(cfg.__meta.enabledMotions.length, 1, 'only outbound is enabled in the example');
  assert.match(cfg.__meta.ledgerPath, /ledger\.db$/);
});

test('the UNEDITED example is rejected', () => {
  // If this ever passes, the placeholder checks have regressed and a fork
  // could run against placeholder ids.
  const cfg = load(readFileSync(EXAMPLE, 'utf8'));
  const name = `__test_raw_${Math.random().toString(36).slice(2, 8)}`;
  const path = join(ROOT, 'config', `${name}.yaml`);
  writeFileSync(path, dump(cfg));
  try {
    assert.throws(() => loadConfig(name), ConfigError);
  } finally {
    rmSync(path, { force: true });
  }
});

test('a missing config names the file and tells you how to make one', () => {
  try {
    loadConfig('__definitely_not_a_config__');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /cp config\/agent\.example\.yaml/);
  }
});

test('validateConfig is usable standalone for pre-write validation', () => {
  // Onboarding's set_config validates a candidate BEFORE writing it.
  const problems = validateConfig(validConfig());
  assert.deepEqual(problems, []);
  const bad = validConfig();
  bad.run_mode = 'yolo';
  assert.ok(validateConfig(bad).some((p) => /run_mode/.test(p)));
});

// --- ownership: the highest-consequence validation ---------------------------

test('an owner without provider_user_id is rejected, and the message explains why', () => {
  const p = problemsFrom((c) => { delete c.approval_routing.owners[0].provider_user_id; });
  assert.match(p, /provider_user_id is required/);
  assert.match(p, /not reversible/, 'the message must say why this matters');
});

test('no default owner is rejected', () => {
  const p = problemsFrom((c) => { c.approval_routing.owners[0].match = 'prior_account_history'; });
  assert.match(p, /match: default/);
});

test('two default owners are rejected', () => {
  const p = problemsFrom((c) => {
    c.approval_routing.owners.push({ ...c.approval_routing.owners[0], id: 'second' });
  });
  assert.match(p, /Exactly one owner/);
});

test('duplicate owner ids are rejected', () => {
  const p = problemsFrom((c) => {
    c.approval_routing.owners.push({
      ...c.approval_routing.owners[0], match: 'prior_account_history',
    });
  });
  assert.match(p, /Duplicate owner id/);
});

test('an owner slack_user_id that is not a Slack ID is rejected', () => {
  const p = problemsFrom((c) => { c.approval_routing.owners[0].slack_user_id = '@ada'; });
  assert.match(p, /not a Slack user ID/);
});

// --- suppression: prevents prospecting your own customers --------------------

test('an unconfigured customer_signal is rejected', () => {
  const p = problemsFrom((c) => { c.providers.crm.customer_signal = [{ property: '' }]; });
  assert.match(p, /customer_signal/);
  assert.match(p, /no safe default/);
});

test('an empty suppression list is rejected', () => {
  const p = problemsFrom((c) => { c.suppression = []; });
  assert.match(p, /suppression/);
});

// --- motions -----------------------------------------------------------------

test('an unknown motion kind is rejected', () => {
  const p = problemsFrom((c) => { c.motions[0].kind = 'growth_hacking'; });
  assert.match(p, /kind must be one of/);
});

test('no enabled motion is rejected', () => {
  const p = problemsFrom((c) => { for (const m of c.motions) m.enabled = false; });
  assert.match(p, /No motion is enabled/);
});

test('duplicate motion ids are rejected', () => {
  const p = problemsFrom((c) => { c.motions.push({ ...c.motions[0] }); });
  assert.match(p, /Duplicate motion id/);
});

test('an ENABLED motion with a placeholder list_id is rejected', () => {
  const p = problemsFrom((c) => {
    const outbound = c.motions.find((m) => m.kind === 'outbound');
    outbound.sources.push({ type: 'crm.list', list_id: '<still a placeholder>' });
  });
  assert.match(p, /placeholder list_id/);
});

test('a DISABLED motion with placeholders is fine — only what runs is validated', () => {
  // Otherwise the shipped example could never be a starting point.
  const cfg = loadWith();
  const disabled = cfg.motions.filter((m) => !m.enabled);
  assert.ok(disabled.length >= 3, 'the example ships three disabled motions');
});

test('a schedule that is not a cron line is rejected', () => {
  const p = problemsFrom((c) => { c.motions[0].schedule = '8am weekdays'; });
  assert.match(p, /five-field cron/);
});

test('deal_followup requires an explicit CRM change allowlist', () => {
  const p = problemsFrom((c) => {
    const m = c.motions.find((x) => x.kind === 'deal_followup');
    m.enabled = true;
    m.pipeline_id = 'pipe_1';
    m.crm_fields_may_change = [];
  });
  assert.match(p, /crm_fields_may_change/);
});

test('cs_postclose requires a dashboard identity string, and says why', () => {
  const p = problemsFrom((c) => {
    const m = c.motions.find((x) => x.kind === 'cs_postclose');
    m.enabled = true;
    m.dashboard = { base_url: 'https://cs.example.com/api' }; // no identity
  });
  assert.match(p, /dashboard\.identity/);
  assert.match(p, /SOMETHING answered/, 'the message must carry the production lesson');
});

// --- approval ----------------------------------------------------------------

test('a missing approval block is rejected', () => {
  const p = problemsFrom((c) => { delete c.approval; });
  assert.match(p, /approval is required/);
});

test('approval.digest_channel must be a channel ID, not a #name', () => {
  const p = problemsFrom((c) => { c.approval.digest_channel = '#approvals'; });
  assert.match(p, /Slack channel ID/);
});

// --- per-owner routing: cards land in the owner's channel --------------------
// Jared's approvals go to #jared-approvals, Emily's to #emily-approvals. An
// owner without a channel would have their cards silently buried in someone
// else's inbox, so it is required, not defaulted.

test('an owner without an approvals channel is rejected', () => {
  const p = problemsFrom((c) => { delete c.approval_routing.owners[0].slack_channel; });
  assert.match(p, /slack_channel/);
  assert.match(p, /every card that sends as them/);
});

test('an owner channel that is a #name instead of an ID is rejected', () => {
  const p = problemsFrom((c) => { c.approval_routing.owners[0].slack_channel = '#ada-approvals'; });
  assert.match(p, /slack_channel must be a Slack channel ID/);
});

test('an undo window outside 10–300 seconds is rejected', () => {
  const p = problemsFrom((c) => { c.approval.undo_seconds = 0; });
  assert.match(p, /undo_seconds/);
  const p2 = problemsFrom((c) => { c.approval.undo_seconds = 3600; });
  assert.match(p2, /undo_seconds/);
});

// --- limits: enforced, so they must be real ----------------------------------

test('a blank limit is invalid, not unlimited', () => {
  const p = problemsFrom((c) => { delete c.limits.per_day; });
  assert.match(p, /limits\.per_day/);
  assert.match(p, /not "unlimited"/);
});

test('per_day above per_week is rejected', () => {
  const p = problemsFrom((c) => { c.limits.per_day = 500; c.limits.per_week = 100; });
  assert.match(p, /cannot exceed/);
});

test('an unknown run_mode is rejected', () => {
  const p = problemsFrom((c) => { c.run_mode = 'yolo'; });
  assert.match(p, /run_mode/);
});

// --- flows: the allowlist is the permission ----------------------------------

test('an empty flows list is valid and means "no flows"', () => {
  const cfg = loadWith((c) => { c.flows = []; });
  assert.deepEqual(cfg.flows, []);
});

test('a flow without a real id is rejected', () => {
  const p = problemsFrom((c) => { c.flows = [{ id: '<flow id>', name: 'Welcome' }]; });
  assert.match(p, /allowlist is the permission/);
});

// --- providers ---------------------------------------------------------------

test('an unimplemented provider fails loudly rather than half-working', () => {
  const p = problemsFrom((c) => { c.providers.crm.kind = 'salesforce'; });
  assert.match(p, /no adapter/);
  assert.match(p, /docs\/providers\.md/);
});

test('an invalid timezone is rejected', () => {
  const p = problemsFrom((c) => { c.client.timezone = 'Mars/Olympus_Mons'; });
  assert.match(p, /not a valid IANA timezone/);
});

// --- error reporting behaviour ----------------------------------------------

test('all problems are reported at once, not one per run', () => {
  const p = problemsFrom((c) => {
    delete c.approval_routing.owners[0].provider_user_id;
    c.run_mode = 'yolo';
    c.suppression = [];
  });
  assert.match(p, /provider_user_id/);
  assert.match(p, /run_mode/);
  assert.match(p, /suppression/);
});

// --- custom plays: the moldability surface -----------------------------------
// This key was documented and then never read by the loader, so a customer could
// point it anywhere and get no play and no error. These tests exist so that
// cannot come back.

test('extra_plays pointing at the shipped catalogue means "no extras"', () => {
  const cfg = loadWith((c) => { c.extra_plays = '.claude/skills/firsttouch-agent/plays.md'; });
  assert.equal(cfg.__meta.plays.custom.length, 0);
  assert.equal(cfg.__meta.plays.problems.length, 0);
});

test('extra_plays pointing at a missing path warns instead of silently loading nothing', () => {
  const cfg = loadWith((c) => { c.extra_plays = 'config/definitely-not-here'; });
  assert.equal(cfg.__meta.plays.custom.length, 0);
  assert.match(cfg.__meta.plays.problems.join('\n'), /does not exist/);
});

test('extra_plays directory loads .md plays and skips its README', () => {
  const dir = join(ROOT, 'config', `__test_plays_${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# not a play');
  writeFileSync(join(dir, 'alpha.md'), '---\nid: alpha\n---\n');
  writeFileSync(join(dir, 'beta.md'), '---\nid: beta\n---\n');
  writeFileSync(join(dir, 'notes.txt'), 'ignored');
  try {
    const cfg = loadWith((c) => { c.extra_plays = `config/${basename(dir)}`; });
    const names = cfg.__meta.plays.custom.map((p) => basename(p)).sort();
    assert.deepEqual(names, ['alpha.md', 'beta.md'], 'README.md and non-markdown must be skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- chat --------------------------------------------------------------------
// The dangerous case is an enabled chat agent with an empty allowlist: it would
// answer whoever finds the channel. That must be an error, not a default.

test('chat enabled with an empty allowlist is rejected', () => {
  const p = problemsFrom((c) => { c.chat = { enabled: true, allowed_users: [] }; });
  assert.match(p, /allowed_users is empty/);
  assert.match(p, /nobody/);
});

test('chat disabled needs no allowlist', () => {
  const cfg = loadWith((c) => { c.chat = { enabled: false, allowed_users: [] }; });
  assert.equal(cfg.chat.enabled, false);
});

test('chat rejects display names where Slack IDs are required', () => {
  const p = problemsFrom((c) => { c.chat = { enabled: true, allowed_users: ['@jared'] }; });
  assert.match(p, /not a Slack user ID/);
});

test('chat rejects #channel-name where a channel ID is required', () => {
  const p = problemsFrom((c) => {
    c.chat = { enabled: true, allowed_users: ['U01234ABCDE'], allowed_channels: ['#general'] };
  });
  assert.match(p, /not a Slack channel ID/);
});

// --- state: one database, not files ------------------------------------------

test('state.ledger is required', () => {
  const p = problemsFrom((c) => { delete c.state.ledger; });
  assert.match(p, /state\.ledger is required/);
});

test('the old state.lessons file key is rejected with a migration message', () => {
  // Lessons live in the ledger, written only by the host. A config carrying
  // the old key is from the previous schema and must fail loudly, not have
  // half its learning silently ignored.
  const p = problemsFrom((c) => { c.state.lessons = 'state/lessons.md'; });
  assert.match(p, /no longer a file/);
  assert.match(p, /Remove the state\.lessons key/);
});
