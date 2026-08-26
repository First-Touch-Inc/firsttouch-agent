# FirstTouch Agent

A sales agent that lives in your Slack, works your pipeline, and **cannot send
anything without a human approving it first**.

There is no framework here. The agent is a normal [Claude Code](https://claude.com/claude-code)
session with the FirstTouch MCP, your HubSpot key, and a set of house rules —
plus a ~500-line host that bridges it to Slack. You don't configure motions in
YAML; you tell the agent what you want in a DM and it builds its own playbooks,
schedules and notes inside this repo. It gets better at your business the
longer it runs, because it writes down what it learns.

```
you:    every weekday morning, work my "Q3 targets" HubSpot list — find the
        right contact at each account, draft a first touch, cap it at 10/day
agent:  … asks two clarifying questions, writes workspace/plays/outbound.md,
        adds a schedule, stages tomorrow's first drafts for your approval
```

Every draft becomes an approval card in Slack — the copy, the researched
reason, Approve and Deny buttons — routed to whoever the outreach sends from.
Approve and the agent completes the send through FirstTouch; deny (or reply in
the thread with feedback) and it cancels, adjusts, and remembers why. Nothing
sends until that click. The rule is not a prompt: it's a
[hook](.claude/hooks/guard-send.mjs) that runs on every tool call the agent
makes — the same control FirstTouch runs on its own internal agents — and the
hook only unlocks a send for task ids a recorded human click covers.

It also knows *who* is talking: every message carries the sender's Slack
identity, which the agent maps to their FirstTouch seat and HubSpot owner. Ask
it for outreach and it drafts as **you**; Michael asks and it drafts as
Michael, with Michael's approval card.

## Setup (~15 minutes)

You need: a Slack workspace you admin · a [FirstTouch](https://firsttouch.com)
workspace · a HubSpot account · a Claude subscription (Pro/Max/Team) or an
Anthropic API key · Node 22+.

**1. Create the Slack app.**
[api.slack.com/apps](https://api.slack.com/apps) → Create New App → *From a
manifest* → paste [`slack-manifest.yaml`](slack-manifest.yaml) → Install to
Workspace → copy the **Bot Token** (`xoxb-…`). Then Basic Information →
App-Level Tokens → generate one with `connections:write` → copy the **App
Token** (`xapp-…`).

The manifest matters: it turns on the **Messages tab** (Slack blocks DMs to an
app without it, and DMs are how you talk to the agent) and requests
**`files:read`** (so the agent can look at screenshots you send — without the
scope, Slack serves a login page instead of the image).

**2. Give it a model.**
On a machine where you're logged in to Claude: `claude setup-token` → put the
token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. (Or set `ANTHROPIC_API_KEY` for
pay-as-you-go. Running locally where `claude` is already logged in, you can
leave both unset.) Sessions run on **Opus 5** by default — the work is
judgement, and a weaker model doesn't fail loudly, it just drafts worse.

**3. Connect FirstTouch.**
The repo already registers the FirstTouch MCP ([`.mcp.json`](.mcp.json)) —
nothing to add. In the repo folder, run `claude`, type `/mcp`, and authorize
FirstTouch. Claude Code owns that OAuth and refreshes it — the host never
holds a platform credential.

**4. Add HubSpot** (either way works):
- **OAuth, same as FirstTouch:** the repo registers HubSpot's MCP too — in the
  same `/mcp` screen, authorize `hubspot` alongside `firsttouch`. One pass,
  no token to manage.
- **Or an access token:** HubSpot → Settings → Integrations → Private Apps →
  create one with the CRM read scopes (write scopes only if you want the agent
  updating records) → put the token in `.env` as `HUBSPOT_ACCESS_TOKEN`.

**5. Run it.**
```bash
cp .env.example .env   # fill in the four values
npm install
npm start
```
The log prints a claim code. DM the bot that code in Slack — you're the
operator. Then just talk to it.

For a server: on **Railway**, create a service from your fork of this repo (it
builds the Dockerfile), mount a **volume at `/data`**, and set the `.env`
values as service variables — no public networking needed, the host dials out.
The volume is the agent's disk: its memory (`CLAUDE.md`, `workspace/`,
schedules), its session transcripts and the approval records all live there,
so redeploys update the code without giving the agent amnesia.

A container has no browser for the FirstTouch `/mcp` authorization, so do it
once on your machine (step 3), then:
```bash
npm run seed
```
and set the printed value as `CLAUDE_CREDENTIALS_SEED` on the service — the
host hydrates it on first boot. The same works anywhere Docker runs:
```bash
docker build -t firsttouch-agent . && docker run -d --restart unless-stopped \
  --env-file .env -v agent-data:/data firsttouch-agent
```
Inside the container the host runs as a non-root user, and the send guard is
re-synced from the image on every boot: the volume holds what the agent has
learned, the image holds its rules.

## What to say first

The agent starts knowing FirstTouch and HubSpot, but nothing about your
business. Good opening moves:

- *"Here's the team: … . Michael owns outbound, I own deals. Find their
  FirstTouch accounts and remember who's who."*
- *"Work my 'Q3 targets' HubSpot list every weekday at 8 — right contact per
  account, one thoughtful first touch each, 10/day cap, route approvals to
  each rep."*
- *"Watch our LinkedIn posts and draft follow-ups to everyone who engages."*
- *"Customers are companies where `plan` isn't empty — never touch them."*

It writes what it learns into [`CLAUDE.md`](CLAUDE.md) and its playbooks into
`workspace/`, and schedules its own recurring runs in `schedules.json`. Ask it
*"what do you know about us?"* or *"show me your outbound playbook"* any time —
its memory is files in this repo, and all of it is yours to read and edit.

**Skill packs** — ready-made playbooks for common motions (founder-led
outbound, warm-engager follow-up, stalled-deal reactivation, inbound
speed-to-lead) live at
[firsttouch-agent-skill-packs](https://github.com/First-Touch-Inc/firsttouch-agent-skill-packs).
Unzip a pack into `.claude/skills/` and the agent picks it up.

## The approval guarantee

[`.claude/hooks/guard-send.mjs`](.claude/hooks/guard-send.mjs) runs before
every MCP tool call in every session, scheduled or interactive, and denies:

| Call | Why |
|---|---|
| Any immediate-send tool | delivers to a person with no queue |
| Any email send | the agent drafts; a human sends |
| `add_dynamic_action` without `isHumanApprovalRequired: true` | would send on creation |
| `add_dynamic_action` without owner **and** assignee | approving would send from the wrong person's mailbox, irreversibly |
| `complete_task` without a recorded human Approve click | the agent never approves its own work — the host records each click (Slack-authenticated identity) and the hook permits completing exactly those task ids |
| Creating/editing/publishing flows | flow copy sends automatically, so a human authors it |

Flow *enrolment* is allowed (published flows carry human-written copy); create
`approved-flows.txt` (one flow id per line) to restrict which ones.

The hook keys off bare tool names, so renamed or UUID-namespaced connectors
can't slip past it. It fails closed on anything it can't parse. Tests in
[`test/guard-send.test.mjs`](test/guard-send.test.mjs) — treat a failure there
as a release blocker, not a flaky test.

**Be honest about the trust model:** inside those rules, the agent is a full
Claude Code session — it runs commands, edits this repo, and reads its own
`.env`. The container (or the machine you run it on) is *the agent's
computer*. Give it its own FirstTouch seat and a HubSpot token scoped to what
you actually want it doing, and treat the box as belonging to the agent.

## Day-to-day

- DM it like a colleague. Threads have real memory (each Slack thread is a
  persistent Claude session) — start a new thread for a new topic.
- While it works, one status message narrates what it's doing, then becomes
  the answer.
- Scheduled runs post their reports to the channel you chose, with the same
  narration.
- Approval cards land in each sender's channel with Approve/Deny buttons.
  Clicking settles the card, wakes the agent, and it completes or cancels the
  send — replying in the card's thread is how you give it feedback ("shorter",
  "wrong persona"), and it keeps what it learns.
- DMs and @mentions work for the operator (whoever claimed it) plus anyone in
  `ALLOWED_SLACK_USERS`; replies in a card or report thread work for anyone in
  that channel — membership in the approvals channel is the authorization. To
  hand the agent off, delete `state/operator.json` and restart — a new claim
  code prints.

## License

MIT.
