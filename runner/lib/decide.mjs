// The decision layer: what happens when a human clicks a button or submits a
// modal. Pure logic with injected Slack calls, so every rule is testable
// without a socket.
//
// THE ORDERING RULE THAT MUST NOT REGRESS: `trigger_id` dies ~3 seconds after
// the click, so for any action that opens a modal, `openView` is called FIRST
// — before ownership, expiry, or any other check. All checks run on
// view_submission, where there is no deadline. Losing that race silently
// downgrades edit-then-approve to approve/skip theatre, which is the exact
// production failure this design exists to close. (Reading our own SQLite to
// build the modal is fine — the rule is about network awaits.)
//
// THE OWNERSHIP RULE: only the owner's Slack id may decide a card that sends
// as them (plus explicit approval_overrides). Unknown owner = refuse, never
// allow — the fail-open version of this shipped once and was caught in audit.

import { buildEditModal, buildDenyModal, editsFromSubmission, cardForState } from './cards.mjs';

const parseOpaque = (value) => {
  try {
    const v = JSON.parse(value);
    return typeof v?.w === 'string' ? v.w : null;
  } catch {
    return null;
  }
};

export function ownerSlackIdFor(cfg, providerUserId) {
  const owner = (cfg.approval_routing?.owners || [])
    .find((o) => o.provider_user_id === providerUserId);
  return owner?.slack_user_id || null;
}

/** The ownership check used on every DECISION path (never before a modal
 *  open). Returns null when allowed, or a refusal line. */
export function refuseUnlessOwner({ cfg, item, clicker }) {
  if (item.kind === 'report') return 'reports have no decisions to make';
  if (!item.owner_provider_id) {
    return 'that card has no owner recorded, so nobody may approve it — this is a bug worth reporting';
  }
  const ownerSlackId = ownerSlackIdFor(cfg, item.owner_provider_id);
  if (!ownerSlackId) {
    return `that card's owner has no slack_user_id in approval_routing.owners — bind them before deciding`;
  }
  const overrides = new Set(cfg.approval_routing?.approval_overrides || []);
  if (ownerSlackId !== clicker && !overrides.has(clicker)) {
    return `that one sends as <@${ownerSlackId}> — it is theirs to approve`;
  }
  return null;
}

/**
 * A block_actions payload: approve / review / deny / undo.
 *
 * Injected:
 *   openView(triggerId, view)  — views.open; MUST be awaited first for modals
 *   updateCard(item, extra)    — re-render the card message
 *   ephemeral(text)            — whisper to the clicker
 *   applyNow(itemId)           — run the apply path immediately (denials)
 */
export async function handleBlockAction({ ledger, cfg, payload, openView, updateCard, ephemeral, applyNow, now = () => new Date() }) {
  const action = (payload.actions || [])[0];
  if (!action) return;
  const clicker = payload.user?.id;
  const itemId = parseOpaque(action.value);
  if (!itemId) return ephemeral('that button carried no card id — refusing to guess');

  // MODALS FIRST. No checks, no network, before openView — the 3-second rule.
  if (action.action_id === 'review' || action.action_id === 'deny') {
    const item = ledger.getWorkItem(itemId); // local SQLite read: sub-ms, allowed
    if (!item) return ephemeral('that card no longer exists');
    const view = action.action_id === 'review' ? buildEditModal(item) : buildDenyModal(item);
    await openView(payload.trigger_id, view);
    return;
  }

  // Everything below is a decision path: checks are mandatory here.
  const item = ledger.getWorkItem(itemId);
  if (!item) return ephemeral('that card no longer exists');

  const refusal = refuseUnlessOwner({ cfg, item, clicker });
  if (refusal) return ephemeral(refusal);

  if (action.action_id === 'undo') {
    const cancelled = ledger.cancelPendingIntent(item.id);
    if (!cancelled) {
      return ephemeral('the undo window already closed — that one is being applied');
    }
    ledger.recordDecision({
      workItemId: item.id, actorSlackId: clicker, decision: 'undo',
      slackEventId: eventKey(payload),
    });
    ledger.setWorkItemStatus(item.id, 'pending_approval');
    await updateCard(ledger.getWorkItem(item.id), {});
    return;
  }

  if (action.action_id === 'approve') {
    if (!['pending_approval', 'undo_window'].includes(item.status)) {
      return ephemeral(`that card is already ${item.status}`);
    }
    if (item.expires_at <= now().toISOString()) {
      return ephemeral('that card expired — nothing will be applied; ask for a fresh draft');
    }
    const d = ledger.recordDecision({
      workItemId: item.id, actorSlackId: clicker, decision: 'approve',
      slackEventId: eventKey(payload),
    });
    if (d.duplicate) return; // Slack retried the click; the first one stands
    const intent = ledger.createIntent({
      workItemId: item.id, decisionId: d.id,
      undoSeconds: cfg.approval.undo_seconds,
    }, now().toISOString());
    ledger.setWorkItemStatus(item.id, 'undo_window');
    await updateCard(ledger.getWorkItem(item.id), {
      decision: { decision: 'approve' }, applyAfter: intent.applyAfter,
    });
    return;
  }
}

/**
 * A view_submission: the edit-approve modal or the deny-reason modal.
 * ALL checks live here — there is no deadline on submissions.
 */
export async function handleViewSubmission({ ledger, cfg, payload, updateCard, ephemeral, applyNow, now = () => new Date() }) {
  const view = payload.view;
  const clicker = payload.user?.id;
  const itemId = parseOpaque(view?.private_metadata);
  if (!itemId) return ephemeral('that form carried no card id — refusing to guess');

  const item = ledger.getWorkItem(itemId);
  if (!item) return ephemeral('that card no longer exists');

  const refusal = refuseUnlessOwner({ cfg, item, clicker });
  if (refusal) return ephemeral(refusal);

  if (!['pending_approval', 'undo_window'].includes(item.status)) {
    return ephemeral(`that card is already ${item.status}`);
  }
  if (item.expires_at <= now().toISOString()) {
    return ephemeral('that card expired while the form was open — nothing will be applied');
  }

  if (view.callback_id === 'edit_approve') {
    const edits = editsFromSubmission(view);
    const d = ledger.recordDecision({
      workItemId: item.id, actorSlackId: clicker, decision: 'approve', edits,
      slackEventId: eventKey(payload),
    });
    if (d.duplicate) return;
    const intent = ledger.createIntent({
      workItemId: item.id, decisionId: d.id,
      undoSeconds: cfg.approval.undo_seconds,
    }, now().toISOString());
    ledger.setWorkItemStatus(item.id, 'undo_window');
    await updateCard(ledger.getWorkItem(item.id), {
      decision: { decision: 'approve', edits }, applyAfter: intent.applyAfter,
    });
    return;
  }

  if (view.callback_id === 'deny_reason') {
    const reason = view.state?.values?.reason?.text?.value?.trim();
    if (!reason) return ephemeral('a denial needs a reason — it is what the agent learns from');
    const d = ledger.recordDecision({
      workItemId: item.id, actorSlackId: clicker, decision: 'deny', reason,
      slackEventId: eventKey(payload),
    });
    if (d.duplicate) return;
    // Denials are instant: an undone denial can simply be re-decided, so the
    // undo window exists only on the side that causes sends.
    await applyNow(item.id);
    await updateCard(ledger.getWorkItem(item.id), { decision: { decision: 'deny', reason } });
    return;
  }
}

function eventKey(payload) {
  // Slack retries interactions; trigger_id (block_actions) and view.id + hash
  // (submissions) identify a specific human action uniquely enough to dedupe.
  return payload.trigger_id
    ?? (payload.view ? `${payload.view.id}:${payload.view.hash}` : null);
}

/** Re-render helper the host uses for card updates. */
export function renderCard(item, { cfg, decision, applyAfter }) {
  return cardForState(item, {
    cfg,
    ownerSlackId: ownerSlackIdFor(cfg, item.owner_provider_id),
    decision,
    applyAfter,
  });
}
