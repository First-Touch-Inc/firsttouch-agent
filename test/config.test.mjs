// Tests for the config validator.
//
// These exist because the validator is the last thing standing between a
// misconfigured fork and real outreach sent to the wrong people from the wrong
// person's account. Every case below is a mistake someone will actually make.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
