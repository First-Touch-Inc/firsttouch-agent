// Tests for the decision layer — clicks and modal submissions.
//
// The two rules that must not regress:
//   1. Modal opens happen BEFORE any check (trigger_id dies in ~3s); all
//      checks run on view_submission, where there is no deadline.
//   2. Only the owner (or a named override) may decide; unknown owner refuses.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../runner/lib/ledger.mjs';
import { handleBlockAction, handleViewSubmission, refuseUnlessOwner } from '../runner/lib/decide.mjs';

const NOW = () => new Date('2030-06-01T12:00:00Z');
const FUTURE = '2030-06-04T12:00:00.000Z';

const CFG = {
  approval: { undo_seconds: 45, expiry_hours: 72 },
  approval_routing: {
    owners: [
      { id: 'primary', name: 'Ada', provider_user_id: 'usr_ada',
        slack_user_id: 'U0ADA', slack_channel: 'C0ADA', match: 'default' },
    ],
    approval_overrides: [],
  },
  motions: [{ id: 'outbound', kind: 'outbound' }],
};

function setup() {
  const ledger = openLedger(':memory:');
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: {
      subject: { name: 'Jamie', email: 'jamie@acme.com' },
      why: 'hiring', steps: [{ channel: 'email', copy: 'draft' }],
    },
    ownerProviderId: 'usr_ada', expiresAt: FUTURE,
  });
  const calls = { opened: [], updated: [], ephemeral: [], applied: [] };
  const io = {
    openView: async (t, v) => calls.opened.push({ trigger: t, view: v }),
    updateCard: async (item, extra) => calls.updated.push({ status: item.status, ...extra }),
    ephemeral: async (text) => calls.ephemeral.push(text),
    applyNow: async (itemId) => calls.applied.push(itemId),
  };
  return { ledger, id, calls, io };
}

const click = (id, actionId, user = 'U0ADA') => ({
  user: { id: user },
  trigger_id: `trig_${Math.random().toString(36).slice(2)}`,
  actions: [{ action_id: actionId, value: JSON.stringify({ w: id }) }],
});

const submission = (id, callbackId, values, user = 'U0ADA') => ({
  user: { id: user },
  view: {
    id: `V${Math.random().toString(36).slice(2)}`, hash: 'h1',
    callback_id: callbackId,
    private_metadata: JSON.stringify({ w: id }),
    state: { values },
  },
});

// --- the modal-first rule -----------------------------------------------------

test('review opens the modal even for a NON-owner — checks belong to submission', async () => {
  const { ledger, id, calls, io } = setup();
  await handleBlockAction({
    ledger, cfg: CFG, payload: click(id, 'review', 'U0NOT_OWNER'), ...io, now: NOW,
  });
  assert.equal(calls.opened.length, 1, 'the modal must open — trigger_id cannot wait for checks');
  assert.equal(calls.opened[0].view.callback_id, 'edit_approve');
  // The submission is where the non-owner is refused:
  await handleViewSubmission({
    ledger, cfg: CFG,
    payload: submission(id, 'edit_approve', { step_0: { copy: { value: 'x' } } }, 'U0NOT_OWNER'),
    ...io, now: NOW,
  });
  assert.match(calls.ephemeral.at(-1), /theirs to approve/);
  assert.equal(ledger.effectiveDecision(id), null, 'no decision may be recorded');
});

test('deny opens the reason modal first, records nothing yet', async () => {
  const { ledger, id, calls, io } = setup();
  await handleBlockAction({ ledger, cfg: CFG, payload: click(id, 'deny'), ...io, now: NOW });
  assert.equal(calls.opened[0].view.callback_id, 'deny_reason');
  assert.equal(ledger.effectiveDecision(id), null);
});

// --- approve: intent, undo window, dedupe -------------------------------------

test('approve records a decision, opens the undo window, and creates an intent', async () => {
  const { ledger, id, calls, io } = setup();
  await handleBlockAction({ ledger, cfg: CFG, payload: click(id, 'approve'), ...io, now: NOW });
  assert.equal(ledger.getWorkItem(id).status, 'undo_window');
  assert.equal(ledger.dueIntents('2030-06-01T12:00:46.000Z').length, 1, 'intent fires after 45s');
  assert.equal(ledger.dueIntents('2030-06-01T12:00:30.000Z').length, 0, 'not inside the window');
  assert.equal(calls.updated.at(-1).status, 'undo_window');
});

test('a Slack retry of the same click does not create a second intent', async () => {
  const { ledger, id, io } = setup();
  const payload = click(id, 'approve');
  await handleBlockAction({ ledger, cfg: CFG, payload, ...io, now: NOW });
  await handleBlockAction({ ledger, cfg: CFG, payload, ...io, now: NOW }); // identical retry
  assert.equal(ledger.dueIntents(FUTURE).length, 1);
});

test('a non-owner approve is refused with the owner named', async () => {
  const { ledger, id, calls, io } = setup();
  await handleBlockAction({
    ledger, cfg: CFG, payload: click(id, 'approve', 'U0INTRUDER'), ...io, now: NOW,
  });
  assert.match(calls.ephemeral.at(-1), /U0ADA/);
  assert.equal(ledger.getWorkItem(id).status, 'pending_approval');
});

test('a named override may approve for someone else', async () => {
  const { ledger, id, io } = setup();
  const cfg = structuredClone(CFG);
  cfg.approval_routing.approval_overrides = ['U0BOSS'];
  await handleBlockAction({ ledger, cfg, payload: click(id, 'approve', 'U0BOSS'), ...io, now: NOW });
  assert.equal(ledger.getWorkItem(id).status, 'undo_window');
});

test('approving an expired card refuses and applies nothing', async () => {
  const { ledger, calls, io } = setup();
  const stale = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: { subject: {}, steps: [{ channel: 'email', copy: 'x' }] },
    ownerProviderId: 'usr_ada', expiresAt: '2030-05-01T00:00:00Z',
  });
  await handleBlockAction({ ledger, cfg: CFG, payload: click(stale, 'approve'), ...io, now: NOW });
  assert.match(calls.ephemeral.at(-1), /expired/);
  assert.equal(ledger.effectiveDecision(stale), null);
});

// --- undo ---------------------------------------------------------------------

test('undo inside the window cancels the intent and restores the pending card', async () => {
  const { ledger, id, calls, io } = setup();
  await handleBlockAction({ ledger, cfg: CFG, payload: click(id, 'approve'), ...io, now: NOW });
  await handleBlockAction({ ledger, cfg: CFG, payload: click(id, 'undo'), ...io, now: NOW });
  assert.equal(ledger.getWorkItem(id).status, 'pending_approval');
  assert.equal(ledger.dueIntents(FUTURE).length, 0, 'the intent must never fire');
  assert.equal(ledger.effectiveDecision(id), null, 'undo newest means nothing stands');
  assert.equal(calls.updated.at(-1).status, 'pending_approval');
});

test('undo after the window closed refuses instead of pretending', async () => {
  const { ledger, id, calls, io } = setup();
  await handleBlockAction({ ledger, cfg: CFG, payload: click(id, 'approve'), ...io, now: NOW });
  ledger.cancelPendingIntent(id); // simulate: the applier already consumed it
  ledger.setWorkItemStatus(id, 'applying');
  await handleBlockAction({ ledger, cfg: CFG, payload: click(id, 'undo'), ...io, now: NOW });
  assert.match(calls.ephemeral.at(-1), /window already closed/);
});

// --- edit-approve submission --------------------------------------------------

test('an edit submission records the edits and opens the undo window', async () => {
  const { ledger, id, calls, io } = setup();
  await handleViewSubmission({
    ledger, cfg: CFG,
    payload: submission(id, 'edit_approve', { step_0: { copy: { value: 'the human rewrote this' } } }),
    ...io, now: NOW,
  });
  const d = ledger.effectiveDecision(id);
  assert.equal(d.decision, 'approve');
  assert.deepEqual(d.edits, { 0: 'the human rewrote this' });
  assert.equal(ledger.getWorkItem(id).status, 'undo_window');
});

// --- deny submission: instant, reasoned ---------------------------------------

test('a deny submission with a reason applies immediately — no undo window', async () => {
  const { ledger, id, calls, io } = setup();
  await handleViewSubmission({
    ledger, cfg: CFG,
    payload: submission(id, 'deny_reason', { reason: { text: { value: 'wrong angle' } } }),
    ...io, now: NOW,
  });
  const d = ledger.effectiveDecision(id);
  assert.equal(d.decision, 'deny');
  assert.equal(d.reason, 'wrong angle');
  assert.deepEqual(calls.applied, [id], 'denials apply instantly');
  assert.equal(ledger.dueIntents(FUTURE).length, 0, 'no intent for a denial');
});

test('a deny submission without a reason is refused', async () => {
  const { ledger, id, calls, io } = setup();
  await handleViewSubmission({
    ledger, cfg: CFG,
    payload: submission(id, 'deny_reason', { reason: { text: { value: '   ' } } }),
    ...io, now: NOW,
  });
  assert.match(calls.ephemeral.at(-1), /needs a reason/);
  assert.equal(ledger.effectiveDecision(id), null);
});

// --- fail-closed ownership ----------------------------------------------------

test('an item whose owner is not in config refuses every decision', () => {
  const ledger = openLedger(':memory:');
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: { subject: {}, steps: [] },
    ownerProviderId: 'usr_ghost', expiresAt: FUTURE,
  });
  const refusal = refuseUnlessOwner({ cfg: CFG, item: ledger.getWorkItem(id), clicker: 'U0ADA' });
  assert.match(refusal, /no slack_user_id/);
});

test('a malformed button value refuses rather than guesses', async () => {
  const { ledger, calls, io } = setup();
  await handleBlockAction({
    ledger, cfg: CFG,
    payload: { user: { id: 'U0ADA' }, trigger_id: 't', actions: [{ action_id: 'approve', value: 'not json' }] },
    ...io, now: NOW,
  });
  assert.match(calls.ephemeral.at(-1), /refusing to guess/);
});

// --- N4: crash after claimIntent must not eat the approval -------------------

test('an intent claimed then abandoned is recovered to pending on boot', () => {
  const ledger = openLedger(':memory:');
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: { subject: {}, steps: [{ channel: 'email', copy: 'x' }] },
    ownerProviderId: 'usr_ada', expiresAt: FUTURE,
  });
  const d = ledger.recordDecision({ workItemId: id, actorSlackId: 'U0ADA', decision: 'approve' });
  const intent = ledger.createIntent({ workItemId: id, decisionId: d.id });
  // Tick claims it, then the process dies before apply.
  assert.equal(ledger.claimIntent(intent.id), true);
  assert.equal(ledger.dueIntents(FUTURE).length, 0, 'a claimed (applying) intent is not due');
  // Boot recovery.
  assert.equal(ledger.recoverInflightIntents(), 1);
  assert.equal(ledger.dueIntents(FUTURE).length, 1, 'after recovery it is due again — approval not lost');
});
