// The apply path: deterministic host code that turns a decision into side
// effects. No model anywhere in this file — approvals must keep working when
// the model is rate-limited, and nothing here may depend on judgment.
//
// The invariants, each of which was a real production failure when it was a
// convention instead of code:
//
//   EDIT BEFORE COMPLETE. The approved copy (with the human's edits) is what
//   the platform must hold BEFORE any task completes. We create the action
//   with the final copy, read it back, and require a match — a mismatch
//   aborts with nothing completed. The wrong order is not discouraged; it is
//   inexpressible, because this is the only function that can complete.
//
//   GET FIRST. Before acting on a task we read the platform's state. If the
//   human already actioned it from the platform queue, the platform wins and
//   the card marks itself done — never a double-act, never a stale re-open.
//
//   COMPARE AND SET. A CRM change knows its `from`. Already `to` = done
//   (idempotent re-run). Neither `from` nor `to` = someone else changed it —
//   conflict, skip, say so. Never overwrite a value we did not expect.
//
//   IDEMPOTENT BY CONSTRAINT. Every side effect claims a unique apply_key
//   first. `pending` after a crash means "verify against the platform before
//   retrying", not "assume done" and not "blindly redo".
//
// Injected `platform` (outreach) and `crm` interfaces keep this testable:
//   platform.findAction({subject, ownerProviderId})  -> {task_ids, steps} | null
//   platform.createAction({subject, steps, ownerProviderId, flow?}) -> {task_ids}
//   platform.readTask(taskId)   -> {status: 'open'|'completed'|'cancelled', copy, owner_provider_id}
//   platform.completeTask(taskId)
//   platform.cancelAction(taskIds)
//   platform.enrolFlow({flow_id, subject, ownerProviderId})
//   crm.readProperty({object_type, object_id, field}) -> value
//   crm.updateProperty({object_type, object_id, field, value})

import { Ledger } from './ledger.mjs';

const iso = (d) => d.toISOString();

/**
 * Verify a created action holds the approved copy and the right sender, THEN
 * complete it. Shared by single-contact outreach and campaign drip so both
 * enforce the same invariant: never complete a task whose copy or owner does
 * not match, because completing an approval-gated task IS the send. Returns
 * { ok } or { conflict: detail } — the caller decides what to do with a
 * conflict (single: abort; campaign: skip this member).
 */
async function verifyAndComplete({ platform, taskIds, steps, ownerProviderId }) {
  for (let i = 0; i < taskIds.length; i++) {
    const task = await platform.readTask(taskIds[i]);
    if (task.status === 'completed') continue;
    if (task.status === 'cancelled') {
      return { conflict: `task ${taskIds[i]} was cancelled on the platform — not completing` };
    }
    if (task.owner_provider_id && task.owner_provider_id !== ownerProviderId) {
      return { conflict: `task ${taskIds[i]} landed on owner ${task.owner_provider_id}, expected ${ownerProviderId} — sending as the wrong person is irreversible` };
    }
    const expected = steps[i]?.copy;
    if (expected !== undefined && task.copy !== undefined && task.copy !== null && task.copy !== expected) {
      return { conflict: `task ${taskIds[i]} does not hold the approved copy — completion refused so the human's edit cannot be silently lost` };
    }
  }
  // All verified: complete every non-terminal task.
  for (const taskId of taskIds) {
    const task = await platform.readTask(taskId);
    if (task.status !== 'completed') await platform.completeTask(taskId);
  }
  return { ok: true };
}

/** Merge the human's edits into the drafted steps. Edits are keyed by step
 *  index as a string ("0", "1", …) because that is what the modal submits. */
export function mergeEdits(steps, edits) {
  if (!edits) return steps;
  return steps.map((s, i) => {
    const edited = edits[String(i)];
    return edited === undefined ? s : { ...s, copy: edited };
  });
}

/**
 * Apply the effective decision on one work item. Returns a result line for
 * the card update: { outcome, detail }.
 */
export async function applyWorkItem({ ledger, cfg, workItemId, platform, crm, now = () => new Date() }) {
  const item = ledger.getWorkItem(workItemId);
  if (!item) return { outcome: 'error', detail: `work item ${workItemId} not found` };

  // Terminal states never re-apply. A late intent, a Slack retry, a second
  // host tick — all land here and do nothing.
  if (!['pending_approval', 'undo_window', 'applying'].includes(item.status)) {
    return { outcome: 'noop', detail: `already ${item.status}` };
  }

  // Expiry beats everything: an expired card is NEVER applied late.
  if (item.expires_at <= iso(now())) {
    ledger.setWorkItemStatus(item.id, 'expired');
    if (item.payload.touch_id) ledger.releaseTouch(item.payload.touch_id);
    return { outcome: 'expired', detail: 'expired unactioned — nothing was applied' };
  }

  const decision = ledger.effectiveDecision(item.id);
  if (!decision) {
    // The newest action was an undo: the card goes back to pending.
    ledger.setWorkItemStatus(item.id, 'pending_approval');
    return { outcome: 'undone', detail: 'decision undone — card is pending again' };
  }

  if (decision.decision === 'deny') {
    ledger.setWorkItemStatus(item.id, 'denied');
    if (item.payload.touch_id) ledger.releaseTouch(item.payload.touch_id);
    return { outcome: 'denied', detail: decision.reason };
  }

  // decision === 'approve'
  ledger.setWorkItemStatus(item.id, 'applying');
  try {
    let result;
    if (item.payload.campaign) {
      result = await applyCampaignTick({ ledger, cfg, item, platform, now });
    } else if (item.payload.flow_enrolment) {
      result = await applyFlowEnrolment({ ledger, cfg, item, decision, platform, now });
    } else if (item.kind === 'outreach') {
      result = await applyOutreach({ ledger, item, decision, platform });
    } else if (item.kind === 'crm_change') {
      result = await applyCrmChange({ ledger, item, decision, crm });
    } else if (item.kind === 'unsent_draft') {
      result = await applyUnsentDraft({ ledger, item, decision, platform });
    } else {
      result = { outcome: 'applied', detail: 'nothing to apply for this kind' };
    }
    if (result.outcome === 'applied') {
      ledger.setWorkItemStatus(item.id, 'applied');
      if (item.payload.touch_id) ledger.confirmTouch(item.payload.touch_id);
    } else if (result.outcome === 'conflict') {
      ledger.setWorkItemStatus(item.id, 'conflict');
      if (item.payload.touch_id) ledger.releaseTouch(item.payload.touch_id);
    } else if (result.outcome === 'partial') {
      // campaign mid-drip: stays 'applying'; the next tick continues it
      ledger.setWorkItemStatus(item.id, 'applying');
    }
    return result;
  } catch (e) {
    // A thrown error is a transient failure (network, 5xx): the item stays
    // 'applying' and the next tick retries — apply_keys make that safe.
    ledger.setWorkItemStatus(item.id, 'applying');
    return { outcome: 'retry', detail: `apply failed, will retry: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------

async function applyOutreach({ ledger, item, decision, platform }) {
  const steps = mergeEdits(item.payload.steps, decision.edits);

  // GET first: if a matching action already exists (a crashed earlier apply,
  // or staged by hand), reconcile against it rather than creating a second.
  const createKey = Ledger.applyKey(item.id, decision.id, 'create');
  const claimed = ledger.claimApply(createKey, item.id, 'create');
  let taskIds;

  if (!claimed) {
    // A previous run claimed the create. Find what it made and verify from
    // there — never create twice.
    const existing = await platform.findAction({
      subject: item.payload.subject,
      ownerProviderId: item.owner_provider_id,
    });
    if (!existing) return { outcome: 'retry', detail: 'create claimed but nothing found on the platform; retrying' };
    taskIds = existing.task_ids;
  } else {
    const created = await platform.createAction({
      subject: item.payload.subject,
      steps,
      ownerProviderId: item.owner_provider_id,
    });
    taskIds = created.task_ids;
    ledger.recordApplyResult(createKey, `created:${taskIds.join(',')}`);
  }

  // Store task ids back so a crash-recovery or reconcile can find this work
  // (they were previously never persisted — a created-but-not-completed action
  // was untrackable).
  ledger.setWorkItemTaskIds(item.id, taskIds);

  // Verify owner + copy on EVERY task, then complete. On a mismatch, cancel the
  // whole action — sending as the wrong person or with lost edits is
  // irreversible, so nothing is completed.
  const v = await verifyAndComplete({ platform, taskIds, steps, ownerProviderId: item.owner_provider_id });
  if (v.conflict) {
    await platform.cancelAction(taskIds);
    return { outcome: 'conflict', detail: `${v.conflict} — cancelled the action, nothing was completed` };
  }
  return { outcome: 'applied', detail: `sent: ${taskIds.length} step(s) completed with the approved copy` };
}

async function applyFlowEnrolment({ ledger, cfg, item, decision, platform, now }) {
  const { flow_id } = item.payload.flow_enrolment;

  // Re-check BOTH gates at apply time. Config may have changed since propose,
  // and the suppression list may have grown — apply-time state wins.
  if (!(cfg.flows ?? []).some((f) => f.id === flow_id)) {
    return { outcome: 'conflict', detail: `flow "${flow_id}" is no longer declared in config — enrolment refused` };
  }
  const sup = ledger.suppressionFor({
    subjectId: item.subject_id,
    email: item.payload.subject?.email,
    companyDomain: item.payload.subject?.company_domain,
  }, iso(now()));
  if (sup) {
    return { outcome: 'conflict', detail: `suppressed since approval (${sup.reason}) — enrolment refused` };
  }

  const key = Ledger.applyKey(item.id, decision.id, `enrol:${flow_id}`);
  if (ledger.claimApply(key, item.id, `enrol:${flow_id}`)) {
    await platform.enrolFlow({
      flow_id,
      subject: item.payload.subject,
      ownerProviderId: item.owner_provider_id,
    });
    ledger.recordApplyResult(key, 'enrolled');
  }
  return { outcome: 'applied', detail: `enrolled into ${item.payload.flow_enrolment.flow_name}` };
}

async function applyCrmChange({ ledger, item, decision, crm }) {
  const results = [];
  for (const change of item.payload.changes) {
    const key = Ledger.applyKey(item.id, decision.id,
      `crm:${change.object_type}:${change.object_id}:${change.field}`);
    if (!ledger.claimApply(key, item.id, 'crm_change')) {
      results.push(`${change.field}: already applied`);
      continue;
    }
    const current = await crm.readProperty(change);
    if (String(current) === String(change.to)) {
      ledger.recordApplyResult(key, 'already-at-target');
      results.push(`${change.field}: already ${change.to}`);
      continue;
    }
    if (String(current) !== String(change.from)) {
      // Someone else changed it since the card was drafted. Their change wins.
      ledger.recordApplyResult(key, `conflict:${current}`);
      results.push(`${change.field}: NOT applied — expected "${change.from}" but found "${current}" (someone changed it; their change wins)`);
      continue;
    }
    await crm.updateProperty({ ...change, value: change.to });
    const after = await crm.readProperty(change);
    if (String(after) !== String(change.to)) {
      ledger.recordApplyResult(key, 'verify-failed');
      results.push(`${change.field}: write did not stick (read back "${after}") — flagged`);
      continue;
    }
    ledger.recordApplyResult(key, 'applied');
    results.push(`${change.field}: ${change.from} → ${change.to}`);
  }
  const anyApplied = results.some((r) => r.includes('→') || r.includes('already'));
  return {
    outcome: anyApplied ? 'applied' : 'conflict',
    detail: results.join('\n'),
  };
}

async function applyUnsentDraft({ ledger, item, decision, platform }) {
  // The recap must never send. If the platform can hold an unsent draft, park
  // it there; otherwise the approved card itself is the deliverable.
  const body = decision.edits?.['0'] ?? item.payload.body;
  if (typeof platform.createDraft === 'function') {
    const key = Ledger.applyKey(item.id, decision.id, 'draft');
    if (ledger.claimApply(key, item.id, 'draft')) {
      await platform.createDraft({
        title: item.payload.title,
        body,
        ownerProviderId: item.owner_provider_id,
      });
      ledger.recordApplyResult(key, 'drafted');
    }
    return { outcome: 'applied', detail: 'saved as an UNSENT draft — nothing was sent' };
  }
  return { outcome: 'applied', detail: 'approved; the card holds the final text (no draft store configured)' };
}

/**
 * One drip tick for an approved campaign. Sends as many members as the caps
 * allow right now; the item stays 'applying' until everyone is done. Every
 * member is re-screened at send time — approval of the batch never bypasses
 * per-person checks, and a suppression added mid-campaign takes effect
 * immediately.
 */
export async function applyCampaignTick({ ledger, cfg, item, platform, now = () => new Date() }) {
  const decision = ledger.effectiveDecision(item.id);
  if (!decision || decision.decision !== 'approve') {
    return { outcome: 'noop', detail: 'campaign has no standing approval' };
  }
  const steps = mergeEdits(item.payload.campaign.steps, decision.edits);
  const members = item.payload.campaign.admitted;

  let sent = 0, skipped = 0, capped = false;
  for (const member of members) {
    const memberKey = Ledger.applyKey(item.id, decision.id, `member:${member.subject_id}`);
    if (!ledger.claimApply(memberKey, item.id, 'campaign-member')) continue; // done earlier

    // Re-screen at send time.
    const sup = ledger.suppressionFor({
      subjectId: member.subject_id,
      email: member.subject.email,
      companyDomain: member.subject.company_domain,
    }, iso(now()));
    if (sup) {
      ledger.recordApplyResult(memberKey, `skipped:${sup.reason}`);
      skipped++;
      continue;
    }
    const reserve = ledger.reserveTouch({
      subjectId: member.subject_id,
      teammate: 'agent',
      channel: steps[0].channel,
      domain: member.subject.company_domain ?? null,
      caps: cfg.limits,
    }, iso(now()));
    if (!reserve.ok) {
      // Caps are full for now. Un-claim so tomorrow's tick retries this member.
      ledger.recordApplyResult(memberKey, 'deferred:caps');
      ledger.db.prepare('DELETE FROM apply_log WHERE apply_key = ?').run(memberKey);
      capped = true;
      break;
    }
    const created = await platform.createAction({
      subject: member.subject, steps, ownerProviderId: item.owner_provider_id,
    });
    // SAME verify as single-contact: never complete a member's task whose copy
    // or sender does not match. A mismatch skips this member (releasing its
    // reservation), it does not send the wrong thing.
    const v = await verifyAndComplete({
      platform, taskIds: created.task_ids, steps, ownerProviderId: item.owner_provider_id,
    });
    if (v.conflict) {
      ledger.releaseTouch(reserve.touchId);
      ledger.recordApplyResult(memberKey, `conflict:${v.conflict}`);
      skipped++;
      continue;
    }
    ledger.confirmTouch(reserve.touchId);
    ledger.recordApplyResult(memberKey, 'sent');
    sent++;
  }

  const done = members.every((m) =>
    ledger.db.prepare('SELECT 1 FROM apply_log WHERE apply_key = ?')
      .get(Ledger.applyKey(item.id, decision.id, `member:${m.subject_id}`)));

  if (done) {
    return { outcome: 'applied', detail: `campaign complete: ${sent} sent this tick, ${skipped} skipped` };
  }
  return {
    outcome: 'partial',
    detail: capped
      ? `daily caps reached — ${sent} sent this tick, continues next tick`
      : `${sent} sent this tick, ${skipped} skipped, continuing`,
  };
}

/** Expire every pending item past its deadline. Run on a host tick. */
export function expireDueItems(ledger, now = () => new Date()) {
  const rows = ledger.db.prepare(
    "SELECT id FROM work_items WHERE status IN ('pending_approval','undo_window') AND expires_at <= ?")
    .all(iso(now()));
  for (const { id } of rows) {
    const item = ledger.getWorkItem(id);
    ledger.setWorkItemStatus(id, 'expired');
    if (item.payload.touch_id) ledger.releaseTouch(item.payload.touch_id);
  }
  return rows.map((r) => r.id);
}
