# Pipeline Agent

One agent in your Slack that works your pipeline every day — and asks
permission before anything leaves the building.

You pick which jobs it does (any mix, switchable later by chat):

- **Outbound** — sweeps your warm signals and target lists, researches, drafts
  the first touch in your voice.
- **Inbound triage** — watches your hand-raise sources and routes fast drafts.
- **Deal follow-up** — nudges stalled deals, drafts meeting recaps as UNSENT
  drafts, proposes CRM tidy-ups as explicit from → to change sets.
- **Post-close CS** — drafts check-ins for at-risk and milestone accounts, in
  your CS person's voice, sending as them (with their sign-off).

Every message lands as a card in the **sender's own approvals channel**
(#ada-approvals, #dana-approvals …): **Approve** / **Edit & approve** /
**Deny with a reason** — with a 45-second undo after any approval. Nothing
sends without a human, and only the person it sends *as* can approve it.

It is chattable ("why did you skip Acme?", "draft something for this
account"), runs one-off campaigns from chat ("email everyone from closed-lost
last year about the discount" → **one** batch card, dripped under your caps),
and **auto-learns from your edits**: the diff between what it drafted and
what you actually sent becomes dated rules that override its voice pack.

## How it holds together

```
┌─ container ──────────────────────────────────────────────────────────┐
│  host.mjs — the ONE long-running process, and the only credential    │
│  holder: Slack Socket Mode (no port, no URL), per-motion cron,       │
│  approval cards, the durable undo timer, deterministic apply.        │
│    └─ per task it spawns: headless Claude with NO credentials,       │
│       whose only tools are the agent tool server — enumerated        │
│       functions that enforce suppression, caps, ownership, flow      │
│       allowlists and approval gating in code.                        │
│                                                                      │
│  /app  — engine + guard: root-owned, read-only to the runtime user   │
│  /data — the agent's writable world: config, plays, voice, ledger    │
└──────────────────────────────────────────────────────────────────────┘
```

The agent can rewrite its own plays, prompts and voice — that is a feature —
but the guard, the tool server, and the approval loop live in the read-only
image where its own user cannot reach them. "Can reprogram itself, cannot
weaken its guardrails" is a filesystem fact, not an instruction.

The safety properties are enforced, not promised, and each is pinned by
tests (`npm test`, 170 of them):

| Property | Where it is code |
|---|---|
| Nothing sends without a named human approving | `tools-core` stages only; `apply` acts only on a decision |
| The human's edit can never be silently lost | create → read back → verify hash → only then complete |
| Only the sender may approve their card | `decide.mjs`, fail-closed on unknown owners |
| Hard caps, per contact/company/day/week | ledger reservations, shared across every motion |
| Suppression with a domain backstop | checked at stage AND re-checked at apply/send |
| An expired card is never applied late | expiry beats approval in `apply.mjs` |
| The model holds no credentials | `modelEnv()` strips them; only the tool server gets tokens |
| Injected text cannot start a campaign | campaign tools exist only in chat sessions with allowlisted users |
| Learning cannot be poisoned | lessons distilled ONLY from human-typed edits/deny reasons, inserted by host code |

## Setup (15–30 minutes, once)

1. **Slack app** — [api.slack.com/apps](https://api.slack.com/apps) → Create
   New App → *From a manifest* → paste [`slack-manifest.yaml`](slack-manifest.yaml).
   Install to workspace → copy the **Bot Token** (`xoxb-…`). Then Basic
   Information → App-Level Tokens → generate one with `connections:write` →
   copy the **App Token** (`xapp-…`).
2. **Model access** — on any machine where you're logged into Claude:
   `claude setup-token` → copy the token. (Or use an Anthropic API key —
   set exactly one of the two; setting both is a startup error.)
3. **FirstTouch token** — FirstTouch → Settings → API.
4. **Deploy** — Railway, Fly, Render, or any Docker host:

   ```bash
   docker run -d --restart unless-stopped --env-file .env \
     -v pipeline-data:/data ghcr.io/first-touch-inc/firsttouch-pipeline-agent
   ```

   (`cp .env.example .env` and fill it in first. No cron to arrange — the
   host schedules itself. No port to expose — it dials out.)
5. **Claim it** — the container log prints a claim code. DM the bot that code
   in Slack; you become the operator.
6. **Say "onboard"** — the agent interviews you: which motions, who sends,
   an approvals channel per sender, your ICP and voice — validating each step
   live and finishing with a supervised dry run. Config it writes passes the
   same validation as config written by hand.

HubSpot is asked for during onboarding only if a chosen motion needs it —
secrets are set as env vars, never pasted into Slack.

## Day-to-day

- Cards arrive in each sender's channel on the motion schedules; a digest of
  everything staged and everything skipped (with reasons) lands in your
  digest channel.
- DM the bot for anything: questions, one-off drafts, "run outbound now",
  or a campaign. Campaign cards state the audience and exclusions honestly
  ("212 contacts, 9 excluded — 6 suppressed, 3 no valid email").
- Deny reasons and edits feed the learning pass; new rules are announced
  ("📚 Learned [voice]: keep openers under 10 words — from your last 6
  edits") and any rule can be superseded by saying so.
- If the model hits your plan's rate limit, **approvals, undo, expiry and
  sending keep working** — only new drafting queues, and the bot says when
  it will retry.

## Customising it

- **Plays** are Markdown in `/data/config/plays/`. Ask the agent to write
  one ("watch competitors' job postings and draft outreach when they
  downsize") or drop a file in yourself. No fork needed.
- **Config** is one YAML file the agent maintains through validated,
  refusal-checked writes — see [`config/agent.example.yaml`](config/agent.example.yaml)
  for every knob: motions, schedules, caps, owners, flows, suppression.
- **New capabilities** (a new channel, a new platform) are code: add a tool
  to `runner/lib/tools-core.mjs` and an adapter to `runner/lib/providers.mjs`.
  It's MIT-licensed — fork away. The one thing no config or chat message can
  do is remove the approval gate; that takes editing the source and
  redeploying, which is your call to make, on your infrastructure, with a
  git trail.

## Repository map

```
runner/host.mjs            the always-on process (Slack, cron, apply, undo)
runner/mcp/agent-server.mjs the model's ONLY tool surface (stdio MCP)
runner/lib/tools-core.mjs  every tool + every enforcement rule, unit-tested
runner/lib/apply.mjs       deterministic side effects (edit-verify-complete)
runner/lib/decide.mjs      clicks & modals (modal-first, owner-only)
runner/lib/ledger.mjs      SQLite: identity, suppression, caps, decisions,
                           durable undo intents, idempotent apply, lessons
runner/lib/distill.mjs     auto-learning from edit diffs & deny reasons
runner/lib/schedule.mjs    zero-dep timezone-aware cron
runner/lib/cards.mjs       Slack Block Kit (opaque ids only)
runner/lib/providers.mjs   FirstTouch + HubSpot adapters (the credential file)
.claude/hooks/guard-send.mjs  defence-in-depth PreToolUse hook, fail-closed
config/agent.example.yaml  the whole configuration surface, documented
test/                      170 tests pinning every rule above
```

MIT. Built by [FirstTouch](https://firsttouch.com) — this is the same
architecture we run internally, published so you can run it yourself.
