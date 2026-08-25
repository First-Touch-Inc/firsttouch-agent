// The shared ledger: one SQLite database that every teammate reads and writes.
//
// This replaces the JSONL files in state/. The things that broke in production
// were exactly the things JSONL cannot give you: a suppression written by one
// process and read by another in the same second, a counter that two teammates
// increment without clobbering each other, an undo timer that survives a
// restart, and an apply pass that can prove it already did something.
//
// Uses node:sqlite (built in since Node 22.5, no flag needed on 24). Zero
// dependencies, same as the rest of the runner.
//
// Design rules, in order of importance:
//   1. Append, don't update, wherever the history matters (decisions, lessons,
//      apply_log). The newest row wins by collapse, not by overwrite.
//   2. Idempotency is a UNIQUE constraint, not a convention. Re-applying the
//      same decision hits `apply_log.apply_key` and is a no-op.
//   3. Identity is a graph, not a string compare. A person is a subject with
//      aliases (email, domain, CRM id, profile URL); suppression and claims
//      attach to the subject or the domain, so a prospect surfaced from a
//      signal feed with no CRM record still gets caught by the domain backstop.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- Identity graph. One subject, many aliases.
CREATE TABLE IF NOT EXISTS subjects (
  subject_id TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('person','account','deal','meeting')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS subject_aliases (
  alias_type  TEXT NOT NULL CHECK (alias_type IN
    ('crm_contact_id','crm_company_id','crm_deal_id','normalized_email',
     'normalized_domain','social_profile_url','outreach_contact_id','meeting_id')),
  alias_value TEXT NOT NULL,
  subject_id  TEXT NOT NULL REFERENCES subjects(subject_id),
  PRIMARY KEY (alias_type, alias_value)
);

-- Claims: which teammate is working a subject. The collision guard between
-- teammates when a tenant runs more than one. A claim is advisory until the
-- broker enforces it: propose refuses when a live claim belongs to another
-- teammate and the motion does not declare allow_claimed.
CREATE TABLE IF NOT EXISTS claims (
  subject_id TEXT NOT NULL REFERENCES subjects(subject_id),
  teammate   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  until_at   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (subject_id)
);

-- Suppressions. scope 'domain' is the backstop that catches people with no
-- CRM record; scope 'subject' is the precise one. until_at NULL = forever.
CREATE TABLE IF NOT EXISTS suppressions (
  scope      TEXT NOT NULL CHECK (scope IN ('domain','email','subject')),
  value      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  source     TEXT NOT NULL,           -- 'operator' | 'crm_outcome' | 'reply' | teammate name
  until_at   TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope, value)
);

-- Touches: the enforced version of limits. One row per outward contact,
-- written by the broker at stage time (reserved) and confirmed at apply.
-- Counters are queries over this table, never a separate number that drifts.
CREATE TABLE IF NOT EXISTS touches (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES subjects(subject_id),
  teammate    TEXT NOT NULL,
  channel     TEXT NOT NULL,          -- 'email' | 'linkedin' | ...
  domain      TEXT,                   -- registrable domain, for per-company caps
  status      TEXT NOT NULL DEFAULT 'reserved'
              CHECK (status IN ('reserved','confirmed','released')),
  reserved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT                    -- reservation TTL; released if unconfirmed
);
CREATE INDEX IF NOT EXISTS idx_touches_domain ON touches(domain, reserved_at);
CREATE INDEX IF NOT EXISTS idx_touches_subject ON touches(subject_id, reserved_at);

-- Work items: the unit a human approves. Typed subject, typed outcome.
-- payload carries the motion-specific shape (draft steps, CRM change array,
-- unsent recap, report lines) as validated JSON.
CREATE TABLE IF NOT EXISTS work_items (
  id           TEXT PRIMARY KEY,
  teammate     TEXT NOT NULL,
  motion       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
               ('outreach','crm_change','unsent_draft','report')),
  subject_id   TEXT REFERENCES subjects(subject_id),
  payload      TEXT NOT NULL,         -- JSON, schema-validated by the broker
  owner_provider_id TEXT,             -- who this sends/applies as; NULL only for kind='report'
  task_ids     TEXT NOT NULL DEFAULT '[]',  -- JSON array of platform task ids
  status       TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN
               ('pending_approval','undo_window','applying','applied',
                'denied','expired','superseded','conflict')),
  slack_channel TEXT,
  slack_ts      TEXT,
  expires_at    TEXT NOT NULL,
  apply_attempts INTEGER NOT NULL DEFAULT 0,  -- bounds retry of a stuck 'applying'
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_work_pending ON work_items(status, slack_ts);
CREATE INDEX IF NOT EXISTS idx_work_subject ON work_items(subject_id, created_at);

-- Decisions: append-only. A second decision on the same item supersedes the
-- first by collapse (newest wins), never by UPDATE.
CREATE TABLE IF NOT EXISTS decisions (
  id             TEXT PRIMARY KEY,
  work_item_id   TEXT NOT NULL REFERENCES work_items(id),
  actor_slack_id TEXT NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('approve','deny','undo')),
  edits          TEXT,                -- JSON {step_id: new_copy}, approve only
  reason         TEXT,               -- required for deny, enforced in code
  slack_event_id TEXT UNIQUE,        -- Slack retries must not double-record
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_item ON decisions(work_item_id, created_at);

-- Intents: the durable 45-second undo timer. A setTimeout dies with the
-- process; this row does not. The host applies rows whose apply_after has
-- passed and whose decision has not been undone.
CREATE TABLE IF NOT EXISTS intents (
  id           TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  decision_id  TEXT NOT NULL REFERENCES decisions(id),
  apply_after  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','applying','cancelled','applied','failed')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_intents_due ON intents(status, apply_after);

-- Apply log: idempotency as a constraint. apply_key is derived from the
-- decision content; INSERT OR IGNORE makes a re-apply a provable no-op.
CREATE TABLE IF NOT EXISTS apply_log (
  apply_key    TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  action       TEXT NOT NULL,
  result       TEXT NOT NULL,
  applied_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Lessons: host-written only. The model proposes; only deterministic host
-- code inserts, and only from human edits and deny reasons — never from
-- prospect-authored text. Never deleted, only superseded.
CREATE TABLE IF NOT EXISTS lessons (
  id         TEXT PRIMARY KEY,
  teammate   TEXT NOT NULL,           -- or 'shared'
  scope      TEXT NOT NULL,           -- 'voice' | 'qualification' | 'deal_judgment' | ...
  rule       TEXT NOT NULL,
  evidence   TEXT NOT NULL,           -- what correction produced this
  supersedes TEXT REFERENCES lessons(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Per-source sweep watermarks, so a re-run does not re-surface yesterday.
CREATE TABLE IF NOT EXISTS watermarks (
  teammate  TEXT NOT NULL,
  source    TEXT NOT NULL,
  value     TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (teammate, source)
);
`;

/** Lowercase, trim, strip a leading mailto: — the same email always maps to
 *  the same alias row. */
export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase().replace(/^mailto:/, '');
}

/** Registrable domain, approximately: last two labels, or last three when the
 *  second-level is a known public affix (co.uk style). Good enough for a
 *  suppression backstop; not a full PSL. */
export function registrableDomain(input) {
  const host = String(input || '')
    .trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .split(/[/?#]/)[0].split('@').pop();
  if (!host || !host.includes('.')) return null;
  const labels = host.split('.').filter(Boolean);
  const affixes = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);
  if (labels.length >= 3 && affixes.has(labels[labels.length - 2])) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

export function openLedger(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Additive migrations for databases created before a column existed. Each is
  // idempotent (ALTER throws "duplicate column" if already present — ignored).
  for (const alter of [
    'ALTER TABLE work_items ADD COLUMN apply_attempts INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { db.exec(alter); } catch { /* column already exists */ }
  }
  return new Ledger(db);
}

export class Ledger {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  // --- identity -------------------------------------------------------------

  /** Find or create the subject for a set of aliases. If two aliases point at
   *  different existing subjects, the oldest wins and the others are re-pointed
   *  — the graph converges instead of splitting. */
  resolveSubject(kind, aliases) {
    const entries = Object.entries(aliases).filter(([, v]) => v != null && v !== '');
    if (entries.length === 0) throw new Error('resolveSubject: at least one alias required');

    const find = this.db.prepare(
      'SELECT subject_id FROM subject_aliases WHERE alias_type = ? AND alias_value = ?');
    const found = new Set();
    for (const [type, value] of entries) {
      const row = find.get(type, String(value));
      if (row) found.add(row.subject_id);
    }

    let subjectId;
    if (found.size === 0) {
      subjectId = randomUUID();
      this.db.prepare('INSERT INTO subjects (subject_id, kind) VALUES (?, ?)')
        .run(subjectId, kind);
    } else {
      const ids = [...found];
      // Oldest subject wins so ids stay stable across merges.
      const rows = ids.map((id) =>
        this.db.prepare('SELECT subject_id, created_at FROM subjects WHERE subject_id = ?').get(id));
      rows.sort((a, b) => a.created_at < b.created_at ? -1 : 1);
      subjectId = rows[0].subject_id;
      for (const other of rows.slice(1)) {
        this.db.prepare('UPDATE subject_aliases SET subject_id = ? WHERE subject_id = ?')
          .run(subjectId, other.subject_id);
        // Repoint everything else keyed by the disappearing subject, or a merge
        // silently erases a subject-scoped SUPPRESSION and the person becomes
        // contactable again. Claims and touches move too, for the same reason.
        this.db.prepare('UPDATE suppressions SET value = ? WHERE scope = ? AND value = ?')
          .run(subjectId, 'subject', other.subject_id);
        this.db.prepare('UPDATE touches SET subject_id = ? WHERE subject_id = ?')
          .run(subjectId, other.subject_id);
        this.db.prepare('UPDATE work_items SET subject_id = ? WHERE subject_id = ?')
          .run(subjectId, other.subject_id);
        this.db.prepare('DELETE FROM claims WHERE subject_id = ?').run(other.subject_id);
      }
    }

    const upsert = this.db.prepare(
      `INSERT INTO subject_aliases (alias_type, alias_value, subject_id)
       VALUES (?, ?, ?)
       ON CONFLICT(alias_type, alias_value) DO UPDATE SET subject_id = excluded.subject_id`);
    for (const [type, value] of entries) upsert.run(type, String(value), subjectId);
    return subjectId;
  }

  // --- claims ---------------------------------------------------------------

  claim(subjectId, teammate, reason, untilIso) {
    this.db.prepare(
      `INSERT INTO claims (subject_id, teammate, reason, until_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(subject_id) DO UPDATE SET
         teammate = excluded.teammate, reason = excluded.reason, until_at = excluded.until_at`)
      .run(subjectId, teammate, reason, untilIso);
  }

  releaseClaim(subjectId) {
    this.db.prepare('DELETE FROM claims WHERE subject_id = ?').run(subjectId);
  }

  /** The live claim on a subject, or null. Expired claims are treated as
   *  absent (and cleaned up lazily). */
  liveClaim(subjectId, nowIso = new Date().toISOString()) {
    const row = this.db.prepare('SELECT * FROM claims WHERE subject_id = ?').get(subjectId);
    if (!row) return null;
    if (row.until_at <= nowIso) {
      this.releaseClaim(subjectId);
      return null;
    }
    return row;
  }

  // --- suppression ----------------------------------------------------------

  suppress(scope, value, reason, source, untilIso = null) {
    const v = scope === 'email' ? normalizeEmail(value)
      : scope === 'domain' ? registrableDomain(value) ?? String(value).toLowerCase()
      : String(value);
    this.db.prepare(
      `INSERT INTO suppressions (scope, value, reason, source, until_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, value) DO UPDATE SET
         reason = excluded.reason, source = excluded.source, until_at = excluded.until_at`)
      .run(scope, v, reason, source, untilIso);
  }

  /** Check every angle at once: the subject itself, the email, and the
   *  registrable domain of BOTH the email and any company domain given.
   *  Returns the matching suppression row or null. The domain check is the
   *  backstop for people with no CRM record (BRIEF-2 §7). */
  suppressionFor({ subjectId, email, companyDomain }, nowIso = new Date().toISOString()) {
    const live = (row) => row && (row.until_at == null || row.until_at > nowIso) ? row : null;
    const get = this.db.prepare('SELECT * FROM suppressions WHERE scope = ? AND value = ?');

    if (subjectId) {
      const hit = live(get.get('subject', subjectId));
      if (hit) return hit;
    }
    if (email) {
      const hit = live(get.get('email', normalizeEmail(email)));
      if (hit) return hit;
    }
    const domains = new Set();
    if (email) { const d = registrableDomain(email); if (d) domains.add(d); }
    if (companyDomain) { const d = registrableDomain(companyDomain); if (d) domains.add(d); }
    for (const d of domains) {
      const hit = live(get.get('domain', d));
      if (hit) return hit;
    }
    return null;
  }

  // --- touches (enforced limits) --------------------------------------------

  /** Reserve a touch inside the caps, or refuse with the cap that was hit.
   *  Reservation, not commitment: confirmed at apply, released on denial or
   *  TTL expiry, so a denied card gives its slot back. */
  reserveTouch(args, nowIso = new Date().toISOString()) {
    // The count-check and the insert must be ONE atomic step, or two concurrent
    // reservations (host apply + a spawned tool server, separate processes on
    // the same DB file) can both pass the same cap and both insert. BEGIN
    // IMMEDIATE takes the write lock for the whole check+insert; busy_timeout
    // makes the loser wait rather than error.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this._reserveTouchLocked(args, nowIso);
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }

  _reserveTouchLocked({ subjectId, teammate, channel, domain, caps, ttlMinutes = 360 },
               nowIso = new Date().toISOString()) {
    this.releaseExpiredTouches(nowIso);
    const now = new Date(nowIso);
    const dayAgo = new Date(now - 24 * 3600e3).toISOString();
    const weekAgo = new Date(now - 7 * 24 * 3600e3).toISOString();
    const quarterAgo = new Date(now - 91 * 24 * 3600e3).toISOString();
    const active = "status IN ('reserved','confirmed')";
    const count = (sql, ...args) => this.db.prepare(sql).get(...args).n;

    if (caps.per_day != null) {
      const n = count(
        `SELECT COUNT(*) n FROM touches WHERE teammate = ? AND ${active} AND reserved_at > ?`,
        teammate, dayAgo);
      if (n >= caps.per_day) return { ok: false, cap: 'per_day', at: n };
    }
    if (caps.per_week != null) {
      const n = count(
        `SELECT COUNT(*) n FROM touches WHERE teammate = ? AND ${active} AND reserved_at > ?`,
        teammate, weekAgo);
      if (n >= caps.per_week) return { ok: false, cap: 'per_week', at: n };
    }
    if (caps.per_contact_per_quarter != null && subjectId) {
      const n = count(
        `SELECT COUNT(*) n FROM touches WHERE subject_id = ? AND ${active} AND reserved_at > ?`,
        subjectId, quarterAgo);
      if (n >= caps.per_contact_per_quarter) {
        return { ok: false, cap: 'per_contact_per_quarter', at: n };
      }
    }
    if (caps.per_company_per_quarter != null && domain) {
      const n = count(
        `SELECT COUNT(*) n FROM touches WHERE domain = ? AND ${active} AND reserved_at > ?`,
        domain, quarterAgo);
      if (n >= caps.per_company_per_quarter) {
        return { ok: false, cap: 'per_company_per_quarter', at: n };
      }
    }

    const id = randomUUID();
    const expires = new Date(now.getTime() + ttlMinutes * 60e3).toISOString();
    this.db.prepare(
      `INSERT INTO touches (id, subject_id, teammate, channel, domain, status, reserved_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`)
      .run(id, subjectId, teammate, channel, domain ?? null, nowIso, expires);
    return { ok: true, touchId: id };
  }

  confirmTouch(touchId) {
    this.db.prepare(
      "UPDATE touches SET status = 'confirmed', expires_at = NULL WHERE id = ? AND status = 'reserved'")
      .run(touchId);
  }

  releaseTouch(touchId) {
    this.db.prepare(
      "UPDATE touches SET status = 'released' WHERE id = ? AND status = 'reserved'")
      .run(touchId);
  }

  releaseExpiredTouches(nowIso = new Date().toISOString()) {
    this.db.prepare(
      "UPDATE touches SET status = 'released' WHERE status = 'reserved' AND expires_at IS NOT NULL AND expires_at <= ?")
      .run(nowIso);
  }

  // --- work items and decisions ---------------------------------------------

  createWorkItem({ teammate, motion, kind, subjectId = null, payload,
                   ownerProviderId = null, taskIds = [], expiresAt }) {
    if (kind !== 'report' && !ownerProviderId) {
      // The most expensive bug class in production: an action with no explicit
      // owner is assigned to whoever the token authenticates as. Refuse here,
      // where it is cheap, not at apply, where it is not.
      throw new Error(`work item of kind '${kind}' requires an explicit owner`);
    }
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO work_items (id, teammate, motion, kind, subject_id, payload,
                               owner_provider_id, task_ids, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, teammate, motion, kind, subjectId, JSON.stringify(payload),
           ownerProviderId, JSON.stringify(taskIds), expiresAt);
    return id;
  }

  getWorkItem(id) {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, payload: JSON.parse(row.payload), task_ids: JSON.parse(row.task_ids) };
  }

  setWorkItemStatus(id, status) {
    this.db.prepare('UPDATE work_items SET status = ? WHERE id = ?').run(status, id);
  }

  setWorkItemCard(id, channel, ts) {
    this.db.prepare('UPDATE work_items SET slack_channel = ?, slack_ts = ? WHERE id = ?')
      .run(channel, ts, id);
  }

  /** Persist the platform task ids created for a work item, so a crash between
   *  create and complete leaves the work findable instead of orphaned. */
  setWorkItemTaskIds(id, taskIds) {
    this.db.prepare('UPDATE work_items SET task_ids = ? WHERE id = ?')
      .run(JSON.stringify(taskIds ?? []), id);
  }

  /** Increment and return the apply-attempt count — used to bound retries of a
   *  stuck 'applying' item so a permanently-failing send cannot loop forever. */
  bumpApplyAttempts(id) {
    this.db.prepare('UPDATE work_items SET apply_attempts = apply_attempts + 1 WHERE id = ?').run(id);
    return this.db.prepare('SELECT apply_attempts n FROM work_items WHERE id = ?').get(id)?.n ?? 0;
  }

  /** Record a decision. slack_event_id is UNIQUE so a Slack retry of the same
   *  event records nothing the second time (returns the existing decision). */
  recordDecision({ workItemId, actorSlackId, decision, edits = null, reason = null,
                   slackEventId = null }) {
    if (decision === 'deny' && !reason) {
      throw new Error('a denial requires a reason — the reason is the input to learning');
    }
    if (slackEventId) {
      const dup = this.db.prepare('SELECT id FROM decisions WHERE slack_event_id = ?')
        .get(slackEventId);
      if (dup) return { id: dup.id, duplicate: true };
    }
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO decisions (id, work_item_id, actor_slack_id, decision, edits, reason, slack_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, workItemId, actorSlackId, decision,
           edits ? JSON.stringify(edits) : null, reason, slackEventId);
    return { id, duplicate: false };
  }

  /** Newest decision on a work item, with undo folded in: an 'undo' newer than
   *  a decision cancels it, and an approve/deny newer than an undo stands.
   *  "Newest" is insertion order (rowid), not created_at — two clicks in the
   *  same millisecond must still have a definite order. */
  effectiveDecision(workItemId) {
    const rows = this.db.prepare(
      'SELECT * FROM decisions WHERE work_item_id = ? ORDER BY rowid DESC')
      .all(workItemId);
    for (const row of rows) {
      if (row.decision === 'undo') return null;   // newest action is an undo: nothing stands
      return { ...row, edits: row.edits ? JSON.parse(row.edits) : null };
    }
    return null;
  }

  // --- intents (durable undo window) ----------------------------------------

  createIntent({ workItemId, decisionId, undoSeconds = 45 },
               nowIso = new Date().toISOString()) {
    const id = randomUUID();
    const applyAfter = new Date(new Date(nowIso).getTime() + undoSeconds * 1000).toISOString();
    this.db.prepare(
      `INSERT INTO intents (id, work_item_id, decision_id, apply_after) VALUES (?, ?, ?, ?)`)
      .run(id, workItemId, decisionId, applyAfter);
    return { id, applyAfter };
  }

  /** Cancel the pending intent for a work item (an undo click). Returns true
   *  if there was one to cancel — false means the window already closed. */
  /** Atomically claim a pending intent for application (pending → applying).
   *  Returns true if this caller won. An Undo racing at the window edge can
   *  only cancel while the intent is still 'pending'; once the applier has
   *  claimed it, cancel loses and the undo is correctly refused. */
  claimIntent(id) {
    const r = this.db.prepare(
      "UPDATE intents SET status = 'applying' WHERE id = ? AND status = 'pending'").run(id);
    return r.changes > 0;
  }

  cancelPendingIntent(workItemId) {
    const r = this.db.prepare(
      "UPDATE intents SET status = 'cancelled' WHERE work_item_id = ? AND status = 'pending'")
      .run(workItemId);
    return r.changes > 0;
  }

  dueIntents(nowIso = new Date().toISOString()) {
    return this.db.prepare(
      "SELECT * FROM intents WHERE status = 'pending' AND apply_after <= ? ORDER BY apply_after")
      .all(nowIso);
  }

  setIntentStatus(id, status) {
    this.db.prepare('UPDATE intents SET status = ? WHERE id = ?').run(status, id);
  }

  // --- idempotent apply -----------------------------------------------------

  static applyKey(workItemId, decisionId, action) {
    return createHash('sha256')
      .update(`${workItemId}|${decisionId}|${action}`).digest('hex');
  }

  /** True exactly once per apply_key. The caller does the side effect only
   *  when this returns true; a crash after the side effect but before commit
   *  is why the side effects themselves must also be idempotent (compare-and-
   *  set for CRM, complete-if-incomplete for tasks). */
  claimApply(applyKey, workItemId, action, result = 'pending') {
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO apply_log (apply_key, work_item_id, action, result)
       VALUES (?, ?, ?, ?)`)
      .run(applyKey, workItemId, action, result);
    return r.changes > 0;
  }

  recordApplyResult(applyKey, result) {
    this.db.prepare('UPDATE apply_log SET result = ? WHERE apply_key = ?')
      .run(result, applyKey);
  }

  // --- lessons (host-written) -----------------------------------------------

  addLesson({ teammate, scope, rule, evidence, supersedes = null }) {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO lessons (id, teammate, scope, rule, evidence, supersedes)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, teammate, scope, rule, evidence, supersedes);
    return id;
  }

  /** Active lessons for a teammate (its own plus 'shared'), superseded rows
   *  excluded, oldest first so newer rules read as refinements. */
  activeLessons(teammate) {
    return this.db.prepare(
      `SELECT * FROM lessons
       WHERE teammate IN (?, 'shared')
         AND id NOT IN (SELECT supersedes FROM lessons WHERE supersedes IS NOT NULL)
       ORDER BY created_at`)
      .all(teammate);
  }

  // --- watermarks -----------------------------------------------------------

  getWatermark(teammate, source) {
    const row = this.db.prepare(
      'SELECT value FROM watermarks WHERE teammate = ? AND source = ?').get(teammate, source);
    return row ? row.value : null;
  }

  setWatermark(teammate, source, value) {
    this.db.prepare(
      `INSERT INTO watermarks (teammate, source, value, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(teammate, source) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at`)
      .run(teammate, source, value);
  }
}
