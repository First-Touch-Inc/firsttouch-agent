// Tests for the cron evaluator and the Slack card builders.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, cronMatches, nextRun, dueSchedules, CronError } from '../runner/lib/schedule.mjs';
import {
  buildCard, buildEditModal, buildDenyModal, editsFromSubmission, cardForState,
} from '../runner/lib/cards.mjs';
import { openLedger } from '../runner/lib/ledger.mjs';

const TZ = 'America/New_York';

// --- cron parsing -------------------------------------------------------------

test('cron parses stars, lists, ranges and steps', () => {
  const p = parseCron('*/15 8-18 * * 1,3,5');
  assert.ok(p.minute.has(0) && p.minute.has(45) && !p.minute.has(7));
  assert.ok(p.hour.has(8) && p.hour.has(18) && !p.hour.has(19));
  assert.ok(p.dow.has(1) && p.dow.has(5) && !p.dow.has(2));
});

test('dow 7 is Sunday, same as 0', () => {
  const p = parseCron('0 8 * * 7');
  assert.ok(p.dow.has(0));
});

test('garbage is a CronError, not a silent never-fires', () => {
  assert.throws(() => parseCron('8am weekdays'), CronError);
  assert.throws(() => parseCron('0 25 * * *'), CronError);
  assert.throws(() => parseCron('0 8 * *'), CronError);
});

// --- timezone-aware matching --------------------------------------------------

test('8am in New York is 12:00 or 13:00 UTC depending on DST', () => {
  const p = parseCron('0 8 * * 1-5');
  // 2030-06-03 is a Monday; EDT is UTC-4, so 8am ET = 12:00 UTC.
  assert.ok(cronMatches(p, new Date('2030-06-03T12:00:00Z'), TZ), 'summer: 12:00Z is 8am ET');
  assert.ok(!cronMatches(p, new Date('2030-06-03T08:00:00Z'), TZ), '08:00Z is 4am ET — must not match');
  // 2030-12-02 is a Monday; EST is UTC-5, so 8am ET = 13:00 UTC.
  assert.ok(cronMatches(p, new Date('2030-12-02T13:00:00Z'), TZ), 'winter: 13:00Z is 8am ET');
});

test('weekday restriction follows the tenant timezone, not UTC', () => {
  const p = parseCron('30 23 * * 5'); // Friday 23:30 local
  // Friday 2030-06-07 23:30 ET = Saturday 03:30 UTC.
  assert.ok(cronMatches(p, new Date('2030-06-08T03:30:00Z'), TZ),
    'Saturday UTC is still Friday night in New York');
});

test('nextRun finds the following weekday morning', () => {
  // From Friday 9am ET (13:00Z summer), next "0 8 * * 1-5" is Monday 8am ET.
  const next = nextRun('0 8 * * 1-5', new Date('2030-06-07T13:00:00Z'), TZ);
  assert.equal(next.toISOString(), '2030-06-10T12:00:00.000Z');
});

// --- due-check behaviour ------------------------------------------------------

test('a schedule that fired already is not due again until its next window', () => {
  const schedules = [{ key: 'outbound', expr: '0 8 * * 1-5' }];
  const fired = { outbound: '2030-06-03T12:00:00.000Z' }; // fired this morning
  const due = dueSchedules(schedules, {
    now: new Date('2030-06-03T15:00:00Z'), timeZone: TZ,
    lastFiredBy: (k) => fired[k],
  });
  assert.equal(due.length, 0);
});

test('a schedule missed while the host was down IS due after restart', () => {
  const schedules = [{ key: 'outbound', expr: '0 8 * * 1-5' }];
  const fired = { outbound: '2030-06-02T12:00:00.000Z' }; // yesterday (Sunday: last fire Friday realistically, but any past fire works)
  const due = dueSchedules(schedules, {
    now: new Date('2030-06-03T15:00:00Z'), timeZone: TZ,   // Monday 11am ET
    lastFiredBy: (k) => fired[k],
  });
  assert.equal(due.length, 1, 'the 8am window passed while down — it must fire now');
});

test('a never-fired schedule does not thunder through history on first boot', () => {
  const schedules = [{ key: 'outbound', expr: '0 8 * * 1-5' }];
  const due = dueSchedules(schedules, {
    now: new Date('2030-06-03T15:00:00Z'), timeZone: TZ,  // hours after 8am
    lastFiredBy: () => null,
  });
  assert.equal(due.length, 0, 'first boot must not replay old windows');
  const dueAtWindow = dueSchedules(schedules, {
    now: new Date('2030-06-03T12:03:00Z'), timeZone: TZ,  // 8:03am ET
    lastFiredBy: () => null,
  });
  assert.equal(dueAtWindow.length, 1, 'but a window just now does fire');
});

// --- cards: the opaque-id rule ------------------------------------------------

const CFG = {
  motions: [
    { id: 'outbound', kind: 'outbound' },
    { id: 'deal-followup', kind: 'deal_followup' },
  ],
};

function makeItem(overrides = {}) {
  const ledger = openLedger(':memory:');
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: {
      subject: { name: 'Jamie Rivers', title: 'VP Sales', company: 'Acme', email: 'jamie@acme.com' },
      why: 'Started six weeks ago',
      steps: [
        { channel: 'email', copy: 'Draft one' },
        { channel: 'linkedin', copy: 'Draft two' },
      ],
      ...overrides.payload,
    },
    ownerProviderId: 'usr_ada',
    expiresAt: '2030-06-04T12:00:00.000Z',
  });
  return { ledger, item: { ...ledger.getWorkItem(id), ...overrides.item } };
}

test('button values carry ONLY the opaque work item id', () => {
  const { item } = makeItem();
  const blocks = buildCard(item, { cfg: CFG, ownerSlackId: 'U0ADA' });
  const actions = blocks.find((b) => b.type === 'actions');
  for (const el of actions.elements) {
    const parsed = JSON.parse(el.value);
    assert.deepEqual(Object.keys(parsed), ['w'], `${el.action_id} may carry only {w}`);
    assert.equal(parsed.w, item.id);
  }
  const whole = JSON.stringify(blocks);
  assert.ok(!whole.includes('usr_ada'), 'provider ids must not round-trip through Slack');
  assert.ok(!whole.includes('FT_MCP_TOKEN'));
});

test('the card names the sender, shows the full copy, and badges the motion', () => {
  const { item } = makeItem();
  const s = JSON.stringify(buildCard(item, { cfg: CFG, ownerSlackId: 'U0ADA' }));
  assert.match(s, /U0ADA/);
  assert.match(s, /Only they can approve/);
  assert.match(s, /Draft one/);
  assert.match(s, /Draft two/);
  assert.match(s, /\[Outbound\]/);
});

test('a report card has no buttons and no sender line', () => {
  const ledger = openLedger(':memory:');
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'report',
    payload: { lines: ['3 skipped for suppression'] },
    expiresAt: '2030-06-04T12:00:00.000Z',
  });
  const blocks = buildCard(ledger.getWorkItem(id), { cfg: CFG, ownerSlackId: null });
  assert.equal(blocks.find((b) => b.type === 'actions'), undefined);
});

test('a campaign card states audience, exclusions and the drip honestly', () => {
  const { item } = makeItem({
    payload: {
      campaign: {
        name: 'closed-lost win-back', why: 'discount',
        steps: [{ channel: 'email', copy: 'We are running a discount…' }],
        admitted: Array.from({ length: 12 }, (_, i) => ({
          subject: { email: `p${i}@x.com` }, subject_id: `s${i}`,
        })),
        excluded: [
          { subject: 'a@dead.com', reason: 'suppressed: closed lost' },
          { subject: 'b@x.com', reason: 'duplicate within audience' },
        ],
      },
    },
  });
  const s = JSON.stringify(buildCard(item, { cfg: CFG, ownerSlackId: 'U0ADA' }));
  assert.match(s, /12 contacts/);
  assert.match(s, /2 excluded/);
  assert.match(s, /1 suppressed, 1 duplicates/);
  assert.match(s, /re-screened at send time/);
  assert.match(s, /Approve all 12/);
});

// --- modals -------------------------------------------------------------------

test('the edit modal prefills one input per step and carries only the opaque id', () => {
  const { item } = makeItem();
  const view = buildEditModal(item);
  assert.equal(view.blocks.length, 2);
  assert.equal(view.blocks[0].element.initial_value, 'Draft one');
  assert.equal(view.blocks[1].element.initial_value, 'Draft two');
  assert.deepEqual(Object.keys(JSON.parse(view.private_metadata)), ['w']);
});

test('the deny modal requires a reason field', () => {
  const { item } = makeItem();
  const view = buildDenyModal(item);
  assert.equal(view.blocks[0].type, 'input');
  assert.match(JSON.stringify(view), /learns from this/);
});

test('edits are extracted from a submission by step index', () => {
  const edits = editsFromSubmission({
    state: { values: {
      step_0: { copy: { value: 'rewritten' } },
      step_1: { copy: { value: 'Draft two' } },
    } },
  });
  assert.deepEqual(edits, { 0: 'rewritten', 1: 'Draft two' });
});

// --- state re-rendering -------------------------------------------------------

test('the undo-window card shows an Undo button and the apply time', () => {
  const { item } = makeItem({ item: { status: 'undo_window' } });
  const blocks = cardForState(item, {
    cfg: CFG, ownerSlackId: 'U0ADA',
    decision: { decision: 'approve', edits: { 0: 'x' } },
    applyAfter: '2030-06-01T12:00:45.000Z',
  });
  const s = JSON.stringify(blocks);
  assert.match(s, /Undo/);
  assert.match(s, /12:00:45/);
  assert.match(s, /edited/);
});

test('a denied card shows the reason; an expired card says nothing was applied', () => {
  const { item } = makeItem({ item: { status: 'denied' } });
  const denied = JSON.stringify(cardForState(item, {
    cfg: CFG, decision: { decision: 'deny', reason: 'wrong angle entirely' },
  }));
  assert.match(denied, /wrong angle entirely/);

  const { item: item2 } = makeItem({ item: { status: 'expired' } });
  const expired = JSON.stringify(cardForState(item2, { cfg: CFG }));
  assert.match(expired, /nothing was applied/i);
});
