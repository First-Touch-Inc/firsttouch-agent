// Tests for the send guard.
//
// This hook is the reason the README is allowed to say that nothing reaches a
// person without human approval. If these tests fail, that sentence has become
// false — treat a failure here as a release blocker, not a flaky test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, '.claude', 'hooks', 'guard-send.mjs');

/** Run the hook and return its decision, or null for "allowed through". */
function decide(toolName, toolInput = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(res.status, 0, 'the hook must always exit 0 so it never breaks the run');
  if (!res.stdout.trim()) return null;
  return JSON.parse(res.stdout).hookSpecificOutput;
}

const denied = (d) => d && d.permissionDecision === 'deny';

// Connectors arrive under arbitrary prefixes — a plain name, a hyphen-underscore
// sanitised plugin name, a claude.ai connector UUID. The guard must hold under
// ALL of them, because a rename must never disarm it.
const PREFIXES = [
  'mcp__firsttouch__',
  'mcp__plugin_founder-pack_firsttouch__',
  'mcp__2d4048ad-e1cc-4d91-aadb-afa9518144f7__',
];

// --- immediate sends ---------------------------------------------------------

for (const prefix of PREFIXES) {
  test(`direct sends are blocked under ${prefix}`, () => {
    for (const tool of ['send_linkedin_unibox_message', 'send_campaign', 'send_now']) {
      assert.ok(denied(decide(`${prefix}${tool}`)), `${prefix}${tool} must never be allowed`);
    }
  });
}

// --- email: drafts only ------------------------------------------------------

test('email sends are blocked; drafting is not', () => {
  assert.ok(denied(decide('mcp__gmail__send_message', { to: 'x@y.com' })));
  assert.ok(denied(decide('mcp__gmail__reply', {})));
  assert.ok(denied(decide('mcp__gmail__forward', {})));
  assert.equal(decide('mcp__gmail__create_draft', {}), null, 'drafting stays allowed');
  assert.equal(decide('mcp__gmail__update_draft', {}), null);
});

test('a Slack connector messaging the TEAM is not an email send', () => {
  // Matched exactly, so slack_send_message (team-facing) is not caught by the
  // send_message (email) rule.
  assert.equal(decide('mcp__slack__slack_send_message', { channel: 'C1' }), null);
});

// --- outreach actions: approval on, owner explicit ---------------------------

test('an action with approval explicitly disabled is blocked', () => {
  const d = decide('mcp__firsttouch__add_dynamic_action', {
    isHumanApprovalRequired: false, ownerId: 'u1', action: { assignedUserId: 'u1' },
  });
  assert.ok(denied(d));
  assert.match(d.permissionDecisionReason, /approval/i);
});

test('an action with the approval flag omitted is blocked', () => {
  // Omission is not "approval on" — some platforms default it to false, which
  // would send on creation.
  assert.ok(denied(decide('mcp__firsttouch__add_dynamic_action', {
    ownerId: 'u1', action: { assignedUserId: 'u1' },
  })));
});

test('an action missing either owner field is blocked — both are required', () => {
  const noOwner = decide('mcp__firsttouch__add_dynamic_action', {
    isHumanApprovalRequired: true, action: { assignedUserId: 'u1' },
  });
  assert.ok(denied(noOwner));
  assert.match(noOwner.permissionDecisionReason, /ownerId/);

  const noAssignee = decide('mcp__firsttouch__add_dynamic_action', {
    isHumanApprovalRequired: true, ownerId: 'u1',
  });
  assert.ok(denied(noAssignee));
  assert.match(noAssignee.permissionDecisionReason, /assignedUserId/);
});

test('a correctly gated, correctly owned action is allowed', () => {
  assert.equal(decide('mcp__firsttouch__add_dynamic_action', {
    isHumanApprovalRequired: true, ownerId: 'u1', action: { assignedUserId: 'u1' },
  }), null);
});

// --- approving is the human's half -------------------------------------------

test('complete_task is blocked — the agent never approves its own work', () => {
  const d = decide('mcp__firsttouch__complete_task', { taskId: 't1' });
  assert.ok(denied(d));
  assert.match(d.permissionDecisionReason, /human/i);
});

test('skipping and cancelling stay allowed — both are the safe direction', () => {
  assert.equal(decide('mcp__firsttouch__skip_task', { taskId: 't1' }), null);
  assert.equal(decide('mcp__firsttouch__cancel_flow_enrollments', {}), null);
  assert.equal(decide('mcp__firsttouch__remove_dynamic_action_prospect', {}), null);
});

// --- flows: enrol yes, author no ---------------------------------------------

test('authoring or publishing a flow is blocked', () => {
  for (const tool of ['create_flow_plan', 'update_flow_plan', 'replace_flow_root', 'manage_flow_publication']) {
    assert.ok(denied(decide(`mcp__firsttouch__${tool}`, {})), `${tool} must be blocked`);
  }
});

const FLOWS_FILE = join(ROOT, 'approved-flows.txt');
function withFlowsFile(contents, fn) {
  const existed = existsSync(FLOWS_FILE);
  const backup = existed ? readFileSync(FLOWS_FILE, 'utf8') : null;
  writeFileSync(FLOWS_FILE, contents);
  try { return fn(); } finally {
    if (existed) writeFileSync(FLOWS_FILE, backup); else rmSync(FLOWS_FILE, { force: true });
  }
}

test('without approved-flows.txt, enrolment into a published flow is allowed', () => {
  if (existsSync(FLOWS_FILE)) return; // an operator restriction is in place; the next test covers it
  assert.equal(decide('mcp__firsttouch__add_manual_flow_enrollment', { flowPlanId: 'any' }), null);
});

test('with approved-flows.txt, enrolment is limited to the listed ids', () => {
  withFlowsFile('# permitted flows\nflow_ok_1\n', () => {
    assert.equal(decide('mcp__firsttouch__add_manual_flow_enrollment', { flowPlanId: 'flow_ok_1' }), null);
    const d = decide('mcp__firsttouch__add_manual_flow_enrollment', { flowPlanId: 'flow_other' });
    assert.ok(denied(d));
    assert.match(d.permissionDecisionReason, /not listed/i);
    // No id named at all → cannot be checked → blocked.
    assert.ok(denied(decide('mcp__firsttouch__enroll_awaiting_flow_items', { audienceId: 'a1' })));
  });
});

test('flow enrolment does not relax the action gate', () => {
  withFlowsFile('flow_ok_1\n', () => {
    assert.ok(denied(decide('mcp__firsttouch__add_dynamic_action', { ownerId: 'u1' })));
    assert.ok(denied(decide('mcp__firsttouch__send_linkedin_unibox_message', {})));
  });
});

// --- robustness --------------------------------------------------------------

test('fails closed on an unparseable payload', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: '{not json', encoding: 'utf8', env: { ...process.env } });
  assert.match(r.stdout, /"permissionDecision":"deny"/, 'an unreadable tool call must be blocked, not allowed');
});

test('built-in tools pass through untouched', () => {
  assert.equal(decide('Bash', { command: 'ls' }), null);
  assert.equal(decide('Read', { file_path: 'x.md' }), null);
  assert.equal(decide('WebSearch', {}), null);
});

test('reads and research on any connector pass through', () => {
  assert.equal(decide('mcp__firsttouch__list_team_members', {}), null);
  assert.equal(decide('mcp__firsttouch__discover_contacts', {}), null);
  assert.equal(decide('mcp__2d4048ad-e1cc-4d91-aadb-afa9518144f7__get_contact_trace', {}), null);
  assert.equal(decide('mcp__hubspot__crm_search_contacts', {}), null);
});
