// Tests for the send guard.
//
// This hook is the reason the README is allowed to say that nothing reaches a
// prospect without human approval. If these tests fail, that sentence has
// become false — treat a failure here as a release blocker, not a flaky test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'hooks', 'guard-send.mjs');

/** Run the hook against a raw stdin payload.
 *  The fine-grained rules below are exercised with GUARD_MCP_SERVERS set to
 *  the legacy raw-provider servers; the DEFAULT behaviour (only the agent
 *  tool server is permitted at all) has its own section at the end. */
function decideRaw(input, { dryRun = false, servers = 'outreach,crm,agent' } = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, DRY_RUN: dryRun ? '1' : '0', GUARD_MCP_SERVERS: servers },
  });
  assert.equal(res.status, 0, 'the hook must always exit 0 so it never breaks the run');
  if (!res.stdout.trim()) return null;
  return JSON.parse(res.stdout).hookSpecificOutput;
}

/** Run the hook with a tool call and return its decision, or null for "allowed". */
function decide(toolName, toolInput = {}, opts = {}) {
  return decideRaw(JSON.stringify({ tool_name: toolName, tool_input: toolInput }), opts);
}

const denied = (d) => d && d.permissionDecision === 'deny';

// --- immediate sends ---------------------------------------------------------

for (const tool of [
  'mcp__outreach__send_email',
  'mcp__outreach__send_linkedin_unibox_message',
  'mcp__outreach__send_campaign',
  'mcp__outreach__send_now',
]) {
  test(`blocks the direct-send tool ${tool}`, () => {
    assert.ok(denied(decide(tool)), `${tool} must never be allowed`);
  });
}

// --- approval gate -----------------------------------------------------------

test('blocks an action created with approval explicitly disabled', () => {
  const d = decide('mcp__outreach__add_dynamic_action', {
    isHumanApprovalRequired: false, ownerId: 'u1', action: { assignedUserId: 'u1' },
  });
  assert.ok(denied(d));
  assert.match(d.permissionDecisionReason, /approval/i);
});

test('blocks an action created with the approval flag omitted', () => {
  // Omission is not safe to read as "approval on" — some platforms default it
  // to false, which would send on creation.
  const d = decide('mcp__outreach__add_dynamic_action', {
    ownerId: 'u1', action: { assignedUserId: 'u1' },
  });
  assert.ok(denied(d));
});

test('blocks an approval-gated action that has no explicit owner', () => {
  const d = decide('mcp__outreach__add_dynamic_action', { isHumanApprovalRequired: true });
  assert.ok(denied(d));
  assert.match(d.permissionDecisionReason, /owner/i);
  assert.match(d.permissionDecisionReason, /not reversible/i);
});

test('allows a correctly gated, correctly owned action', () => {
  const d = decide('mcp__outreach__add_dynamic_action', {
    isHumanApprovalRequired: true, ownerId: 'u1', action: { assignedUserId: 'u1' },
  });
  assert.equal(d, null, 'a correct call must not be blocked');
});

// --- dry run -----------------------------------------------------------------

test('a dry run blocks every mutating call, whatever the naming convention', () => {
  // Both shapes occur: `update_property` and `crm_update_property`. Anchoring
  // the verb to the start of the name misses the second and fails open.
  for (const tool of [
    'mcp__crm__crm_update_property',
    'mcp__crm__update_property',
    'mcp__outreach__add_dynamic_action',
    'mcp__outreach__enroll_awaiting_flow_items',
    'mcp__outreach__manage_flow_publication',
  ]) {
    assert.ok(denied(decide(tool, { isHumanApprovalRequired: true, ownerId: 'u1' }, { dryRun: true })),
      `${tool} must be blocked in a dry run`);
  }
});

test('a dry run still allows reads', () => {
  for (const tool of ['mcp__crm__crm_get_contact', 'mcp__crm__crm_search_contacts', 'mcp__outreach__list_enrollments']) {
    assert.equal(decide(tool, {}, { dryRun: true }), null, `${tool} should be readable in a dry run`);
  }
});

// --- robustness --------------------------------------------------------------

test('fails closed on an unparseable payload', () => {
  // If the guard cannot tell what is being called, it must block. A guard that
  // fails open under malformed input is not a guard.
  assert.ok(denied(decideRaw('not json at all')), 'an unreadable tool call must be blocked, not allowed');
  assert.ok(denied(decideRaw('{"tool_name": ')), 'truncated JSON must be blocked too');
});

test('an unrelated tool is not blocked', () => {
  assert.equal(decide('Read', { file_path: 'x.md' }), null);
});

// --- flows vs dynamic actions ------------------------------------------------
// A dynamic action is the agent composing a message nobody has read. A flow is
// copy a human wrote and published, so enrolling a qualified person into one
// does not need a second approval of that copy. The agent may decide WHO is in
// a flow; it may never decide what a flow says or whether it goes live.

import { writeFileSync as wf, rmSync as rm, existsSync as ex, readFileSync as rf } from 'node:fs';
import { join as pj, dirname as pd } from 'node:path';

const REPO = pj(pd(fileURLToPath(import.meta.url)), '..');
const TENANT_CFG = pj(REPO, 'config', 'tenant.yaml');

/** Put a config with one declared flow in place for the duration of a test. */
function withFlows(ids, fn) {
  const existed = ex(TENANT_CFG);
  const backup = existed ? rf(TENANT_CFG, 'utf8') : null;
  const flows = ids.length
    ? 'flows:\n' + ids.map((id) => `  - id: "${id}"\n    name: "test"\n`).join('')
    : 'flows: []\n';
  wf(TENANT_CFG, `client:\n  name: "t"\n${flows}`);
  try { return fn(); } finally {
    if (existed) wf(TENANT_CFG, backup); else rm(TENANT_CFG, { force: true });
  }
}

test('enrolling into a DECLARED flow is allowed without an approval flag', () => {
  withFlows(['flow_ok_1'], () => {
    const d = decide('mcp__outreach__add_manual_flow_enrollment', { flowPlanId: 'flow_ok_1', contactId: 'c1' });
    assert.equal(d, null, 'a flow the operator declared must be enrollable');
  });
});

test('enrolling into an UNDECLARED flow is blocked', () => {
  withFlows(['flow_ok_1'], () => {
    const d = decide('mcp__outreach__add_manual_flow_enrollment', { flowPlanId: 'flow_not_listed' });
    assert.ok(denied(d));
    assert.match(d.permissionDecisionReason, /not listed/i);
  });
});

test('enrolling with no flow id named is blocked', () => {
  withFlows(['flow_ok_1'], () => {
    assert.ok(denied(decide('mcp__outreach__enroll_awaiting_flow_items', { audienceId: 'a1' })));
  });
});

test('with no flows declared, enrolment is blocked entirely', () => {
  withFlows([], () => {
    const d = decide('mcp__outreach__add_manual_flow_enrollment', { flowPlanId: 'anything' });
    assert.ok(denied(d));
  });
});

test('the agent may not author or publish a flow', () => {
  withFlows(['flow_ok_1'], () => {
    for (const tool of [
      'mcp__outreach__create_flow_plan',
      'mcp__outreach__update_flow_plan',
      'mcp__outreach__manage_flow_publication',
      'mcp__outreach__replace_flow_root',
    ]) {
      const d = decide(tool, { flowPlanId: 'flow_ok_1' });
      assert.ok(denied(d), `${tool} must be blocked — publishing is a human's job`);
    }
  });
});

test('a dry run still blocks enrolment into a declared flow', () => {
  withFlows(['flow_ok_1'], () => {
    assert.ok(denied(decide('mcp__outreach__add_manual_flow_enrollment', { flowPlanId: 'flow_ok_1' }, { dryRun: true })));
  });
});

test('flow enrolment does NOT relax the dynamic-action gate', () => {
  withFlows(['flow_ok_1'], () => {
    // The whole point of the split: one path loosened, the other unchanged.
    assert.ok(denied(decide('mcp__outreach__add_dynamic_action', { ownerId: 'u1' })));
    assert.ok(denied(decide('mcp__outreach__send_email', {})));
  });
});

// --- the default: exactly one MCP server exists -------------------------------
// The v1 architecture gives the model ONE server — the agent tool server,
// which holds the credentials and enforces every rule in code. By default the
// guard denies any other MCP server wholesale: if a raw provider server ever
// reaches a session, the wiring is wrong and no fine-grained rule should be
// trusted to out-guess an unknown tool surface.

test('by default, any non-agent MCP server is denied wholesale — even reads', () => {
  for (const tool of [
    'mcp__outreach__list_enrollments',        // a read the legacy rules allow
    'mcp__outreach__add_dynamic_action',
    'mcp__crm__crm_search_contacts',
    'mcp__gmail__send_message',
    'mcp__anything__whatever',
  ]) {
    const d = decide(tool, { isHumanApprovalRequired: true, ownerId: 'u1' }, { servers: 'agent' });
    assert.ok(denied(d), `${tool} must be denied under the default single-server architecture`);
    assert.match(d.permissionDecisionReason, /agent tool server/);
  }
});

test('the agent tool server itself passes through to the normal flow', () => {
  assert.equal(decide('mcp__agent__propose_outreach', {}, { servers: 'agent' }), null);
  assert.equal(decide('mcp__agent__set_config', {}, { servers: 'agent' }), null);
});

test('built-in tools are unaffected by the server allowlist', () => {
  assert.equal(decide('Read', { file_path: 'x.md' }, { servers: 'agent' }), null);
  assert.equal(decide('WebSearch', {}, { servers: 'agent' }), null);
});
