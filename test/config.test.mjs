// Tests for the config validator.
//
// These exist because the validator is the last thing standing between a
// misconfigured fork and real outreach sent to the wrong people from the wrong
// person's account. Every case below is a mistake someone will actually make.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { dump, load } from 'js-yaml';
import { loadConfig, ConfigError, ROOT } from '../runner/lib/config.mjs';

const EXAMPLE = join(ROOT, 'config', 'tenant.example.yaml');

// A minimal config that SHOULD pass, built from the shipped example so the two
// can never drift apart silently.
function validConfig() {
  const cfg = load(readFileSync(EXAMPLE, 'utf8'));
  cfg.providers.crm.customer_signal = [{ property: 'active_seats', operator: 'gte', value: 1 }];
  cfg.approval_routing.owners = [{
    id: 'primary',
    name: 'Ada Lovelace',
    provider_user_id: 'usr_test_123',
    slack_channel: '#approvals',
    match: 'default',
  }];
  return cfg;
}

// Write a config into config/ under a throwaway tenant name and load it.
function loadWith(mutate) {
  const cfg = validConfig();
  if (mutate) mutate(cfg);
  const tenant = `__test_${Math.random().toString(36).slice(2, 10)}`;
  const path = join(ROOT, 'config', `${tenant}.yaml`);
  writeFileSync(path, dump(cfg));
  try {
    return loadConfig(tenant);
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

test('the shipped example is valid YAML and parses', () => {
  const cfg = load(readFileSync(EXAMPLE, 'utf8'));
  assert.equal(typeof cfg, 'object');
  assert.ok(Array.isArray(cfg.buckets));
});

test('a fully specified config loads', () => {
  const cfg = loadWith();
  assert.equal(cfg.client.name, 'Northwind Analytics');
  assert.equal(cfg.__meta.effectiveCap, cfg.caps.supervised_run_cap, 'supervised mode uses the supervised cap');
});

test('the UNEDITED example is rejected', () => {
  // If this ever passes, the placeholder checks have regressed and a fork
  // could run against placeholder ids.
  const cfg = load(readFileSync(EXAMPLE, 'utf8'));
  const tenant = `__test_raw_${Math.random().toString(36).slice(2, 8)}`;
  const path = join(ROOT, 'config', `${tenant}.yaml`);
  writeFileSync(path, dump(cfg));
  try {
    assert.throws(() => loadConfig(tenant), ConfigError);
  } finally {
    rmSync(path, { force: true });
  }
});

test('a missing config names the file and tells you how to make one', () => {
  try {
    loadConfig('__definitely_not_a_tenant__');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /cp config\/tenant\.example\.yaml/);
  }
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

// --- suppression: prevents prospecting your own customers --------------------

test('an unconfigured customer_signal is rejected', () => {
  const p = problemsFrom((c) => { c.providers.crm.customer_signal = [{ property: '', operator: 'gte', value: 1 }]; });
  assert.match(p, /customer_signal/);
  assert.match(p, /no safe default/);
});

test('an empty suppression list is rejected', () => {
  const p = problemsFrom((c) => { c.suppression = []; });
  assert.match(p, /suppression/);
});

// --- buckets -----------------------------------------------------------------

test('an ENABLED bucket with a placeholder list_id is rejected', () => {
  const p = problemsFrom((c) => {
    const b = c.buckets.find((x) => x.id === 'target-accounts');
    b.enabled = true; // its list_id is still <YOUR_TARGET_ACCOUNT_LIST_ID>
  });
  assert.match(p, /still a placeholder/);
});

test('a DISABLED bucket with a placeholder list_id is fine', () => {
  // Only what will actually run gets validated — otherwise the shipped example
  // could never be a starting point.
  const cfg = loadWith();
  assert.ok(cfg.buckets.some((b) => !b.enabled && String(b.source?.list_id || '').startsWith('<')));
});

test('no enabled bucket is rejected', () => {
  const p = problemsFrom((c) => { for (const b of c.buckets) b.enabled = false; });
  assert.match(p, /No bucket is enabled/);
});

test('duplicate bucket ids are rejected', () => {
  const p = problemsFrom((c) => { c.buckets.push({ ...c.buckets[0] }); });
  assert.match(p, /Duplicate bucket id/);
});

// --- caps and mode -----------------------------------------------------------

test('a floor above the ceiling is rejected', () => {
  const p = problemsFrom((c) => { c.caps.min_per_day = 50; c.caps.max_per_day = 10; });
  assert.match(p, /cannot exceed/);
});

test('an unknown run_mode is rejected', () => {
  const p = problemsFrom((c) => { c.run_mode = 'yolo'; });
  assert.match(p, /run_mode/);
});

test('daily mode uses the real ceiling, not the supervised cap', () => {
  const cfg = loadWith((c) => { c.run_mode = 'daily'; });
  assert.equal(cfg.__meta.effectiveCap, cfg.caps.max_per_day);
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
  const cfg = loadWith((c) => { c.extra_plays = '.claude/skills/pipeline-agent/plays.md'; });
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

test('extra_plays pointing at a single file loads that file', () => {
  const f = join(ROOT, 'config', `__test_play_${Math.random().toString(36).slice(2, 8)}.md`);
  writeFileSync(f, '---\nid: solo\n---\n');
  try {
    const cfg = loadWith((c) => { c.extra_plays = `config/${basename(f)}`; });
    assert.equal(cfg.__meta.plays.custom.length, 1);
  } finally {
    rmSync(f, { force: true });
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

test('a correctly configured chat block passes', () => {
  const cfg = loadWith((c) => {
    c.chat = { enabled: true, allowed_users: ['U01234ABCDE'], allowed_channels: ['C01234ABCDE'] };
  });
  assert.equal(cfg.chat.allowed_users.length, 1);
});

// --- the feedback loop -------------------------------------------------------
// The orchestrator reads and writes state.lessons on every run. The key was
// referenced in five places in the skill and defined in none, so the learning
// silently never happened. These stop that returning.

test('state.lessons is required — it is the feedback memory', () => {
  const p = problemsFrom((c) => { delete c.state.lessons; });
  assert.match(p, /state\.lessons is required/);
  assert.match(p, /learn from feedback/);
});

test('state.ledger is required — it is what prevents contacting someone twice', () => {
  const p = problemsFrom((c) => { delete c.state.ledger; });
  assert.match(p, /state\.ledger is required/);
});

test('lessons resolves to a real path under the state directory', () => {
  const cfg = loadWith();
  assert.ok(cfg.__meta.lessonsPath, 'the loader must resolve a lessons path');
  assert.match(cfg.__meta.lessonsPath, /lessons\.md$/);
});
