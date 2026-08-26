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
// says the agent never writes a message and sends it, this is the reason that
// sentence is allowed to be there.
//
// It denies rather than asks, because there is no human at a terminal during a
// scheduled run — an "ask" would hang the job until it timed out.
//
// Wired up in .claude/settings.json. Reads the hook payload on stdin and writes
// a permission decision on stdout.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Flow ids the operator declared in `flows:`. Read here rather than passed in,
 * because a hook that trusts its own arguments for the allowlist is not a
 * control — the point is that this cannot be talked out of the check.
 *
 * Returns a Set, or null when the config cannot be read at all (caller denies).
 */
function allowedFlowIds() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, '..', '..');
    // Match the engine's config resolution: CONFIG_DIR (the writable volume in
    // a container) or <root>/config, and AGENT_CONFIG (default 'agent').
    const dir = process.env.CONFIG_DIR
      ? (isAbsolute(process.env.CONFIG_DIR) ? process.env.CONFIG_DIR : resolve(root, process.env.CONFIG_DIR))
      : join(root, 'config');
    const name = process.env.AGENT_CONFIG || 'agent';
    const path = join(dir, `${name}.yaml`);
    if (!existsSync(path)) return new Set();

    // Deliberately a line scan rather than a YAML parse: this hook must not
    // depend on node_modules resolving from wherever the agent was launched.
    const ids = new Set();
    let inFlows = false;
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '');
      if (/^flows\s*:/.test(line)) { inFlows = true; continue; }
      if (inFlows && /^\S/.test(line)) break;          // dedented out of the block
      if (!inFlows) continue;
      const m = line.match(/^\s*-?\s*id\s*:\s*["']?([^"'\s]+)["']?\s*$/);
      if (m) ids.add(m[1]);
    }
    return ids;
  } catch {
    return null;
  }
}

function allow() {
  // Staying silent lets the normal permission flow proceed. We deliberately do
  // not return "allow" — that would override the operator's own settings.
  process.exit(0);
}

// --- 0. Unknown MCP servers --------------------------------------------------
// Only servers the deployment explicitly permits may reach the model. Anything
// else means the session was wired differently than designed, and an unknown
// tool surface cannot be reasoned about — deny it wholesale.
//
// Matched by PREFIX, not by parsing the server name out of the tool name.
// Claude Code sanitises a server name into the tool prefix by replacing invalid
// characters with underscores, so a connector called "plugin:founder-pack:
// firsttouch" arrives as `mcp__plugin_founder-pack_firsttouch__…`. The previous
// version matched `^mcp__([a-z0-9-]+)__`, whose character class excludes the
// underscore: the match simply FAILED on such a name and the check fell through
// to allow. A guard that silently stops applying to exactly the servers most
// worth guarding is worse than no guard at all.
const ALLOWED_MCP_SERVERS = (process.env.GUARD_MCP_SERVERS || 'agent')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (/^mcp__/i.test(toolName)) {
  const permitted = ALLOWED_MCP_SERVERS.some((s) => toolName.toLowerCase().startsWith(`mcp__${s.toLowerCase()}__`));
  if (!permitted) {
    deny(
      `Blocked by the send guard: "${toolName}" belongs to an MCP server this agent is not ` +
      `designed to talk to (permitted: ${ALLOWED_MCP_SERVERS.join(', ')}). Platform access goes ` +
      `through servers the deployment declared, so suppression, caps, ownership and approvals ` +
      `are enforced in code rather than assumed.`,
    );
  }
}

// The tool name with its `mcp__<server>__` prefix removed. The character class
// MUST include the hyphen and underscore for the same sanitised-name reason as
// above; without them this left the prefix attached and every rule below —
// which matches on bare verbs — silently stopped matching.
const bareName = toolName.replace(/^mcp__[a-z0-9_-]+?__/i, '');

// --- 1. Tools that deliver a message immediately -----------------------------
// These bypass the approval queue by definition. There is no configuration that
// turns this off, and that is the point.
// Matched against the BARE name so it holds whatever the server is called.
// Anchoring to `mcp__outreach__` meant the rule stopped applying the moment the
// platform arrived as a connector under its own name.
const IMMEDIATE_SEND = /(^|_)(send_message|send_linkedin|send_email|send_now)(_|$)|^send_|_send$/i;

if (IMMEDIATE_SEND.test(bareName)) {
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
const MUTATING =/(^|_)(create|add|update|set|enroll|remove|delete|complete|edit|manage|publish|import|bulk|assign|merge|skip|start|send|cancel|archive)(_|$)/i;

if (dryRun && MUTATING.test(bareName)) {
  deny(
    `Blocked by the send guard: this is a DRY RUN (DRY_RUN=1), so "${toolName}" was not executed. ` +
    `Continue the run normally — research, qualify and draft as usual — but create nothing. ` +
    `Record what you WOULD have created in the run report so a human can review it.`,
  );
}

// --- 2b. Flows: the agent may enrol, but may not author or publish -----------
// A flow's copy was written and published by a human, so enrolling a qualified
// person into one does not need a second approval of that copy. Creating or
// publishing a flow is the opposite: it is authoring content that will send
// automatically, which is exactly the human's job.
const FLOW_AUTHORING = /(^|_)(create_flow_plan|update_flow_plan|replace_flow_root|manage_flow_publication)(_|$)/i;

if (FLOW_AUTHORING.test(bareName)) {
  deny(
    `Blocked by the send guard: "${toolName}" creates or publishes a flow. ` +
    `The agent decides WHO belongs in a flow, never what a flow says or whether ` +
    `it goes live — that copy sends automatically, so a human authors and ` +
    `publishes it. Enrol into an already-published flow instead, or report this ` +
    `as a blocker if no suitable flow exists.`,
  );
}

const FLOW_ENROLLMENT = /(^|_)(add_manual_flow_enrollment|enroll_awaiting_flow_items|reenroll_flow_enrollments|attach_audience_to_flow)(_|$)/i;

if (FLOW_ENROLLMENT.test(bareName)) {
  // Only flows the operator declared. Without this, a misconfigured or
  // misled run could drop someone into any campaign in the workspace — and
  // unlike a dynamic action, nobody reads that message before it sends.
  const allowed = allowedFlowIds();
  const flat = JSON.stringify(input);

  if (allowed === null) {
    deny(
      `Blocked by the send guard: could not read the tenant config to check which ` +
      `flows are permitted, so enrolment is refused. Fix the config and retry.`,
    );
  }
  if (allowed.size === 0) {
    deny(
      `Blocked by the send guard: no flows are declared in the tenant config, so ` +
      `"${toolName}" has nothing it is permitted to enrol into. Either add the flow ` +
      `under \`flows:\` in config/tenant.yaml, or create an approval-gated dynamic ` +
      `action instead.`,
    );
  }
  const referenced = [...flat.matchAll(/"(?:flow_?plan_?id|flowPlanId|flowId|flow_id)"\s*:\s*"([^"]+)"/gi)].map((m) => m[1]);
  if (referenced.length === 0) {
    deny(
      `Blocked by the send guard: "${toolName}" was called without naming a flow id, ` +
      `so the guard cannot check it against the permitted list. Pass the flow id explicitly.`,
    );
  }
  const forbidden = referenced.filter((id) => !allowed.has(id));
  if (forbidden.length) {
    deny(
      `Blocked by the send guard: flow ${forbidden.join(', ')} is not listed under \`flows:\` ` +
      `in the tenant config. Permitted: ${[...allowed].join(', ')}. Enrolling into an ` +
      `undeclared flow would send this person messages nobody chose for them.`,
    );
  }
  // Permitted flow, real run — allowed through without an approval flag, by design.
  allow();
}

// --- 3. Approval-gated creation must actually be approval-gated --------------
// Creating an action with approval switched off produces something that sends
// the moment it is created. Some platforms default this to false, so an omitted
// flag is not safe to treat as "approval on".
const CREATES_ACTION = /^(add_dynamic_action|create_.*action)/i;

if (CREATES_ACTION.test(bareName)) {
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
