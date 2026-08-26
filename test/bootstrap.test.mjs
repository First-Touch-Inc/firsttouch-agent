// First run: no config file yet.
//
// The agent's answer to "you have no config" is "DM me and I'll interview you
// and write one". That answer was unreachable — the host exited on the missing
// file before Slack ever connected, so onboarding could not happen. These tests
// pin the path open.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapConfig, validateConfig, configPath } from '../runner/lib/config.mjs';
import { ToolCore } from '../runner/lib/tools-core.mjs';
import { openLedger } from '../runner/lib/ledger.mjs';

function withStateDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-'));
  const saved = process.env.STATE_DIR;
  process.env.STATE_DIR = dir;
  try { return fn(dir); } finally {
    if (saved === undefined) delete process.env.STATE_DIR; else process.env.STATE_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a bootstrap config is usable enough to boot a host', () => {
  withStateDir(() => {
    const cfg = bootstrapConfig('agent');
    assert.equal(cfg.__bootstrap, true, 'the first-run marker is what disables ticks');
    assert.ok(cfg.__meta.ledgerPath, 'the ledger must resolve or openLedger throws on boot');
    assert.ok(cfg.__meta.path.endsWith('agent.yaml'));
    assert.deepEqual(cfg.__meta.enabledMotions, [], 'nothing may be scheduled before onboarding');
    assert.deepEqual(cfg.motions, []);
  });
});

test('a bootstrap config is NOT a valid saved config — it can never be silently persisted', () => {
  withStateDir(() => {
    const problems = validateConfig(bootstrapConfig('agent'));
    assert.ok(problems.length > 0, 'empty defaults must not pass validation as a real tenant config');
  });
});

test('the ledger opens on a bootstrap config, so the operator claim can be recorded', () => {
  withStateDir(() => {
    const cfg = bootstrapConfig('agent');
    const ledger = openLedger(cfg.__meta.ledgerPath);
    try {
      // During bootstrap the operator binding goes to the ledger, not to a stub
      // config file — a stub would fail validation on the next restart and lock
      // the operator out mid-onboarding.
      ledger.setWatermark('agent', 'operator_slack_id', 'U123');
      assert.equal(ledger.getWatermark('agent', 'operator_slack_id'), 'U123');
      assert.ok(existsSync(cfg.__meta.ledgerPath), 'the ledger file lands on the state volume');
    } finally {
      ledger.close(); // Windows will not remove the temp dir while SQLite holds it
    }
  });
});

test('the config onboarding writes does NOT carry the bootstrap marker', () => {
  // Persisting __bootstrap would leave every future boot believing it is still
  // un-onboarded: ticks disabled, nothing ever runs, and no error to explain it.
  withStateDir(() => {
    const calls = [];
    const core = new ToolCore({
      cfg: bootstrapConfig('agent'),
      ledger: openLedger(':memory:'),
      mode: 'onboarding',
      isOperator: true,
      providers: {
        writeConfig: (c) => { calls.push(c); return { ok: true }; },
        writeWorkspaceFile() {},
      },
      now: () => new Date('2026-08-26T12:00:00Z'),
    });

    const res = core.call('set_config', {
      patch: {
        motions: [{
          id: 'outbound', kind: 'outbound', enabled: true, schedule: '0 8 * * 1-5',
          owner: 'jared', daily_cap: 10,
        }],
        owners: [{ id: 'jared', name: 'Jared', slack_channel: '#jared-approvals', sender: 'jared@firsttouch.com' }],
        approval: { digest_channel: '#agents', undo_minutes: 10 },
        state: { ledger: 'state/ledger.db' },
      },
    });

    // The patch may still be rejected for unrelated schema reasons; what must
    // never happen is a WRITE that carries the marker.
    for (const written of calls) {
      assert.ok(!('__bootstrap' in written), '__bootstrap must never reach the saved config');
      assert.ok(!('__meta' in written), '__meta must never reach the saved config');
    }
    if (calls.length === 0) {
      assert.ok(res.refused, 'if nothing was written the tool must say why');
    }
  });
});
