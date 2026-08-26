#!/usr/bin/env node
// The send guard.
//
// A PreToolUse hook that blocks any tool call which could put a message in
// front of a real person without a human approving it first.
//
// WHY THIS IS CODE AND NOT AN INSTRUCTION
// CLAUDE.md tells the agent that every outreach action is approval-gated. That
// is guidance, and guidance is not a control: a model can be talked out of it
// by injected text in a prospect's bio, and an edit to the instructions can
// quietly drop the rule. This file is the actual guarantee. If the README says
// nothing reaches a prospect without human approval, this is why that sentence
// is allowed to be there. It is the same control FirstTouch runs on its own
// internal agents.
//
// SCOPE IS DELIBERATELY NARROW. The agent legitimately reads and writes the
// CRM, drafts email, researches, edits its own workspace and schedules. None
// of that is touched. Only these are blocked:
//
//   1. Tools that deliver a message to a person immediately.
//   2. Email sending — recaps and follow-ups are UNSENT drafts only.
//   3. Creating an outreach action without human approval required.
//   4. Creating an outreach action without an explicit owner.
//   5. Completing an approval task — approving is the human's half.
//   6. Authoring or publishing flows — flow copy sends automatically, so a
//      human writes and publishes it; the agent only enrols into it.
//
// Connector tools arrive as mcp__<server-or-uuid>__<tool>, so every check keys
// off the BARE TOOL NAME after the prefix — a rename or a UUID-namespaced
// connector can never quietly disarm the guard.
//
// Wired up in .claude/settings.json. Removing or weakening this file makes the
// project's central promise false.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

function deny(reason) {
  // The reason is returned to the model as the tool result, so it explains
  // itself and moves on instead of retrying blindly.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// Staying silent lets the normal permission flow proceed. Never return
// "allow" — that would override settings rather than subtract from them.
const allow = () => process.exit(0);

let payload;
try {
  payload = JSON.parse(raw || '{}');
} catch {
  // Cannot tell what is being called, so cannot clear it. Fail closed.
  deny('The send guard could not parse the tool call, so it was blocked. Report this — it is a bug in the guard, not in the run.');
}

const toolName = String(payload.tool_name || '');
const input = payload.tool_input || {};

// Only MCP tools are inspected; built-ins (Bash, Read, Edit…) pass through to
// the normal permission flow.
if (!/^mcp__/i.test(toolName)) allow();
const bare = toolName.replace(/^mcp__[^_]*(?:_[^_]+)*?__/i, '').replace(/^mcp__/i, '');

const flat = JSON.stringify(input);

// --- 1. Immediate person-facing sends ----------------------------------------
// Anything that delivers on call, bypassing every queue. There is no
// configuration that turns this off, and that is the point.
const IMMEDIATE_SEND = /^(send_linkedin_unibox_message|send_campaign|send_now)$/i;
if (IMMEDIATE_SEND.test(bare)) {
  deny(
    `Blocked by the send guard: "${bare}" delivers a message to a person immediately, ` +
    `bypassing the approval queue. Create an approval-gated action instead, or report ` +
    `a blocker if no approval-gated path exists for this channel.`,
  );
}

// --- 2. Email drafts, never sends --------------------------------------------
// Matched exactly, so a Slack connector's slack_send_message (a message to the
// TEAM, not a prospect) is not caught.
const EMAIL_SEND = /^(send_message|reply|forward|send_email)$/i;
if (EMAIL_SEND.test(bare)) {
  deny(
    `Blocked by the send guard: "${bare}" sends email. This agent creates UNSENT ` +
    `drafts only — use create_draft and leave it for a human to send.`,
  );
}

// --- 3 & 4. Outreach actions: approval on, owner explicit --------------------
if (/^add_dynamic_action$/i.test(bare)) {
  const approvalOff = /"(isHumanApprovalRequired|requiresApproval)"\s*:\s*false/i.test(flat);
  const approvalMissing = !/"(isHumanApprovalRequired|requiresApproval)"/i.test(flat);
  if (approvalOff || approvalMissing) {
    deny(
      `Blocked by the send guard: add_dynamic_action was called ${approvalOff ? 'with human approval disabled' : 'without setting isHumanApprovalRequired'}. ` +
      `Every person-facing action this agent creates is approval-gated. Set ` +
      `isHumanApprovalRequired: true and call it again. Do not work around this with a different tool.`,
    );
  }

  // BOTH fields, not either: omitting them assigns the task to the
  // MCP-authenticated user with a null sender, so approving it sends someone
  // else's outreach from the wrong mailbox — and an enrollment's owner cannot
  // be reassigned after the fact.
  const hasOwner = /"ownerId"\s*:\s*"[^"]+"/i.test(flat);
  const hasAssignee = /"assignedUserId"\s*:\s*"[^"]+"/i.test(flat);
  if (!hasOwner || !hasAssignee) {
    const missing = [!hasOwner && 'ownerId', !hasAssignee && 'action.assignedUserId'].filter(Boolean).join(' and ');
    deny(
      `Blocked by the send guard: add_dynamic_action is missing ${missing}. ` +
      `Pass the owner's FirstTouch user id as BOTH ownerId and action.assignedUserId, ` +
      `then verify with list_user_tasks that task.owner.email is the intended sender ` +
      `before telling anyone the draft is staged.`,
    );
  }
}

// --- 5. Approving is the human's half ----------------------------------------
// complete_task is how an approval task gets approved-and-executed. If the
// agent could call it, it could approve its own drafts and the gate would be
// decorative. Skipping and cancelling stay allowed — both are the safe
// direction.
if (/^complete_task$/i.test(bare)) {
  deny(
    `Blocked by the send guard: complete_task approves and executes a task, and ` +
    `approving is the human's half of this system. The person it belongs to approves ` +
    `it in FirstTouch. If they asked you to approve it for them, tell them it needs ` +
    `their own click.`,
  );
}

// --- 6. Flows: enrol yes, author no ------------------------------------------
// A flow's copy sends automatically once published, so writing or publishing
// one is authoring outreach nobody will review per-send. A human does that.
// Enrolling a qualified person into an already-published flow is the agent's
// job — the copy in it was written and published by a human.
const FLOW_AUTHORING = /^(create_flow_plan|update_flow_plan|replace_flow_root|manage_flow_publication)$/i;
if (FLOW_AUTHORING.test(bare)) {
  deny(
    `Blocked by the send guard: "${bare}" creates or publishes a flow. The agent ` +
    `decides WHO belongs in a flow, never what a flow says or whether it goes live. ` +
    `Ask a human to author and publish it, then enrol into it.`,
  );
}

// Optional tightening: if approved-flows.txt exists at the repo root (one flow
// id per line, # comments), enrolment is limited to the ids in it. Without the
// file, enrolment into any PUBLISHED flow is allowed — published means a human
// wrote the copy and chose to make it live.
const FLOW_ENROLLMENT = /^(add_manual_flow_enrollment|enroll_awaiting_flow_items|reenroll_flow_enrollments|attach_audience_to_flow)$/i;
if (FLOW_ENROLLMENT.test(bare)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(resolve(here, '..', '..'), 'approved-flows.txt');
  if (existsSync(file)) {
    let allowed;
    try {
      allowed = new Set(
        readFileSync(file, 'utf8').split(/\r?\n/)
          .map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean),
      );
    } catch {
      deny(`Blocked by the send guard: approved-flows.txt exists but could not be read, so enrolment is refused. Fix the file and retry.`);
    }
    const referenced = [...flat.matchAll(/"(?:flow_?plan_?id|flowPlanId|flowId|flow_id)"\s*:\s*"([^"]+)"/gi)].map((m) => m[1]);
    if (referenced.length === 0) {
      deny(`Blocked by the send guard: "${bare}" was called without naming a flow id, so it cannot be checked against approved-flows.txt. Pass the flow id explicitly.`);
    }
    const forbidden = referenced.filter((id) => !allowed.has(id));
    if (forbidden.length) {
      deny(
        `Blocked by the send guard: flow ${forbidden.join(', ')} is not listed in approved-flows.txt ` +
        `(permitted: ${[...allowed].join(', ') || 'none'}). Ask the operator to add it if it belongs there.`,
      );
    }
  }
}

allow();
