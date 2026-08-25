// Slack approval cards: building them, and acting on a click.
//
// The button is a convenience, never a second source of truth. Clicking Approve
// calls the same platform API the queue's own UI calls, so a card and the queue
// cannot disagree — if the task was already actioned there, the platform says so
// and the card reports it rather than acting twice.
//
// Two rules are load-bearing:
//
//   1. Only the OWNER may approve their own card. Approving someone else's
//      outreach sends it from THEIR account, under their name. That is the exact
//      failure this project spends the most effort preventing, and a button is
//      the easiest place to reintroduce it.
//   2. The card carries the task id and the owner, and nothing else that
//      matters. Slack round-trips `value` back to us verbatim, so it is caller-
//      supplied by the time we see it — every consequential fact is re-checked
//      against the platform, never trusted from the payload.

import { connect } from './mcp-client.mjs';

/** Slack truncates hard; keep previews readable rather than complete. */
const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * One approval card. `plan` is what the agent produced for a single person.
 */
export function buildApprovalCard(plan, { queueUrl } = {}) {
  const who = [plan.contact_name, plan.contact_title && `(${plan.contact_title})`, plan.company && `· ${plan.company}`]
    .filter(Boolean).join(' ');

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${clip(who, 150)}*` } },
  ];

  if (plan.why) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `:mag: ${clip(plan.why, 300)}` }] });
  }
  if (plan.first_message) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + clip(plan.first_message, 1200) + '```' } });
  }

  const owner = plan.owner_slack_id ? `<@${plan.owner_slack_id}>` : (plan.owner || 'unassigned');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Sends as ${owner}. Only they can approve it.` }] });

  // No task id means nothing to act on — show the card, but do not pretend a
  // button would work.
  const taskIds = Array.isArray(plan.task_ids) ? plan.task_ids.filter(Boolean) : [];
  if (taskIds.length === 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ':warning: No task id on this plan, so it can only be actioned in the queue.' }] });
  } else {
    const value = JSON.stringify({ t: taskIds[0], o: plan.owner_provider_user_id || null });
    const elements = [
      { type: 'button', style: 'primary', action_id: 'approve', text: { type: 'plain_text', text: 'Approve' }, value },
      { type: 'button', action_id: 'skip', text: { type: 'plain_text', text: 'Skip' }, value },
    ];
    if (queueUrl) {
      elements.push({ type: 'button', action_id: 'open_queue', text: { type: 'plain_text', text: 'Open queue' }, url: queueUrl });
    }
    blocks.push({ type: 'actions', elements });
  }

  return blocks;
}

/**
 * Act on a click. Returns a short line to show the human.
 *
 * `clicker` is the Slack user id from Slack's authenticated envelope — not from
 * anything the payload carried — so the ownership check below is meaningful.
 */
export async function applyDecision({ decision, value, clicker, cfg, ownerSlackIdFor }) {
  let parsed;
  try { parsed = JSON.parse(value || '{}'); } catch { parsed = {}; }
  const taskId = parsed.t;
  const ownerProviderId = parsed.o;

  if (!taskId) return 'That card has no task id, so there is nothing for me to action. Use the queue.';

  // Rule 1: the owner approves their own outreach. An override list exists for
  // managers, but it is opt-in and named, never implicit.
  const overrides = new Set(cfg.approval_routing?.approval_overrides || []);
  const ownerSlackId = ownerProviderId ? ownerSlackIdFor(ownerProviderId) : null;
  if (ownerSlackId && ownerSlackId !== clicker && !overrides.has(clicker)) {
    return `That one sends as <@${ownerSlackId}>, so it is theirs to approve. Approving someone else's outreach sends it from their account under their name.`;
  }

  const url = cfg.providers?.outreach?.mcp_url || process.env.FT_MCP_URL || 'https://mcp.firsttouch.ai';
  const token = process.env.FT_MCP_TOKEN;
  if (!token) return 'FT_MCP_TOKEN is not set on this process, so I cannot action the task.';

  const client = await connect({ url, token });
  const tool = decision === 'approve' ? 'complete_task' : 'skip_task';
  const { text, isError } = await client.callTool(tool, { taskId });

  if (isError) {
    // Most often: someone already actioned it in the queue. That is the two
    // surfaces agreeing, not a failure.
    return `The platform would not ${decision === 'approve' ? 'approve' : 'skip'} that: ${clip(text, 300)}`;
  }
  return decision === 'approve'
    ? `Approved by <@${clicker}> — the platform has it.`
    : `Skipped by <@${clicker}>.`;
}
