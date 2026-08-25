// Tests for the apply path — the deterministic side of the approval loop.
//
// Each section pins an invariant that was a real production failure when it
// was convention instead of code: edit-before-complete, GET-first, compare-
// and-set, idempotent re-runs, expiry-never-applies-late, campaign re-screen.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../runner/lib/ledger.mjs';
import { applyWorkItem, applyCampaignTick, expireDueItems, mergeEdits } from '../runner/lib/apply.mjs';

const NOW = () => new Date('2030-06-01T12:00:00Z');
const FUTURE = '2030-06-04T12:00:00.000Z';

const CFG = {
  approval: { undo_seconds: 45, expiry_hours: 72 },
  flows: [{ id: 'flow_1', name: 'Welcome' }],
  limits: {
    per_day: 10, per_week: 50, per_contact_per_quarter: 5,
    per_company_per_quarter: 8, enrichment_credits_per_run: 5,
  },
};

/** A fake outreach platform that records calls and lets tests script state. */
function fakePlatform() {
  const state = {
    nextTaskIds: ['t1'],
    tasks: {},               // id -> {status, copy, owner_provider_id}
    calls: [],
    existing: null,
  };
  return {
    state,
    async findAction() { state.calls.push(['findAction']); return state.existing; },
    async createAction({ steps, ownerProviderId }) {
      state.calls.push(['createAction', steps.map((s) => s.copy), ownerProviderId]);
      const ids = state.nextTaskIds;
      ids.forEach((id, i) => {
        // The platform faithfully stores what it was given, unless a test
        // pre-seeded this task to simulate a mismatch.
        if (!state.tasks[id]) {
          state.tasks[id] = { status: 'open', copy: steps[i]?.copy, owner_provider_id: ownerProviderId };
        }
      });
      return { task_ids: ids };
    },
    async readTask(id) { state.calls.push(['readTask', id]); return state.tasks[id]; },
    async completeTask(id) {
      state.calls.push(['completeTask', id]);
      state.tasks[id].status = 'completed';
    },
    async cancelAction(ids) {
      state.calls.push(['cancelAction', ids]);
      for (const id of ids) state.tasks[id].status = 'cancelled';
    },
    async enrolFlow(args) { state.calls.push(['enrolFlow', args.flow_id]); },
  };
}

function fakeCrm(values = {}) {
  const state = { values, calls: [] };
  return {
    state,
    async readProperty({ object_id, field }) {
      state.calls.push(['read', object_id, field]);
      return state.values[`${object_id}.${field}`];
    },
    async updateProperty({ object_id, field, value }) {
      state.calls.push(['update', object_id, field, value]);
      state.values[`${object_id}.${field}`] = value;
    },
  };
}

function stageOutreach(ledger, { steps, ownerProviderId = 'usr_ada' } = {}) {
  return ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: {
      subject: { name: 'Jamie', email: 'jamie@acme.com' },
      why: 'hiring',
      steps: steps ?? [{ channel: 'email', copy: 'original draft' }],
    },
    ownerProviderId,
    expiresAt: FUTURE,
  });
}

function approve(ledger, id, { edits = null } = {}) {
  return ledger.recordDecision({ workItemId: id, actorSlackId: 'U0ADA', decision: 'approve', edits });
}

// --- mergeEdits ---------------------------------------------------------------

test('edits merge by step index; untouched steps keep the draft', () => {
  const steps = [{ channel: 'email', copy: 'a' }, { channel: 'email', copy: 'b' }];
  const merged = mergeEdits(steps, { 1: 'B edited' });
  assert.equal(merged[0].copy, 'a');
  assert.equal(merged[1].copy, 'B edited');
});

// --- the edit-before-complete invariant --------------------------------------

test('the platform holds the EDITED copy before any completion happens', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  const id = stageOutreach(ledger);
  approve(ledger, id, { edits: { 0: 'the human rewrote this' } });

  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform, crm: fakeCrm(), now: NOW });
  assert.equal(r.outcome, 'applied');

  const calls = platform.state.calls.map(([n]) => n);
  const createIdx = calls.indexOf('createAction');
  const completeIdx = calls.indexOf('completeTask');
  const readBetween = calls.slice(createIdx + 1, completeIdx).includes('readTask');
  assert.ok(createIdx < completeIdx, 'create must precede complete');
  assert.ok(readBetween, 'the copy must be read back and verified BETWEEN create and complete');
  assert.equal(platform.state.calls.find(([n]) => n === 'createAction')[1][0],
    'the human rewrote this', 'what was created is the edited copy');
});

test('a copy mismatch refuses completion — the edit cannot be silently lost', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  // The platform will hold something other than what we send (simulating the
  // write not sticking).
  platform.state.tasks.t1 = { status: 'open', copy: 'STALE ORIGINAL', owner_provider_id: 'usr_ada' };
  const id = stageOutreach(ledger);
  approve(ledger, id, { edits: { 0: 'edited' } });

  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform, crm: fakeCrm(), now: NOW });
  assert.equal(r.outcome, 'conflict');
  assert.match(r.detail, /edit cannot be silently lost/);
  assert.ok(!platform.state.calls.some(([n]) => n === 'completeTask'), 'nothing may complete');
});

test('a task on the wrong owner cancels everything and completes nothing', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  platform.state.tasks.t1 = { status: 'open', copy: 'original draft', owner_provider_id: 'usr_WRONG' };
  const id = stageOutreach(ledger);
  approve(ledger, id);

  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform, crm: fakeCrm(), now: NOW });
  assert.equal(r.outcome, 'conflict');
  assert.match(r.detail, /irreversible/);
  assert.ok(platform.state.calls.some(([n]) => n === 'cancelAction'));
  assert.ok(!platform.state.calls.some(([n]) => n === 'completeTask'));
});

// --- GET first ----------------------------------------------------------------

test('a task the queue already completed is not double-acted', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  platform.state.tasks.t1 = { status: 'completed', copy: 'original draft', owner_provider_id: 'usr_ada' };
  const id = stageOutreach(ledger);
  approve(ledger, id);

  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform, crm: fakeCrm(), now: NOW });
  assert.equal(r.outcome, 'applied');
  assert.ok(!platform.state.calls.some(([n]) => n === 'completeTask'),
    'the platform already completed it; we must not call complete again');
});

// --- idempotent re-run --------------------------------------------------------

test('re-applying the same decision creates nothing twice', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  const id = stageOutreach(ledger);
  approve(ledger, id);

  const first = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform, crm: fakeCrm(), now: NOW });
  assert.equal(first.outcome, 'applied');
  const second = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform, crm: fakeCrm(), now: NOW });
  assert.equal(second.outcome, 'noop', 'a terminal item never re-applies');
  assert.equal(platform.state.calls.filter(([n]) => n === 'createAction').length, 1);
});

test('a crash between create and complete resumes without a second create', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  const id = stageOutreach(ledger);
  const d = approve(ledger, id);

  // Simulate the crash: the create was claimed and performed, nothing completed.
  const { Ledger } = await import('../runner/lib/ledger.mjs');
  ledger.claimApply(Ledger.applyKey(id, d.id, 'create'), id, 'create');
  platform.state.existing = { task_ids: ['t1'] };
  platform.state.tasks.t1 = { status: 'open', copy: 'original draft', owner_provider_id: 'usr_ada' };

  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform, crm: fakeCrm(), now: NOW });
  assert.equal(r.outcome, 'applied');
  assert.ok(!platform.state.calls.some(([n]) => n === 'createAction'), 'must reuse the found action');
  assert.ok(platform.state.calls.some(([n]) => n === 'findAction'), 'must look before recreating');
});

// --- denial and expiry --------------------------------------------------------

test('a denial releases the touch reservation and applies nothing', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  const s = ledger.resolveSubject('person', { normalized_email: 'jamie@acme.com' });
  const reserve = ledger.reserveTouch({ subjectId: s, teammate: 'agent', channel: 'email', caps: { per_day: 1 } });
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: { subject: { email: 'jamie@acme.com' }, steps: [{ channel: 'email', copy: 'x' }], touch_id: reserve.touchId },
    ownerProviderId: 'usr_ada', expiresAt: FUTURE,
  });
  ledger.recordDecision({ workItemId: id, actorSlackId: 'U0ADA', decision: 'deny', reason: 'wrong angle' });

  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform, crm: fakeCrm(), now: NOW });
  assert.equal(r.outcome, 'denied');
  assert.equal(r.detail, 'wrong angle');
  assert.equal(platform.state.calls.length, 0);
  const again = ledger.reserveTouch({ subjectId: s, teammate: 'agent', channel: 'email', caps: { per_day: 1 } });
  assert.ok(again.ok, 'the denied touch must have been released');
});

test('an expired card is never applied late, even with a standing approval', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: { subject: {}, steps: [{ channel: 'email', copy: 'x' }] },
    ownerProviderId: 'usr_ada',
    expiresAt: '2030-05-01T00:00:00Z', // already past
  });
  approve(ledger, id);
  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform, crm: fakeCrm(), now: NOW });
  assert.equal(r.outcome, 'expired');
  assert.equal(platform.state.calls.length, 0, 'nothing may reach the platform');
});

test('expireDueItems sweeps pending items past their deadline', () => {
  const ledger = openLedger(':memory:');
  const stale = ledger.createWorkItem({
    teammate: 'agent', motion: 'm', kind: 'report', payload: { lines: [] },
    expiresAt: '2030-05-01T00:00:00Z',
  });
  const fresh = ledger.createWorkItem({
    teammate: 'agent', motion: 'm', kind: 'report', payload: { lines: [] },
    expiresAt: FUTURE,
  });
  const swept = expireDueItems(ledger, NOW);
  assert.deepEqual(swept, [stale]);
  assert.equal(ledger.getWorkItem(stale).status, 'expired');
  assert.equal(ledger.getWorkItem(fresh).status, 'pending_approval');
});

// --- CRM: compare-and-set -----------------------------------------------------

test('a CRM change applies when from matches, verifies the write, reports the arrow', async () => {
  const ledger = openLedger(':memory:');
  const crm = fakeCrm({ 'd1.dealstage': 'demo' });
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'deal-followup', kind: 'crm_change',
    payload: { changes: [{ object_type: 'deal', object_id: 'd1', field: 'dealstage', from: 'demo', to: 'negotiation' }] },
    ownerProviderId: 'usr_ada', expiresAt: FUTURE,
  });
  approve(ledger, id);
  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform: fakePlatform(), crm, now: NOW });
  assert.equal(r.outcome, 'applied');
  assert.match(r.detail, /demo → negotiation/);
  assert.equal(crm.state.values['d1.dealstage'], 'negotiation');
});

test('a value that is neither from nor to is NOT overwritten — their change wins', async () => {
  const ledger = openLedger(':memory:');
  const crm = fakeCrm({ 'd1.dealstage': 'closedwon' }); // a human moved it meanwhile
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'deal-followup', kind: 'crm_change',
    payload: { changes: [{ object_type: 'deal', object_id: 'd1', field: 'dealstage', from: 'demo', to: 'negotiation' }] },
    ownerProviderId: 'usr_ada', expiresAt: FUTURE,
  });
  approve(ledger, id);
  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform: fakePlatform(), crm, now: NOW });
  assert.match(r.detail, /their change wins/);
  assert.equal(crm.state.values['d1.dealstage'], 'closedwon', 'the human value must survive');
  assert.ok(!crm.state.calls.some(([n]) => n === 'update'));
});

test('a value already at target is a clean idempotent skip', async () => {
  const ledger = openLedger(':memory:');
  const crm = fakeCrm({ 'd1.closedate': '2030-09-01' });
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'deal-followup', kind: 'crm_change',
    payload: { changes: [{ object_type: 'deal', object_id: 'd1', field: 'closedate', from: '2030-07-01', to: '2030-09-01' }] },
    ownerProviderId: 'usr_ada', expiresAt: FUTURE,
  });
  approve(ledger, id);
  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform: fakePlatform(), crm, now: NOW });
  assert.equal(r.outcome, 'applied');
  assert.match(r.detail, /already 2030-09-01/);
  assert.ok(!crm.state.calls.some(([n]) => n === 'update'));
});

// --- flow enrolment: apply-time re-checks -------------------------------------

test('a flow removed from config after approval refuses at apply', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: { flow_enrolment: { flow_id: 'flow_gone', flow_name: 'Old' }, subject: { email: 'a@b.com' } },
    ownerProviderId: 'usr_ada', expiresAt: FUTURE,
  });
  approve(ledger, id);
  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform, crm: fakeCrm(), now: NOW });
  assert.equal(r.outcome, 'conflict');
  assert.match(r.detail, /no longer declared/);
  assert.ok(!platform.state.calls.some(([n]) => n === 'enrolFlow'));
});

test('a suppression added between approval and apply blocks the enrolment', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: { flow_enrolment: { flow_id: 'flow_1', flow_name: 'Welcome' }, subject: { email: 'a@late.com' } },
    ownerProviderId: 'usr_ada', expiresAt: FUTURE,
  });
  approve(ledger, id);
  ledger.suppress('domain', 'late.com', 'asked to stop', 'operator', null); // AFTER approval
  const r = await applyWorkItem({ ledger, cfg: CFG, workItemId: id, platform, crm: fakeCrm(), now: NOW });
  assert.equal(r.outcome, 'conflict');
  assert.match(r.detail, /suppressed since approval/);
  assert.ok(!platform.state.calls.some(([n]) => n === 'enrolFlow'));
});

// --- campaigns: drip under caps, re-screen at send ----------------------------

function stageCampaign(ledger, members) {
  return ledger.createWorkItem({
    teammate: 'agent', motion: 'chat', kind: 'outreach',
    payload: {
      campaign: {
        name: 'win-back', why: 'discount',
        steps: [{ channel: 'email', copy: 'We are running a discount…' }],
        admitted: members,
        excluded: [],
      },
    },
    ownerProviderId: 'usr_ada', expiresAt: FUTURE,
  });
}

test('a campaign drips under per_day and continues on the next tick', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  const members = ['a@one.com', 'b@two.com', 'c@three.com'].map((email) => ({
    subject: { email },
    subject_id: ledger.resolveSubject('person', { normalized_email: email }),
  }));
  const id = stageCampaign(ledger, members);
  approve(ledger, id);

  const cfg = { ...CFG, limits: { ...CFG.limits, per_day: 2 } };
  platform.state.nextTaskIds = ['tx'];
  // tick 1: two sends fit under per_day
  let item = ledger.getWorkItem(id);
  const t1 = await applyCampaignTick({ ledger, cfg, item, platform, now: NOW });
  assert.equal(t1.outcome, 'partial');
  assert.match(t1.detail, /daily caps reached/);

  // tick 2, next day: the third member goes out and the campaign completes
  const nextDay = () => new Date('2030-06-02T12:05:00Z');
  item = ledger.getWorkItem(id);
  const t2 = await applyCampaignTick({ ledger, cfg, item, platform, now: nextDay });
  assert.equal(t2.outcome, 'applied');
  assert.match(t2.detail, /campaign complete/);
});

test('a member suppressed after batch approval is skipped at send time', async () => {
  const ledger = openLedger(':memory:');
  const platform = fakePlatform();
  const members = [
    { subject: { email: 'ok@fine.com' }, subject_id: ledger.resolveSubject('person', { normalized_email: 'ok@fine.com' }) },
    { subject: { email: 'no@stop.com' }, subject_id: ledger.resolveSubject('person', { normalized_email: 'no@stop.com' }) },
  ];
  const id = stageCampaign(ledger, members);
  approve(ledger, id);
  ledger.suppress('domain', 'stop.com', 'unsubscribed', 'operator', null); // AFTER the batch approval

  const item = ledger.getWorkItem(id);
  const r = await applyCampaignTick({ ledger, cfg: CFG, item, platform, now: NOW });
  assert.equal(r.outcome, 'applied');
  assert.match(r.detail, /1 sent this tick, 1 skipped/);
});
