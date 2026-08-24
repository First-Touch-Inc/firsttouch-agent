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

/** Run the hook against a raw stdin payload. */
function decideRaw(input, { dryRun = false } = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, DRY_RUN: dryRun ? '1' : '0' },
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
