// Tests for the auto-learning pass.
//
// The founder's requirement: study the diffs between drafts and what humans
// actually sent, and auto-learn. The safety property pinned here: the inputs
// are exclusively human-typed (edits + deny reasons), the model only proposes
// structured rules, and deterministic host code decides what is inserted.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../runner/lib/ledger.mjs';
import { collectEvidence, distillLessons } from '../runner/lib/distill.mjs';

const FUTURE = '2999-01-01T00:00:00Z';
const CFG = {};

function seedDecisions(ledger, n = 4) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = ledger.createWorkItem({
      teammate: 'agent', motion: 'outbound', kind: 'outreach',
      payload: {
        subject: { email: `p${i}@x.com` },
        steps: [{ channel: 'email', copy: `Quick question — original long opener number ${i} with lots of words` }],
      },
      ownerProviderId: 'usr_ada', expiresAt: FUTURE,
    });
    ledger.recordDecision({
      workItemId: id, actorSlackId: 'U0ADA', decision: 'approve',
      edits: { 0: `Short opener ${i}` },
    });
    ids.push(id);
  }
  return ids;
}

// --- evidence collection ------------------------------------------------------

test('evidence pairs originals with edits and carries deny reasons', () => {
  const ledger = openLedger(':memory:');
  seedDecisions(ledger, 2);
  const denyId = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: { subject: {}, steps: [{ channel: 'email', copy: 'x' }] },
    ownerProviderId: 'usr_ada', expiresAt: FUTURE,
  });
  ledger.recordDecision({ workItemId: denyId, actorSlackId: 'U0ADA', decision: 'deny', reason: 'never stack hooks' });

  const { evidence } = collectEvidence(ledger, 0);
  assert.equal(evidence.length, 3);
  const edit = evidence.find((e) => e.kind === 'edit');
  assert.match(edit.original, /original long opener/);
  assert.match(edit.edited, /Short opener/);
  assert.equal(evidence.find((e) => e.kind === 'deny').reason, 'never stack hooks');
});

test('an approve with no edits and no reason is not evidence', () => {
  const ledger = openLedger(':memory:');
  const id = ledger.createWorkItem({
    teammate: 'agent', motion: 'outbound', kind: 'outreach',
    payload: { subject: {}, steps: [{ channel: 'email', copy: 'x' }] },
    ownerProviderId: 'usr_ada', expiresAt: FUTURE,
  });
  ledger.recordDecision({ workItemId: id, actorSlackId: 'U0ADA', decision: 'approve' });
  assert.equal(collectEvidence(ledger, 0).evidence.length, 0);
});

// --- the pass -----------------------------------------------------------------

test('below the minimum sample the pass waits instead of generalising from one edit', async () => {
  const ledger = openLedger(':memory:');
  seedDecisions(ledger, 1);
  let spawned = false;
  const r = await distillLessons({
    ledger, cfg: CFG,
    queueSpawn: async () => { spawned = true; return { result: '[]' }; },
    announce: async () => {},
  });
  assert.equal(r.distilled, 0);
  assert.equal(spawned, false, 'no model turn on a single data point');
});

test('valid proposed rules are inserted, scoped, announced, and applied to lessons', async () => {
  const ledger = openLedger(':memory:');
  seedDecisions(ledger, 4);
  const announced = [];
  const r = await distillLessons({
    ledger, cfg: CFG,
    queueSpawn: async ({ prompt, mode }) => {
      assert.equal(mode, 'distill');
      assert.match(prompt, /PATTERNS ONLY/);
      return {
        result: JSON.stringify([
          { scope: 'voice', rule: 'Keep openers under 10 words', evidence: '4 of 4 edits shortened the opener' },
          { scope: 'not_a_scope', rule: 'bad', evidence: 'x' },        // must be dropped
          { scope: 'voice', rule: '', evidence: 'empty rule' },          // must be dropped
        ]),
      };
    },
    announce: async (text) => announced.push(text),
  });
  assert.equal(r.distilled, 1);
  const rules = ledger.activeLessons('agent').map((l) => l.rule);
  assert.deepEqual(rules, ['Keep openers under 10 words']);
  assert.equal(announced.length, 1);
  assert.match(announced[0], /Learned \[voice\]/);
  assert.match(announced[0], /4 of 4 edits/);
});

test('prose around the JSON is tolerated; garbage yields zero rules, not a crash', async () => {
  const ledger = openLedger(':memory:');
  seedDecisions(ledger, 3);
  const r = await distillLessons({
    ledger, cfg: CFG,
    queueSpawn: async () => ({ result: 'Here are the rules:\n[{"scope":"voice","rule":"No emojis","evidence":"3 denials mention them"}]\nHope that helps!' }),
    announce: async () => {},
  });
  assert.equal(r.distilled, 1);

  const ledger2 = openLedger(':memory:');
  seedDecisions(ledger2, 3);
  const r2 = await distillLessons({
    ledger: ledger2, cfg: CFG,
    queueSpawn: async () => ({ result: 'I could not find any patterns worth extracting.' }),
    announce: async () => {},
  });
  assert.equal(r2.distilled, 0);
});

test('the watermark advances so the same corrections are never re-litigated', async () => {
  const ledger = openLedger(':memory:');
  seedDecisions(ledger, 3);
  let turns = 0;
  const spawn = async () => { turns++; return { result: '[]' }; };
  await distillLessons({ ledger, cfg: CFG, queueSpawn: spawn, announce: async () => {} });
  const again = await distillLessons({ ledger, cfg: CFG, queueSpawn: spawn, announce: async () => {} });
  assert.equal(turns, 1, 'the second pass has nothing new and must not spawn');
  assert.equal(again.waiting, 0);
});

test('an identical active rule is not inserted twice', async () => {
  const ledger = openLedger(':memory:');
  ledger.addLesson({ teammate: 'agent', scope: 'voice', rule: 'No emojis', evidence: 'earlier pass' });
  seedDecisions(ledger, 3);
  const r = await distillLessons({
    ledger, cfg: CFG,
    queueSpawn: async () => ({ result: '[{"scope":"voice","rule":"no emojis","evidence":"again"}]' }),
    announce: async () => {},
  });
  assert.equal(r.distilled, 0, 'case-insensitive duplicate must be dropped');
  assert.equal(ledger.activeLessons('agent').length, 1);
});
