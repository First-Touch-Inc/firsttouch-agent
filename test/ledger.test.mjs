// Tests for the shared ledger. Each section pins a behaviour that broke in
// production under the old JSONL state, or a behaviour the two-teammate split
// newly requires (claims, cross-teammate suppression, shared counters).
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, Ledger, normalizeEmail, registrableDomain } from '../runner/lib/ledger.mjs';

const mem = () => openLedger(':memory:');
const FUTURE = '2999-01-01T00:00:00Z';

// --- identity graph ----------------------------------------------------------

test('the same person found by different aliases is one subject', () => {
  const L = mem();
  const a = L.resolveSubject('person', { normalized_email: 'sam@acme.com' });
  const b = L.resolveSubject('person', { crm_contact_id: '123', normalized_email: 'sam@acme.com' });
  const c = L.resolveSubject('person', { crm_contact_id: '123' });
  assert.equal(a, b);
  assert.equal(b, c);
});

test('two subjects that turn out to be the same person converge', () => {
  const L = mem();
  const byEmail = L.resolveSubject('person', { normalized_email: 'sam@acme.com' });
  const byCrm = L.resolveSubject('person', { crm_contact_id: '99' });
  assert.notEqual(byEmail, byCrm);
  // A later sweep sees both aliases on one record.
  const merged = L.resolveSubject('person', {
    normalized_email: 'sam@acme.com', crm_contact_id: '99',
  });
  assert.equal(merged, byEmail, 'the oldest subject id wins');
  assert.equal(L.resolveSubject('person', { crm_contact_id: '99' }), byEmail,
    'the newer alias now points at the surviving subject');
});

test('registrable domain handles urls, emails and co.uk-style affixes', () => {
  assert.equal(registrableDomain('https://www.acme.com/about'), 'acme.com');
  assert.equal(registrableDomain('sam@mail.acme.co.uk'), 'acme.co.uk');
  assert.equal(registrableDomain('acme.io'), 'acme.io');
  assert.equal(registrableDomain('not-a-domain'), null);
  assert.equal(normalizeEmail(' MAILTO:Sam@Acme.com '), 'sam@acme.com');
});

// --- claims: the collision guard between teammates ---------------------------

test('a live claim by one teammate is visible to another', () => {
  const L = mem();
  const s = L.resolveSubject('person', { normalized_email: 'sam@acme.com' });
  L.claim(s, 'deal-desk', 'owned', FUTURE);
  const claim = L.liveClaim(s);
  assert.equal(claim.teammate, 'deal-desk');
});

test('an expired claim is treated as absent', () => {
  const L = mem();
  const s = L.resolveSubject('person', { normalized_email: 'sam@acme.com' });
  L.claim(s, 'deal-desk', 'owned', '2001-01-01T00:00:00Z');
  assert.equal(L.liveClaim(s), null);
});

// --- suppression: both directions, including the no-CRM-record backstop ------

test('a dead account suppresses by domain even for a person with no CRM record', () => {
  const L = mem();
  // deal-desk marks acme dead. The person surfaced tomorrow from a signal feed
  // has no CRM record and a DIFFERENT email — only the domain connects them.
  L.suppress('domain', 'acme.com', 'closed lost', 'deal-desk', FUTURE);
  const hit = L.suppressionFor({ email: 'someone.new@acme.com' });
  assert.ok(hit);
  assert.equal(hit.reason, 'closed lost');
});

test('suppression also catches via the company domain when the email is personal', () => {
  const L = mem();
  L.suppress('domain', 'acme.com', 'asked to stop', 'operator', null);
  const hit = L.suppressionFor({ email: 'sam@gmail.com', companyDomain: 'https://acme.com' });
  assert.ok(hit, 'company domain must be checked, not just the email domain');
});

test('an expired suppression no longer fires; a null until_at never expires', () => {
  const L = mem();
  L.suppress('domain', 'old.com', 'cooldown', 'outbound', '2001-01-01T00:00:00Z');
  L.suppress('domain', 'forever.com', 'DNC', 'operator', null);
  assert.equal(L.suppressionFor({ email: 'x@old.com' }), null);
  assert.ok(L.suppressionFor({ email: 'x@forever.com' }));
});

// --- touches: caps are shared across teammates -------------------------------

test('a prospect does not care which teammate wrote to them: caps are shared', () => {
  const L = mem();
  const s = L.resolveSubject('person', { normalized_email: 'sam@acme.com' });
  const caps = { per_contact_per_quarter: 1 };
  const first = L.reserveTouch({ subjectId: s, teammate: 'outbound', channel: 'email', caps });
  assert.ok(first.ok);
  const second = L.reserveTouch({ subjectId: s, teammate: 'deal-desk', channel: 'email', caps });
  assert.equal(second.ok, false);
  assert.equal(second.cap, 'per_contact_per_quarter');
});

test('a released reservation gives the slot back; a confirmed one does not', () => {
  const L = mem();
  const s = L.resolveSubject('person', { normalized_email: 'a@x.com' });
  const caps = { per_day: 1 };
  const r1 = L.reserveTouch({ subjectId: s, teammate: 'outbound', channel: 'email', caps });
  assert.ok(r1.ok);
  assert.equal(L.reserveTouch({ subjectId: s, teammate: 'outbound', channel: 'email', caps }).ok,
    false, 'cap is hit while reserved');
  L.releaseTouch(r1.touchId);
  const r2 = L.reserveTouch({ subjectId: s, teammate: 'outbound', channel: 'email', caps });
  assert.ok(r2.ok, 'denial released the slot');
  L.confirmTouch(r2.touchId);
  L.releaseTouch(r2.touchId); // releasing a confirmed touch is a no-op
  assert.equal(L.reserveTouch({ subjectId: s, teammate: 'outbound', channel: 'email', caps }).ok,
    false, 'a confirmed touch cannot be released back');
});

test('an unconfirmed reservation expires on its TTL', () => {
  const L = mem();
  const s = L.resolveSubject('person', { normalized_email: 'a@x.com' });
  const caps = { per_day: 1 };
  const t0 = '2030-01-01T00:00:00.000Z';
  const r = L.reserveTouch({ subjectId: s, teammate: 'outbound', channel: 'email', caps, ttlMinutes: 60 },
    t0);
  assert.ok(r.ok);
  const later = '2030-01-01T02:00:00.000Z';
  const r2 = L.reserveTouch({ subjectId: s, teammate: 'outbound', channel: 'email', caps }, later);
  assert.ok(r2.ok, 'the stale reservation was released by TTL');
});

// --- work items and the owner rule -------------------------------------------

test('a non-report work item without an owner is refused at creation', () => {
  const L = mem();
  assert.throws(
    () => L.createWorkItem({
      teammate: 'outbound', motion: 'm', kind: 'outreach',
      payload: {}, expiresAt: FUTURE,
    }),
    /explicit owner/);
  // A report is the one kind that legitimately has no sender.
  const id = L.createWorkItem({
    teammate: 'outbound', motion: 'm', kind: 'report', payload: { lines: [] }, expiresAt: FUTURE,
  });
  assert.ok(L.getWorkItem(id));
});

// --- decisions: append-only, newest wins, undo folds in ----------------------

test('a denial without a reason is refused', () => {
  const L = mem();
  const id = L.createWorkItem({
    teammate: 'outbound', motion: 'm', kind: 'outreach', payload: {},
    ownerProviderId: 'usr_1', expiresAt: FUTURE,
  });
  assert.throws(
    () => L.recordDecision({ workItemId: id, actorSlackId: 'U1', decision: 'deny' }),
    /reason/);
});

test('a Slack retry of the same event does not double-record', () => {
  const L = mem();
  const id = L.createWorkItem({
    teammate: 'outbound', motion: 'm', kind: 'outreach', payload: {},
    ownerProviderId: 'usr_1', expiresAt: FUTURE,
  });
  const d1 = L.recordDecision({
    workItemId: id, actorSlackId: 'U1', decision: 'approve', slackEventId: 'ev_1' });
  const d2 = L.recordDecision({
    workItemId: id, actorSlackId: 'U1', decision: 'approve', slackEventId: 'ev_1' });
  assert.equal(d1.duplicate, false);
  assert.equal(d2.duplicate, true);
  assert.equal(d1.id, d2.id);
});

test('an undo newer than an approve means nothing stands', () => {
  const L = mem();
  const id = L.createWorkItem({
    teammate: 'outbound', motion: 'm', kind: 'outreach', payload: {},
    ownerProviderId: 'usr_1', expiresAt: FUTURE,
  });
  L.recordDecision({ workItemId: id, actorSlackId: 'U1', decision: 'approve' });
  L.recordDecision({ workItemId: id, actorSlackId: 'U1', decision: 'undo' });
  assert.equal(L.effectiveDecision(id), null);
});

test('an approve newer than an undo stands, with its edits', () => {
  const L = mem();
  const id = L.createWorkItem({
    teammate: 'outbound', motion: 'm', kind: 'outreach', payload: {},
    ownerProviderId: 'usr_1', expiresAt: FUTURE,
  });
  L.recordDecision({ workItemId: id, actorSlackId: 'U1', decision: 'approve' });
  L.recordDecision({ workItemId: id, actorSlackId: 'U1', decision: 'undo' });
  L.recordDecision({
    workItemId: id, actorSlackId: 'U1', decision: 'approve', edits: { s1: 'new copy' } });
  const eff = L.effectiveDecision(id);
  assert.equal(eff.decision, 'approve');
  assert.deepEqual(eff.edits, { s1: 'new copy' });
});

// --- intents: the undo window is durable, not a setTimeout -------------------

test('an intent is not due inside the window and is due after it', () => {
  const L = mem();
  const id = L.createWorkItem({
    teammate: 'outbound', motion: 'm', kind: 'outreach', payload: {},
    ownerProviderId: 'usr_1', expiresAt: FUTURE,
  });
  const d = L.recordDecision({ workItemId: id, actorSlackId: 'U1', decision: 'approve' });
  const t0 = '2030-01-01T00:00:00.000Z';
  L.createIntent({ workItemId: id, decisionId: d.id, undoSeconds: 45 }, t0);
  assert.equal(L.dueIntents('2030-01-01T00:00:30.000Z').length, 0, 'inside the window');
  assert.equal(L.dueIntents('2030-01-01T00:00:46.000Z').length, 1, 'after the window');
});

test('an undo click cancels the pending intent exactly once', () => {
  const L = mem();
  const id = L.createWorkItem({
    teammate: 'outbound', motion: 'm', kind: 'outreach', payload: {},
    ownerProviderId: 'usr_1', expiresAt: FUTURE,
  });
  const d = L.recordDecision({ workItemId: id, actorSlackId: 'U1', decision: 'approve' });
  L.createIntent({ workItemId: id, decisionId: d.id });
  assert.equal(L.cancelPendingIntent(id), true);
  assert.equal(L.cancelPendingIntent(id), false, 'the window already closed');
  assert.equal(L.dueIntents(FUTURE).length, 0, 'a cancelled intent never fires');
});

// --- idempotent apply --------------------------------------------------------

test('the same apply_key claims exactly once, across simulated re-runs', () => {
  const L = mem();
  const key = Ledger.applyKey('wi_1', 'dec_1', 'complete:task_9');
  assert.equal(L.claimApply(key, 'wi_1', 'complete:task_9'), true, 'first run does the work');
  assert.equal(L.claimApply(key, 'wi_1', 'complete:task_9'), false, 're-run is a no-op');
  const other = Ledger.applyKey('wi_1', 'dec_1', 'complete:task_10');
  assert.equal(L.claimApply(other, 'wi_1', 'complete:task_10'), true,
    'a different action within the same decision is separate');
});

// --- lessons: host-written, superseded not deleted ---------------------------

test('a superseded lesson stops applying; scoping keeps teammates apart', () => {
  const L = mem();
  const old = L.addLesson({
    teammate: 'outbound', scope: 'voice', rule: 'max 90 words', evidence: 'edit on 2026-08-01' });
  L.addLesson({
    teammate: 'outbound', scope: 'voice', rule: 'max 70 words',
    evidence: 'edit on 2026-08-20', supersedes: old });
  L.addLesson({
    teammate: 'deal-desk', scope: 'deal_judgment', rule: 'never move stage on silence',
    evidence: 'deny on 2026-08-21' });
  L.addLesson({
    teammate: 'shared', scope: 'positioning', rule: 'lead with the agent angle',
    evidence: 'promoted 2026-08-22' });

  const outbound = L.activeLessons('outbound').map((l) => l.rule);
  assert.deepEqual(outbound, ['max 70 words', 'lead with the agent angle'],
    'superseded rule gone, shared rule included, other teammate excluded');
  const dealDesk = L.activeLessons('deal-desk').map((l) => l.rule);
  assert.deepEqual(dealDesk, ['never move stage on silence', 'lead with the agent angle']);
});

// --- watermarks --------------------------------------------------------------

test('watermarks are per teammate per source', () => {
  const L = mem();
  L.setWatermark('outbound', 'signal_feed', '2026-08-24T00:00:00Z');
  L.setWatermark('outbound', 'signal_feed', '2026-08-25T00:00:00Z');
  assert.equal(L.getWatermark('outbound', 'signal_feed'), '2026-08-25T00:00:00Z');
  assert.equal(L.getWatermark('deal-desk', 'signal_feed'), null);
});
