// The scheduler decides when an agent wakes up inside someone's infra — the
// cron parsing and due-check get pinned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, cronMatches, nextRun, dueSchedules, CronError } from '../host/lib/cron.mjs';

test('a weekday-morning cron matches the right instants', () => {
  const c = parseCron('0 8 * * 1-5');
  // 2026-08-26 is a Wednesday.
  assert.equal(cronMatches(c, new Date('2026-08-26T12:00:00Z'), 'America/New_York'), true);  // 08:00 ET
  assert.equal(cronMatches(c, new Date('2026-08-26T12:01:00Z'), 'America/New_York'), false); // 08:01
  assert.equal(cronMatches(c, new Date('2026-08-29T12:00:00Z'), 'America/New_York'), false); // Saturday
});

test('garbage is a CronError, not a silent never-fires', () => {
  assert.throws(() => parseCron('not a cron'), CronError);
  assert.throws(() => parseCron('99 8 * * *'), CronError);
});

test('nextRun finds the following firing', () => {
  const next = nextRun('0 8 * * 1-5', new Date('2026-08-28T20:00:00Z'), 'America/New_York'); // Friday evening
  assert.equal(next.toISOString(), '2026-08-31T12:00:00.000Z'); // Monday 08:00 ET
});

test('dueSchedules fires once per window and never replays history', () => {
  const schedules = [{ key: 'daily', expr: parseCron('0 8 * * *') }];
  const now = new Date('2026-08-26T12:00:30Z'); // just past 08:00 ET
  // Never fired: due within the grace window.
  const first = dueSchedules(schedules, { now, timeZone: 'America/New_York', lastFiredBy: () => null });
  assert.equal(first.length, 1);
  // Fired for this window already: not due again.
  const again = dueSchedules(schedules, {
    now, timeZone: 'America/New_York',
    lastFiredBy: () => first[0].firedFor.toISOString(),
  });
  assert.equal(again.length, 0);
});
