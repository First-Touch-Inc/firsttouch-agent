// Slack Block Kit builders for the approval loop.
//
// The one security rule in this file: BUTTON VALUES CARRY ONLY AN OPAQUE WORK
// ITEM ID. Everything consequential — owner, task ids, copy, state — is
// re-read from the ledger by the click handler. A card round-trips through
// Slack, so anything else it carried would be something an altered payload
// could inject. (The click handler additionally ignores any field it does not
// expect.)
//
// Rendering rules from production:
//  - the card names WHO it sends as, and that only they can approve;
//  - a motion badge says which job drafted it;
//  - the full first-touch copy is visible on the card, not behind a click;
//  - decisions re-render the same message (chat.update) so a channel is a
//    live queue, not a scroll of stale cards.

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
const divider = { type: 'divider' };

const MOTION_BADGES = {
  outbound: 'Outbound',
  inbound: 'Inbound',
  deal_followup: 'Pipeline',
  cs_postclose: 'Success',
  chat: 'Chat',
};

export function motionBadge(item, cfg) {
  const motion = cfg?.motions?.find((m) => m.id === item.motion);
  return MOTION_BADGES[motion?.kind] ?? MOTION_BADGES[item.motion] ?? item.motion;
}

const opaque = (item) => JSON.stringify({ w: item.id });

function truncate(s, n = 600) {
  const str = String(s ?? '');
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

/** The pending card for a single work item. */
export function buildCard(item, { cfg, ownerSlackId }) {
  const badge = motionBadge(item, cfg);
  const blocks = [];

  if (item.payload.campaign) return buildCampaignCard(item, { cfg, ownerSlackId });

  if (item.kind === 'outreach' && item.payload.flow_enrolment) {
    const s = item.payload.subject ?? {};
    blocks.push(section(
      `*[${badge}] Enrol into flow: ${item.payload.flow_enrolment.flow_name}*\n` +
      `*${s.name ?? s.email ?? 'Unknown'}*${s.title ? ` — ${s.title}` : ''}${s.company ? `, ${s.company}` : ''}`,
    ));
  } else if (item.kind === 'outreach') {
    const s = item.payload.subject ?? {};
    blocks.push(section(
      `*[${badge}] ${s.name ?? s.email ?? 'Unknown'}*` +
      `${s.title ? ` — ${s.title}` : ''}${s.company ? `, ${s.company}` : ''}`,
    ));
    if (item.payload.why) blocks.push(section(`*Why:* ${truncate(item.payload.why, 300)}`));
    for (const [i, step] of (item.payload.steps ?? []).entries()) {
      blocks.push(section(`*Step ${i + 1} · ${step.channel}*\n${truncate(step.copy)}`));
    }
  } else if (item.kind === 'crm_change') {
    blocks.push(section(`*[${badge}] Proposed CRM changes*${item.payload.why ? `\n${truncate(item.payload.why, 300)}` : ''}`));
    for (const c of item.payload.changes) {
      blocks.push(section(`• \`${c.object_type} ${c.object_id}\` ${c.field}: *${c.from}* → *${c.to}*`));
    }
  } else if (item.kind === 'unsent_draft') {
    blocks.push(section(`*[${badge}] UNSENT draft: ${truncate(item.payload.title, 150)}*\n${truncate(item.payload.body)}`));
    blocks.push(context('This is a draft only — approving it saves it, nothing is sent.'));
  } else if (item.kind === 'report') {
    blocks.push(section(`*[${badge}] Report*\n${(item.payload.lines ?? []).map((l) => `• ${truncate(l, 200)}`).join('\n')}`));
    return blocks; // reports have no sender and no buttons
  }

  blocks.push(context(
    ownerSlackId
      ? `Sends as <@${ownerSlackId}>. Only they can approve it. Expires ${item.expires_at.slice(0, 16)}Z.`
      : `Expires ${item.expires_at.slice(0, 16)}Z.`,
  ));
  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', style: 'primary', action_id: 'approve',
        text: { type: 'plain_text', text: 'Approve' }, value: opaque(item) },
      { type: 'button', action_id: 'review',
        text: { type: 'plain_text', text: 'Edit & approve' }, value: opaque(item) },
      { type: 'button', style: 'danger', action_id: 'deny',
        text: { type: 'plain_text', text: 'Deny…' }, value: opaque(item) },
    ],
  });
  return blocks;
}

/** One batch card for a chat-authored campaign. */
export function buildCampaignCard(item, { cfg, ownerSlackId }) {
  const c = item.payload.campaign;
  const blocks = [
    section(`*[Campaign] ${c.name}*\n${truncate(c.why, 300)}`),
    section(
      `*${c.admitted.length} contacts* · ${c.excluded.length} excluded` +
      (c.excluded.length
        ? ` (${summariseExclusions(c.excluded)})`
        : ''),
    ),
  ];
  for (const [i, step] of c.steps.entries()) {
    blocks.push(section(`*Step ${i + 1} · ${step.channel}*\n${truncate(step.copy)}`));
  }
  const sample = c.admitted.slice(0, 5)
    .map((m) => m.subject.name ?? m.subject.email ?? '?').join(', ');
  blocks.push(context(`Sample: ${sample}${c.admitted.length > 5 ? ', …' : ''}`));
  blocks.push(context(
    `One approval sends to all ${c.admitted.length}, dripped under your daily caps. ` +
    (ownerSlackId ? `Sends as <@${ownerSlackId}>. ` : '') +
    'Every contact is re-screened at send time.',
  ));
  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', style: 'primary', action_id: 'approve',
        text: { type: 'plain_text', text: `Approve all ${c.admitted.length}` }, value: opaque(item) },
      { type: 'button', action_id: 'review',
        text: { type: 'plain_text', text: 'Edit & approve' }, value: opaque(item) },
      { type: 'button', style: 'danger', action_id: 'deny',
        text: { type: 'plain_text', text: 'Deny…' }, value: opaque(item) },
    ],
  });
  return blocks;
}

function summariseExclusions(excluded) {
  const counts = {};
  for (const e of excluded) {
    const kind = /suppress/i.test(e.reason) ? 'suppressed'
      : /duplicate/i.test(e.reason) ? 'duplicates'
      : /cap|limit/i.test(e.reason) ? 'over caps' : 'other';
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
}

/** The edit modal: one multiline input per step, prefilled with the draft.
 *  block_id / action_id encode the step index; private_metadata carries only
 *  the opaque id. NOTE FOR CALLERS: views.open must be the FIRST call after
 *  the envelope ack — trigger_id dies in ~3 seconds; do every check on
 *  view_submission, where there is no deadline. */
export function buildEditModal(item) {
  const steps = item.payload.campaign?.steps ?? item.payload.steps ??
    [{ channel: 'draft', copy: item.payload.body ?? '' }];
  return {
    type: 'modal',
    callback_id: 'edit_approve',
    private_metadata: opaque(item),
    title: { type: 'plain_text', text: 'Edit & approve' },
    submit: { type: 'plain_text', text: 'Approve edited' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: steps.map((step, i) => ({
      type: 'input',
      block_id: `step_${i}`,
      label: { type: 'plain_text', text: `Step ${i + 1} · ${step.channel}` },
      element: {
        type: 'plain_text_input',
        action_id: 'copy',
        multiline: true,
        initial_value: step.copy ?? '',
      },
    })),
  };
}

/** The deny modal: the reason is required because it is the learning input. */
export function buildDenyModal(item) {
  return {
    type: 'modal',
    callback_id: 'deny_reason',
    private_metadata: opaque(item),
    title: { type: 'plain_text', text: 'Deny' },
    submit: { type: 'plain_text', text: 'Deny' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [{
      type: 'input',
      block_id: 'reason',
      label: { type: 'plain_text', text: 'Why? (the agent learns from this)' },
      element: { type: 'plain_text_input', action_id: 'text', multiline: true },
    }],
  };
}

/** Extract {stepIndex: newCopy} from an edit-modal submission. */
export function editsFromSubmission(view) {
  const edits = {};
  for (const [blockId, actions] of Object.entries(view.state?.values ?? {})) {
    const m = blockId.match(/^step_(\d+)$/);
    if (m && actions.copy) edits[m[1]] = actions.copy.value ?? '';
  }
  return edits;
}

/** Re-render a card for its current state. */
export function cardForState(item, { cfg, ownerSlackId, decision, applyAfter }) {
  const badge = motionBadge(item, cfg);
  const head = item.payload.campaign
    ? `*[Campaign] ${item.payload.campaign.name}*`
    : `*[${badge}] ${item.payload.subject?.name ?? item.payload.title ?? item.kind}*`;

  switch (item.status) {
    case 'undo_window':
      return [
        section(`${head}\n✅ Approved${decision?.edits ? ' (edited)' : ''} — applies at ${applyAfter?.slice(11, 19)}Z.`),
        {
          type: 'actions',
          elements: [{
            type: 'button', style: 'danger', action_id: 'undo',
            text: { type: 'plain_text', text: 'Undo' }, value: opaque(item),
          }],
        },
      ];
    case 'applied':
      return [section(`${head}\n✅ Done.`), context(itemResultLine(item))];
    case 'denied':
      return [section(`${head}\n❌ Denied: ${truncate(decision?.reason ?? '', 300)}`)];
    case 'expired':
      return [section(`${head}\n⌛ Expired unactioned — nothing was applied.`)];
    case 'conflict':
      return [section(`${head}\n⚠️ Not applied — see thread for what conflicted.`)];
    default:
      return buildCard(item, { cfg, ownerSlackId });
  }
}

function itemResultLine(item) {
  if (item.payload.campaign) return 'Campaign dripping under your daily caps.';
  if (item.kind === 'crm_change') return 'Applied with compare-and-set — untouched values were left alone.';
  if (item.kind === 'unsent_draft') return 'Saved as a draft. Nothing was sent.';
  return 'Sent with the approved copy.';
}

/** The run digest posted to the digest channel. */
export function digestBlocks({ motionId, staged, refused, notes = [] }) {
  const lines = [];
  lines.push(`*${motionId}* — ${staged} card${staged === 1 ? '' : 's'} staged, ${refused.length} skipped`);
  for (const r of refused.slice(0, 15)) lines.push(`• skipped: ${truncate(r, 180)}`);
  if (refused.length > 15) lines.push(`• …and ${refused.length - 15} more`);
  for (const n of notes) lines.push(`• ${truncate(n, 180)}`);
  return [section(lines.join('\n'))];
}
