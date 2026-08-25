# Security

The threat model for a self-hosted FirstTouch Agent. This is about *your*
deployment; for the obligations that come with contacting people, read
[safety-and-compliance.md](safety-and-compliance.md). To report a vulnerability
in this repo, see [SECURITY.md](../SECURITY.md).

## The shape that removes whole vulnerability classes

- **No inbound listener.** The host dials OUT to Slack over Socket Mode and to
  your CRM and FirstTouch. The Dockerfile declares no `EXPOSE`, the compose file
  has no `ports:`, and there is no webhook. Nothing on the internet can reach
  it, so there is no request-forgery, no unauthenticated endpoint, no public URL
  to mispoint.
- **One always-on process.** `runner/host.mjs` owns the Slack connection, the
  schedule, the approval loop, and every credential. It refuses to start if a
  second instance holds the lock (two would split Slack clicks), and it asserts
  its own Slack bot identity against the ledger at boot so a wrong deployment
  cannot silently swallow approvals.

## The model holds no credentials

This is the load-bearing control. Each reasoning turn is a short-lived headless
Claude session **spawned with its credentials stripped**:

- `modelEnv()` removes every provider token, every `external_tools` token env,
  and anything name-matching a secret from the child's environment.
- The child's only tool surface is the agent tool server (`mcp__agent__*`),
  which runs as a subprocess that receives the tokens through an MCP-config file
  the child cannot read — that file lives in a `chmod 700` run directory that is
  deny-listed from the model's `Read`/`Glob`/`Grep`, along with `/proc`, `/sys`,
  `*.db`, and `.env*`.
- Motion and learning sessions — the ones that read the most attacker-controlled
  text (bios, CRM notes, transcripts) — get **no `WebFetch`/`WebSearch`** at all,
  so there is no egress channel to exfiltrate to. Only operator-driven chat and
  onboarding keep web research.

Consequence: even a fully prompt-injected model cannot call an external API
directly, cannot read a token, and cannot post one anywhere.

## Enforcement lives in code, not prompts

Everything that could put a message in front of a person is a named function in
`runner/lib/tools-core.mjs` with a closed schema — there is no generic
"call anything" tool and no free-string dispatch. Every staging path runs the
same gauntlet in code: identity resolution, suppression (with a domain backstop,
seeded from your DNC file + `excluded_domains` + CRM customers), an atomic cap
reservation, and a config-declared owner. Nothing sends; the agent only stages
work items that a human then approves. The deterministic apply path
(`runner/lib/apply.mjs`) writes the approved copy to the platform, reads it back
to verify, and only then completes — the human's edit cannot be silently lost,
and a task on the wrong owner is cancelled rather than sent.

The `PreToolUse` hook (`.claude/hooks/guard-send.mjs`) is defense in depth on top
of this: it denies any MCP server that is not the agent tool server, and any
direct-send tool, failing closed on an unparseable call.

## What an attacker who injects instructions can and cannot do

Injected text in a prospect bio, CRM note, or transcript may influence a draft —
which a human then reviews and can deny. It **cannot**: send or complete a touch;
approve its own work; write a CRM value; select a different sender; contact a
suppressed person or domain; raise a cap; enrol an undeclared flow; start a
campaign (campaign tools exist only in operator chat sessions); write a rule
(lessons are distilled only from human-typed edits and deny reasons, inserted by
host code); read a token, the ledger, or config; or mount an external tool
source (`external_tools` is operator-config-only, and external tools are
read-only in v1).

## Blast radius per token

- **Slack tokens** — post/read in the workspaces the app is in. No admin scope.
- **FirstTouch MCP token** — stage and complete approval-gated actions and read
  your workspace. The guard blocks direct-send tools.
- **CRM token** — reads, plus compare-and-set writes to the exact fields a
  `deal_followup` motion declares in `crm_fields_may_change`. Nothing else.
- **Model credential** — a Claude subscription token or API key; usage cost.

Scope each token minimally and rotate on the provider's side if one leaks; the
agent has no ability to change its own tokens.

## State contains PII

The ledger (`/data/state/…`) holds contact identities, decisions, and the
suppression list. Keep the volume on infrastructure you control; it is never
sent anywhere. The do-not-contact file is kept outside the agent-writable config
so the agent can neither read nor edit the list of people who objected.

## Reporting

See [SECURITY.md](../SECURITY.md).
