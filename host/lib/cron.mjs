// A small five-field cron: minute hour day-of-month month day-of-week,
// evaluated in the tenant's IANA timezone. Zero dependencies, on purpose —
// this decides when an outbound agent wakes up inside a customer's infra.
//
// Supported per field: "*", numbers, lists "1,3,5", ranges "1-5", steps "*/15"
// and "8-18/2". Day-of-week: 0-7 where both 0 and 7 are Sunday. When both
// day-of-month and day-of-week are restricted, matching either fires (the
// classic vixie-cron OR rule).
//
// The evaluator walks forward minute by minute (bounded), asking "do this
// instant's wall-clock parts in the tenant's timezone match?" — which makes
// DST handling Intl's problem, not ours: a skipped hour simply never matches,
// a repeated hour matches twice, and both are the least surprising behavior.

const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 7 },
];

export class CronError extends Error {}

function parseField(spec, { name, min, max }) {
  const values = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new CronError(`cron ${name} field "${part}" is not valid`);
    const [, rangeSpec, stepSpec] = m;
    const step = stepSpec ? parseInt(stepSpec, 10) : 1;
    if (step < 1) throw new CronError(`cron ${name} step must be >= 1`);

    let lo, hi;
    if (rangeSpec === '*') {
      lo = min; hi = max;
    } else if (rangeSpec.includes('-')) {
      [lo, hi] = rangeSpec.split('-').map((n) => parseInt(n, 10));
    } else {
      lo = hi = parseInt(rangeSpec, 10);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new CronError(`cron ${name} "${part}" is outside ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (name === 'dow' && values.has(7)) values.add(0); // 7 is also Sunday
  return values;
}

export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(`"${expr}" is not a five-field cron line`);
  }
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, FIELD_RANGES[i]));
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';
  return { minute, hour, dom, month, dow, domRestricted, dowRestricted };
}

const DOW_NAMES = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();

/** Wall-clock parts of an instant in a timezone. */
export function zonedParts(date, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      minute: 'numeric', hour: 'numeric', day: 'numeric',
      month: 'numeric', weekday: 'short',
    });
    formatters.set(timeZone, fmt);
  }
  const parts = {};
  for (const { type, value } of fmt.formatToParts(date)) parts[type] = value;
  return {
    minute: parseInt(parts.minute, 10),
    hour: parseInt(parts.hour, 10) % 24, // Intl can emit 24 for midnight
    dom: parseInt(parts.day, 10),
    month: parseInt(parts.month, 10),
    dow: DOW_NAMES[parts.weekday],
  };
}

export function cronMatches(parsed, date, timeZone) {
  const p = zonedParts(date, timeZone);
  if (!parsed.minute.has(p.minute)) return false;
  if (!parsed.hour.has(p.hour)) return false;
  if (!parsed.month.has(p.month)) return false;
  // The vixie OR rule: when both are restricted, either may match.
  const domOk = parsed.dom.has(p.dom);
  const dowOk = parsed.dow.has(p.dow);
  if (parsed.domRestricted && parsed.dowRestricted) return domOk || dowOk;
  if (parsed.domRestricted) return domOk;
  if (parsed.dowRestricted) return dowOk;
  return true;
}

/**
 * The next instant strictly after `after` matching the expression, or null if
 * none within ~13 months (which for a five-field cron means the expression is
 * effectively unsatisfiable, e.g. Feb 30).
 */
export function nextRun(expr, after, timeZone) {
  const parsed = typeof expr === 'string' ? parseCron(expr) : expr;
  // Start at the next whole minute.
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 400 * 24 * 3600e3;
  while (t.getTime() <= limit) {
    if (cronMatches(parsed, t, timeZone)) return new Date(t.getTime());
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return null;
}

/**
 * The due-check a host tick uses: which of these schedules should fire, given
 * the last time each fired? A schedule is due when a matching instant exists
 * in (lastFired, now]. Missing lastFired means "never fired": to avoid a
 * thundering catch-up on first boot, it is due only if NOW matches a window in
 * the last `graceMinutes`.
 */
export function dueSchedules(schedules, { now, timeZone, lastFiredBy, graceMinutes = 10 }) {
  const due = [];
  for (const s of schedules) {
    const last = lastFiredBy(s.key);
    const from = last
      ? new Date(last)
      : new Date(now.getTime() - graceMinutes * 60e3);
    const next = nextRun(s.expr, from, timeZone);
    if (next && next.getTime() <= now.getTime()) due.push({ ...s, firedFor: next });
  }
  return due;
}
