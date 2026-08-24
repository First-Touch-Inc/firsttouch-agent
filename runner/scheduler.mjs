#!/usr/bin/env node
// A minimal scheduler for hosts that have no cron of their own.
//
//   CRON_SCHEDULE="0 8 * * 1-5" node runner/scheduler.mjs
//
// PREFER YOUR PLATFORM'S NATIVE CRON. Railway, Render and most VPS setups run
// a scheduled job as a process that starts, works and exits — which is cheaper
// (no idle container), safer (the platform guarantees one run at a time), and
// observable in their dashboard. This file exists for Fly.io and bare Docker,
// where that is not on offer.
//
// Deliberately dependency-free: a cron parser is a small amount of code and one
// less supply-chain surface in a container that holds CRM credentials.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'run-daily.mjs');

const SPEC = process.env.CRON_SCHEDULE || '0 8 * * 1-5';
const log = (...a) => console.log(`[scheduler ${new Date().toISOString()}]`, ...a);

// --- a small 5-field cron matcher -------------------------------------------
// Supports: * , - / and numeric ranges. Day-of-week 0 and 7 both mean Sunday.
// Not supported: @macros, L, W, #, named months/days. Use a real cron for those.
function parseField(spec, min, max, label) {
  const values = new Set();
  for (const part of String(spec).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step "${stepRaw}" in ${label}`);

    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      lo = a; hi = b;
    } else {
      lo = hi = Number(range);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`bad range "${range}" in ${label} (expected ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

function parseCron(spec) {
  const f = String(spec).trim().split(/\s+/);
  if (f.length !== 5) {
    throw new Error(`CRON_SCHEDULE must have 5 fields (minute hour day month weekday), got ${f.length}: "${spec}"`);
  }
  const dow = parseField(f[4], 0, 7, 'weekday');
  if (dow.has(7)) dow.add(0);
  return {
    minute: parseField(f[0], 0, 59, 'minute'),
    hour: parseField(f[1], 0, 23, 'hour'),
    day: parseField(f[2], 1, 31, 'day'),
    month: parseField(f[3], 1, 12, 'month'),
    dow,
  };
}

const matches = (c, d) =>
  c.minute.has(d.getMinutes()) &&
  c.hour.has(d.getHours()) &&
  c.day.has(d.getDate()) &&
  c.month.has(d.getMonth() + 1) &&
  c.dow.has(d.getDay());

let cron;
try {
  cron = parseCron(SPEC);
} catch (e) {
  console.error(`[scheduler] ${e.message}`);
  process.exit(2);
}

// --- run control -------------------------------------------------------------
// One run at a time, always. A daily pipeline sweep that overlaps itself would
// double-contact people, which is exactly the failure the ledger exists to
// prevent — and the ledger is written at the END of a run, so two concurrent
// runs would not see each other's work.
let running = false;

function runOnce(reason) {
  if (running) {
    log(`skipping ${reason} — the previous run has not finished`);
    return;
  }
  running = true;
  log(`starting run (${reason})`);
  const child = spawn(process.execPath, [RUNNER], { stdio: 'inherit', cwd: resolve(HERE, '..') });
  child.on('close', (code) => {
    running = false;
    log(code === 0 ? 'run finished' : `run FAILED with exit code ${code}`);
  });
  child.on('error', (err) => {
    running = false;
    log(`could not start the run: ${err.message}`);
  });
}

log(`schedule "${SPEC}" · timezone ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
log('waiting. Set RUN_ON_START=1 to also run immediately on boot.');
if (process.env.RUN_ON_START === '1') runOnce('RUN_ON_START');

// Tick once a minute, aligned to the start of the minute so a run does not
// drift or fire twice within the same minute.
let lastFired = null;
setInterval(() => {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (stamp === lastFired) return;
  if (matches(cron, now)) {
    lastFired = stamp;
    runOnce(`schedule ${SPEC}`);
  }
}, 20_000);

// Exit cleanly so `docker stop` does not take ten seconds.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    process.exit(0);
  });
}
