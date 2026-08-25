// Tests for Slack approval cards.
//
// The rule that matters: only the owner may approve their own card. Approving
// someone else's outreach sends it from THEIR account under THEIR name, and the
// enrollment's owner cannot be changed afterwards. A button is the easiest place
// to reintroduce that failure, so it is the most important thing to pin down.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApprovalCard, applyDecision } from '../runner/lib/approvals.mjs';

const CFG = {
  providers: { outreach: { mcp_url: 'https://example.invalid/mcp' } },
  approval_routing: {
    owners: [
      { id: 'primary', name: 'Ada', provider_user_id: 'usr_ada', slack_user_id: 'U_ADA', match: 'default' },
      { id: 'second', name: 'Grace', provider_user_id: 'usr_grace', slack_user_id: 'U_GRACE', match: 'prior_account_history' },
    ],
    approval_overrides: [],
  },
};
const ownerSlackIdFor = (pid) =>
  CFG.approval_routing.owners.find((o) => o.provider_user_id === pid)?.slack_user_id || null;

const PLAN = {
  contact_name: 'Jamie Rivers',
  contact_title: 'VP Sales',
  company: 'Northwind',
  why: 'Started in role six weeks ago',
  first_message: 'Saw you just stepped into the VP Sales seat...',
  task_ids: ['task_123'],
  owner_provider_user_id: 'usr_ada',
  owner_slack_id: 'U_ADA',
};

// --- card shape --------------------------------------------------------------

test('a card carries the task id and the owner, and nothing sensitive', () => {
  const blocks = buildApprovalCard(PLAN, { queueUrl: 'https://app.example.com/tasks' });
  const actions = blocks.find((b) => b.type === 'actions');
  assert.ok(actions, 'a plan with a task id must get buttons');

  const approve = actions.elements.find((e) => e.action_id === 'approve');
  const parsed = JSON.parse(approve.value);
  assert.equal(parsed.t, 'task_123');
  assert.equal(parsed.o, 'usr_ada');

  // The whole card is round-tripped through Slack, so it must not carry
  // anything that would matter if it came back altered.
  assert.ok(!JSON.stringify(blocks).includes('FT_MCP_TOKEN'));
});

test('a plan with no task id gets no buttons, and says why', () => {
  const blocks = buildApprovalCard({ ...PLAN, task_ids: [] });
  assert.equal(blocks.find((b) => b.type === 'actions'), undefined);
  assert.match(JSON.stringify(blocks), /only be actioned in the queue/i);
});

test('the card names who it sends as', () => {
  const blocks = buildApprovalCard(PLAN);
  assert.match(JSON.stringify(blocks), /U_ADA/);
  assert.match(JSON.stringify(blocks), /Only they can approve it/i);
});

// --- the ownership rule ------------------------------------------------------

test('someone else cannot approve your card', async () => {
  const line = await applyDecision({
    decision: 'approve',
    value: JSON.stringify({ t: 'task_123', o: 'usr_ada' }),
    clicker: 'U_GRACE',                       // not the owner
    cfg: CFG,
    ownerSlackIdFor,
  });
  assert.match(line, /theirs to approve/i);
  assert.match(line, /U_ADA/);
  // Crucially it must not have reached the platform at all.
  assert.doesNotMatch(line, /platform has it/i);
});

test('a named override may approve for someone else', async () => {
  const cfg = {
    ...CFG,
    approval_routing: { ...CFG.approval_routing, approval_overrides: ['U_GRACE'] },
  };
  // Gets past the ownership check, then fails on credentials — which is the
  // proof it proceeded rather than being refused on ownership.
  const line = await applyDecision({
    decision: 'approve',
    value: JSON.stringify({ t: 'task_123', o: 'usr_ada' }),
    clicker: 'U_GRACE',
    cfg,
    ownerSlackIdFor,
  });
  assert.doesNotMatch(line, /theirs to approve/i);
});

test('a card with no task id is refused before anything else', async () => {
  const line = await applyDecision({
    decision: 'approve',
    value: JSON.stringify({ o: 'usr_ada' }),
    clicker: 'U_ADA',
    cfg: CFG,
    ownerSlackIdFor,
  });
  assert.match(line, /no task id/i);
});

test('a malformed value is refused rather than guessed at', async () => {
  const line = await applyDecision({
    decision: 'approve',
    value: 'not json at all',
    clicker: 'U_ADA',
    cfg: CFG,
    ownerSlackIdFor,
  });
  assert.match(line, /no task id/i);
});

test('missing platform credentials fail loudly, not silently', async () => {
  const saved = process.env.FT_MCP_TOKEN;
  delete process.env.FT_MCP_TOKEN;
  try {
    const line = await applyDecision({
      decision: 'approve',
      value: JSON.stringify({ t: 'task_123', o: 'usr_ada' }),
      clicker: 'U_ADA',
      cfg: CFG,
      ownerSlackIdFor,
    });
    assert.match(line, /FT_MCP_TOKEN/);
  } finally {
    if (saved !== undefined) process.env.FT_MCP_TOKEN = saved;
  }
});

// --- fail-closed ownership ---------------------------------------------------
// Found by an independent audit: the check used to read `if (ownerSlackId && …)`,
// so an owner that could not be resolved skipped the check entirely and anyone
// on the allowlist could approve someone else's outreach. Not knowing the owner
// must refuse, never allow.

test('a card with no owner recorded is refused, not allowed', async () => {
  const line = await applyDecision({
    decision: 'approve',
    value: JSON.stringify({ t: 'task_123' }),        // no `o`
    clicker: 'U_SOMEONE_ELSE',
    cfg: CFG,
    ownerSlackIdFor,
  });
  assert.match(line, /no owner recorded/i);
  assert.doesNotMatch(line, /FT_MCP_TOKEN/, 'it must refuse before reaching the platform');
});

test('an owner with no slack_user_id is refused, not allowed', async () => {
  const line = await applyDecision({
    decision: 'approve',
    value: JSON.stringify({ t: 'task_123', o: 'usr_not_in_config' }),
    clicker: 'U_SOMEONE_ELSE',
    cfg: CFG,
    ownerSlackIdFor,
  });
  assert.match(line, /slack_user_id/);
  assert.doesNotMatch(line, /FT_MCP_TOKEN/, 'it must refuse before reaching the platform');
});

test('the owner themselves still gets through', async () => {
  const line = await applyDecision({
    decision: 'approve',
    value: JSON.stringify({ t: 'task_123', o: 'usr_ada' }),
    clicker: 'U_ADA',
    cfg: CFG,
    ownerSlackIdFor,
  });
  // Passes ownership, then stops on credentials — which proves it proceeded.
  assert.match(line, /FT_MCP_TOKEN/);
});
