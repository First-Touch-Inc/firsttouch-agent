#!/usr/bin/env node
// The send guard.
//
// A PreToolUse hook that blocks any tool call which could put a message in
// front of a real person without a human approving it first.
//
// WHY THIS EXISTS AS CODE AND NOT AS AN INSTRUCTION
// The skills tell the agent to create approval-gated actions. That is guidance,
// and guidance is not a control: a prompt can be misread, a model can be talked
// out of it by injected text in a prospect's bio, and a future edit to a skill
// can quietly drop the rule. This file is the actual guarantee. If the README
// says nothing sends without approval, this is the reason that sentence is
// allowed to be there.
//
// It denies rather than asks, because there is no human at a terminal during a
// scheduled run — an "ask" would hang the job until it timed out.
//
// Wired up in .claude/settings.json. Reads the hook payload on stdin and writes
// a permission decision on stdout.

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let payload = {};
try {
  payload = JSON.parse(raw || '{}');
} catch {
  // A malformed payload means we cannot tell what is being called. Fail closed.
  deny('The send guard could not parse the tool call, so it was blocked. This is a bug — please report it.');
}

const toolName = String(payload.tool_name || '');
const input = payload.tool_input || {};
const dryRun = process.env.DRY_RUN === '1';

function deny(reason) {
  // The reason is returned to the model as the tool result, so it explains
  // itself and moves on rather than retrying blindly.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function allow() {
  // Staying silent lets the normal permission flow proceed. We deliberately do
  // not return "allow" — that would override the operator's own settings.
  process.exit(0);
}

// --- 1. Tools that deliver a message immediately -----------------------------
// These bypass the approval queue by definition. There is no configuration that
// turns this off, and that is the point.
const IMMEDIATE_SEND = /^mcp__outreach__(send_|.*_send$|.*send_message|send_linkedin|send_email|send_now)/i;

if (IMMEDIATE_SEND.test(toolName)) {
  deny(
    `Blocked by the send guard: "${toolName}" delivers a message directly to a person, ` +
    `bypassing the approval queue. This agent may only CREATE approval-gated actions ` +
    `that a human reviews and approves. Use the approval-gated action tool instead, ` +
    `and if no such tool exists for this channel, report it as a blocker rather than sending.`,
  );
}

// --- 2. Anything that mutates, during a dry run ------------------------------
// Match the verb as a word anywhere after the server prefix, not just at the
// start: tools are named both `update_property` and `crm_update_property`
// depending on the adapter, and anchoring to the start silently misses the
// second form. A guard that quietly fails open is worse than no guard.
const bareName = toolName.replace(/^mcp__[a-z0-9_]+?__/i, '');
const MUTATING = /(^|_)(create|add|update|set|enroll|remove|delete|complete|edit|manage|publish|import|bulk|assign|merge|skip|start|send|cancel|archive)(_|$)/i;

if (dryRun && MUTATING.test(bareName)) {
  deny(
    `Blocked by the send guard: this is a DRY RUN (DRY_RUN=1), so "${toolName}" was not executed. ` +
    `Continue the run normally — research, qualify and draft as usual — but create nothing. ` +
    `Record what you WOULD have created in the run report so a human can review it.`,
  );
}

// --- 3. Approval-gated creation must actually be approval-gated --------------
// Creating an action with approval switched off produces something that sends
// the moment it is created. Some platforms default this to false, so an omitted
// flag is not safe to treat as "approval on".
const CREATES_ACTION = /^mcp__outreach__(add_dynamic_action|create_.*action|enroll|add_manual_flow_enrollment)/i;

if (CREATES_ACTION.test(toolName)) {
  const flat = JSON.stringify(input);
  const approvalOff = /"(isHumanApprovalRequired|requiresApproval|human_approval|approval_required)"\s*:\s*false/i.test(flat);
  const approvalMissing = !/"(isHumanApprovalRequired|requiresApproval|human_approval|approval_required)"/i.test(flat);

  if (approvalOff || approvalMissing) {
    deny(
      `Blocked by the send guard: "${toolName}" was called ${approvalOff ? 'with human approval explicitly disabled' : 'without setting the human-approval flag'}. ` +
      `Every action this agent creates must require human approval before it can send. ` +
      `Set the approval flag to true and call it again. Do not work around this by using a different tool.`,
    );
  }

  // An action with no explicit owner is assigned to whichever user the API
  // token belongs to — which means an approved draft sends from the wrong
  // person's account, and that cannot be undone afterwards.
  const hasOwner = /"(ownerId|owner_id|assignedUserId|assigned_user_id)"\s*:\s*"[^"]+"/i.test(flat);
  if (!hasOwner) {
    deny(
      `Blocked by the send guard: "${toolName}" was called without an explicit owner. ` +
      `Pass the owner's provider_user_id (from approval_routing.owners in the tenant config) ` +
      `as BOTH the owner and the assigned-user field. Without it the platform assigns the action ` +
      `to the authenticated API user, so approving it would send this message from the wrong ` +
      `person's account — which is not reversible.`,
    );
  }
}

allow();
