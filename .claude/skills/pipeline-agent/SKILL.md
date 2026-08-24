---
name: pipeline-agent
description: Runs one day of pipeline generation end to end, for one tenant, without sending anything. Reads config/tenant.yaml, sweeps every enabled candidate source (post engagers, stalled signups, replies that never got followed up, website visitors, partner-network paths, and cold target accounts) in priority order, dedupes and suppresses, researches and qualifies each person, drafts per-play messaging, creates approval-gated actions in the outreach platform assigned to the correct human sender, posts one summary digest, and writes a ledger plus a run report. Use it for the scheduled daily run, for a supervised dry run before turning the schedule on, or when someone asks to "work today's pipeline", "find and draft outreach", or "run the SDR loop". Every prospect-facing message it produces waits for a human approval; it never sends.
---

# Pipeline agent (orchestrator)

One run = one day of pipeline for one tenant. Everything below is driven by the
tenant config — **read `config/tenant.yaml` first**. Nothing sends. The output of
a run is *approval-gated drafts* plus a digest that explains why each one exists.

Per-play hook logic lives in `plays.md` next to this file. Cold outbound is
delegated to the `outbound-bdr` skill. Voice, positioning and proof points come
from the tenant's voice pack (`voice_pack` in the config; start from
`voice-pack.example.md` at the repo root).

---

## The config contract

**`config/tenant.example.yaml` is the schema, and it is the only copy of it.**
Read the tenant's config at the start of every run; read the example alongside
it if you need to know what a key means, because every key is documented inline
there.

Do not reproduce the schema here or anywhere else. A second copy drifts from the
first, and then two things disagree about what `max_per_day` is called — which
is a bug that shows up as the agent silently ignoring a cap.

The config is validated before you are invoked (`runner/lib/config.mjs`), so by
the time you read it, required keys exist and placeholder values have already
been rejected. What that validation does *not* check is semantics. If a value is
present but makes no sense for the run — an ICP that says nothing, a bucket whose
rules contradict each other — stop and report it rather than guessing.

The keys this skill depends on most:

| Key | What it controls here |
|---|---|
| `caps.min_per_day` / `caps.max_per_day` | The floor you sweep toward and the ceiling you stop at |
| `caps.supervised_run_cap` | Replaces both when `run_mode: supervised` |
| `caps.count_delegated_owners` | Whether drafts routed to a teammate count toward those numbers |
| `buckets[]` | What to work, in `priority` order, each capped by `daily_cap` |
| `buckets[].source.type` | `outreach.social_engagement`, `crm.list`, or `relationship_research` |
| `approval_routing.owners[]` | Who each draft sends as — see the ownership rule below |
| `providers.crm.customer_signal` | How you recognise an existing customer and suppress them |
| `suppression` / `excluded_domains` | Everyone you must not contact |
| `dedupe.rework_cooldown_days` | How long before the same person may be worked again |
| `voice_pack` | The messaging brain; `state/lessons.md` overrides it |

---

## Run procedure

### 0. Setup

1. Load `config/tenant.yaml`. Honour `run_mode`:
   - `supervised` — use `caps.supervised_run_cap` as the global ceiling, narrate
     each decision, and show the drafts in chat for a verbal OK before routing
     them. One OK per run is enough.
   - `daily` — `caps.max_per_day` is the hard ceiling and
     `caps.min_per_day` is the target.
2. Load the ledger at `state.ledger` — the worked-contact history and the
   per-bucket watermarks. A missing file means this is the first run; create it.
3. Load `state.lessons` if it exists. Accumulated corrections from the humans
   who approve these drafts **override the voice pack** wherever they conflict.
4. Mint a `run_id` (ISO date plus a short suffix) and use it everywhere.

### 1. Replies first, before any new outreach

Check the task queue and the previous run's enrollments for replies and
acceptances. Anything that came back goes to the TOP of the digest. One reply is
worth more than ten new drafts, and a run that buries a reply under new cards
has failed even if every other number is green.

Do not auto-draft responses to replies. Surface them loudly and let the human
take the thread.

### 2. Apply pending approval decisions

Read the decisions recorded in the outreach platform's task queue since the
last-applied watermark (track the watermark in the ledger). A task that a human
approved, edited, or skipped is a decision. Apply each one:

- **approved** — if the human edited the copy, write the edit back to the queued
  task first, then complete it.
- **denied** — skip the task and ledger the contact as declined, respecting
  `dedupe.rework_cooldown_days`.
- **feedback** — redraft that contact THIS run, using the feedback verbatim as a
  hard constraint, and create the replacement approval task.

Collapse to the newest decision per contact before applying anything. A
superseded card's approval must never double-enroll someone.

Then run the **learning pass**, which is what makes corrections stick. For every
`feedback` note and every edited draft since the watermark, diff what changed.
When the change generalises past this one contact, append a dated one-line rule
to `state.lessons` with an example. Situational corrections (wrong company fact,
wrong person) do NOT become lessons. Never delete a lesson; supersede it with a
newer dated entry.

If the platform's queue cannot be read, stop and report it as a blocker rather
than drafting on top of decisions you could not see — that is how someone gets
contacted twice. Never switch to another channel to compensate.

### 3. Sweep the enabled buckets

For each bucket where `enabled: true`, in `priority` order, collect candidates
that are NEW since that bucket's watermark in the ledger. Source types:

- `outreach.social_engagement` — pull engagers for each active monitored
  profile. **The per-profile engager reporting layer is the flaky one.** When it
  errors or returns zero, fall back to the platform's signal/enrollment feed
  filtered to engagement signal types over the last 24h (48h after a weekend
  gap). Do not treat a zero from the flaky path as "no engagement today".
- `crm.list` — read list membership through the CRM API, then apply the bucket's
  `rules` (staleness window, open-deal checks, product-usage stage, reply with
  no follow-up activity, and so on).
- `relationship_research` — path-building, not list-pulling. Start from saved
  first-degree connections for the tenant's own senders, then existing CRM
  contacts, then public research. Every candidate must carry: the person, the
  company, the relationship path, why they matter, and the proposed next action.
- `crm.list` + `play: cold-outbound` — the target-account bucket. Find
  decision-makers by company **domain plus one canonical role title**. Never
  search by company name alone, never page a whole roster. A zero result for one
  title set may be genuine: retry once with alternate titles, then move on.

Every bucket is capped by its own `daily_cap` so one busy source cannot starve
the others.

### 4. Dedupe, suppress, prioritise

1. **Dedupe** across buckets on `dedupe.key`. The hottest bucket (lowest
   `priority` number) wins; record the losers as `skipped:dedupe`.
2. **Cooldown** — drop anyone the ledger shows was worked inside
   `dedupe.rework_cooldown_days`.
3. **Suppression preflight** — run this BEFORE spending any enrichment credit
   and BEFORE creating any action:
   - Ask the outreach platform whether this person already has a live dynamic
     action, a flow enrollment, a disqualified/canceled row, or an exclusion-list
     hit. A cold list has no memory of who previous runs queued; check every
     discovered contact.
   - Check the CRM customer signals named in `suppression` (a product-usage
     property indicating an active account, a paid plan property, an open deal,
     a membership in the exclusion list).
   - Hard-block `excluded_domains` by **domain**, matched against both the email
     domain and the company/profile domain. Display names drift; domains do not.
     A candidate that arrived from a live signal feed may have no CRM record at
     all, so membership-based exclusion never fires for them — the domain block
     is the only thing that catches those.
   - When in doubt, suppress and note it. A false suppression is recoverable
     tomorrow. Messaging a current customer is not.
4. **Order the work** — bucket priority ascending, then heat inside the bucket:
   comments outrank likes and ICP titles outrank the rest; stalled signups run
   closest-to-value first; unanswered replies run positive-and-specific first,
   longest gap first; relationship buckets run strongest path first.
5. **Cut to the caps** — work buckets in priority order, each limited by its
   `daily_cap`, and stop everything at `caps.max_per_day`. Count every
   action written, across every owner when `caps.count_delegated_owners` is true, and
   stop mid-bucket if the ceiling lands there.

### 5. Work each contact

1. **Qualify on free data first.** Engager rows, list rows, saved connections
   and CRM records cost nothing. Only plausible people earn credits. Not
   plausible → ledger as `skipped:not-fit`, zero cost.
2. **Research per the bucket's play** (see `plays.md`). This is where the reason
   for the message is found — not invented.
3. **Enrich only when the draft needs something research did not give you.**
   Verify the person's CURRENT role (a current position with a null end date;
   people-search indexes carry stale roles). Look up an email address only when
   a channel in the plan actually requires one. For an intro-request or
   relationship-path action where the route is already clear, skip enrichment
   entirely. Track spend and stop opening NEW contacts once
   `caps.enrichment_credits_per_run` is reached; finish the one in progress.
4. **Draft per the play**, in the voice pack's structure, overridden by
   `state.lessons`. Lead with the single sharpest hook. Never stack hooks.
5. **Route as an approval-gated action** (next section).
6. **Ledger** the contact: `{run_id, bucket, contact key, company, action, why}`.

### 6. Route into the approval queue

The outreach platform's task queue is the source of truth for sends. The chat
card is a mirror and a convenience. Create the platform action FIRST, verify it,
and only then post the card.

- Run the platform's dynamic-action preflight/guide call before each
  action-creation call, and set the human-approval flag explicitly on every
  email, direct-message, connection-request-with-note and call step. Do not rely
  on the default.
- Treat the returned enrollment id and node id as the write receipt. If task ids
  come back empty because materialisation lagged, wait briefly and retry the
  lookup once. If no task can be verified, **report a blocker and do not count
  the prospect as queued.** Never silently downgrade prospect-facing outreach to
  a chat-only card.
- Never use a plain "manual task" / review task as the approval surface for
  prospect-facing outreach. If the right next step genuinely cannot be modelled
  as an approval-gated email, message or call — for example an intro request
  that has to go through a colleague — report it as a digest/blocker item
  instead of inventing an action.

#### The owner-assignment invariant (read this twice)

**Every action must be assigned to the owner the play belongs to, and you must
verify the assignment after creation.**

- Resolve the owner from `approval_routing.owners[]`. The owner whose `match` is
  `prior_account_history` takes the play when the prospect or account has real
  prior history with that person (CRM record owner, prior threads, an existing
  first-degree connection, existing enrollments assigned to them). Otherwise the
  `default` owner takes it.
- On the action-creation call, pass that owner's `provider_user_id` as **both**
  the action's owner field and the assigned-user field. Routing the chat card to
  someone's channel is NOT routing the play. Omit those two fields and the
  platform assigns the task to whichever user the MCP connection authenticated
  as, with a null sender — so approving it sends someone else's outreach out of
  the wrong person's mailbox.
- **Verify before posting the card.** Look the created task up (including team
  tasks) and confirm the task owner is the intended human. If it is not, report a
  blocker and do not post the card.
- A mis-assigned enrollment **cannot be reassigned after the fact.** The only
  remedy is to remove the prospect from the action and redraft. Prevention is the
  whole point of the verify step.
- If the resolved owner has no `provider_user_id`, or has no connected sender
  for that channel (someone with no connected social account cannot send a social
  message), report the routing gap. Do not silently fall back to the default
  owner.

#### Sequence order is connection-aware, not email-first for everyone

This comes from `sequence_defaults` and is not negotiable per-contact:

- Resolve connection status for **the sending owner's own account** before
  drafting, using the platform's saved team-connection data plus any existing
  thread history. If it cannot be resolved, treat the person as NOT connected.
  Never assume a connection the sender may not have.
- **Already connected** → lead with the direct message (it lands in a thread
  they already have), then email, then a short social follow-up. Never send a
  connection request to an existing connection.
- **Not connected** → email, email, connection request, then a very short
  accepted-branch DM that references the earlier email in one clause.
- **No email address and none obtainable** → social only: connect, then DM.
- Emit the draft keys in SEND ORDER. The card renders them in the order posted,
  so it should read like the actual sequence.
- Every plan carries at least one follow-up. A single-touch plan has to justify
  itself in the digest.

### 7. Report and digest

1. Write `state/runs/<run_id>.json`. Per bucket: candidates seen, qualified,
   worked, skipped with reasons, credits spent. Plus replies found, decisions
   applied, `min_per_day`, `max_per_day`, `drafted_count`, the
   owner split, and the relationship-path detail for path-based buckets. This
   file is the QA and costing dataset. Never skip it.
2. **The approval surface is the outreach platform's task queue.** You have
   already created the approval-gated tasks there; that queue is the source of
   truth and the only place a human approves anything. There is no approval
   service in this repo to post to, and this run opens no listener — see
   `docs/security.md`.

   If `approval_channels.slack` is true and a bot token is present, post ONE
   digest message per run summarising the day, with a link to the queue. That
   message is **one-way**: it is a notification, not an approval surface, and
   nothing reads a reply to it. Post once per run, never one card at a time.
   If Slack is unavailable, the run still succeeded — say the digest did not
   fire and carry on, because every approval is already safe in the queue.
3. Each digest entry carries the draft fields plus:
   - `signal` — the reason, in one human sentence. This is the SIGNAL, never the
     plumbing. "Started as VP Sales six weeks ago" is a signal. "On approve,
     enrolls via flow X" is plumbing and belongs in the ledger.
   - `is_signal` — true for live-signal buckets, false for cold fill. This is a
     routing flag, not permission to ship a thin card.
   - `first_message` — the first outbound text, for the preview.
   - `task_ids` — the platform tasks this plan maps to. **Required** for
     prospect-facing outreach so one-click approval can complete them. An empty
     array is acceptable only for a blocker note.
   - `owner` / `slack_channel` from `approval_routing`, and the prospect's avatar
     URL when the source row carried one.
4. Post a short summary line: replies found, cards posted, combined total plus
   the owner split, credits spent, and any shortfall with its per-bucket reasons.

---

## Hard rules

- **Draft and approve, everywhere.** No step may create an auto-sending action.
  If a flow or action would send without an approval, do not create it.
- **The floor is a target, not a quota.** `caps.min_per_day` says how
  many good actions a healthy day produces. It is not a licence to manufacture
  reasons. Sweep the warm and relationship buckets in priority order first, then
  fill from the cold target-account bucket. If the day still ends short, report
  the shortfall with per-bucket blocker reasons and the count of accounts
  researched and dropped. **A short day beats a padded one.**
- **No reason found = do not draft.** A cold target account has no inbound
  signal of its own, so the reason has to come out of research and it has to be
  dated and sourced: a leader new in role, an open req for the function you sell
  to, a named competing tool in their stack, live ads, funding or headcount
  movement, real audience or post traction, or genuine prior history with the
  tenant. Name the source and the date in `signal`.
  **Banned as a reason:** an analogy between what they sell and what the tenant
  sells; their stage or headcount alone; anything that only restates their
  marketing site; the fact that they are on the list. If that is all you have,
  drop the account and move to the next one.
- **Disabled buckets are never fill.** Any bucket with `enabled: false` is off,
  full stop, including as a fallback when the run is short.
- **Decision-makers only.** Never the individual contributors who would merely
  use the product. If a leader search returns nothing at a company, go up to the
  founder or CEO, never down.
- **Relationship buckets are path-first.** Surface the warmest path and the
  highest-leverage next action. Do not spray people because they match a title.
- **Only explicit approvals act.** In any chat-based fallback loop, act only on
  unambiguous "approve N / approve all / skip N" from an authorised approver.
  Emoji, silence, and other people's messages do nothing. Ambiguous means ask in
  thread and take no action.

---

## Environment

- Outreach platform MCP — enrichment, contact discovery, connection data,
  dynamic actions, the approval task queue.
- CRM API — list membership, contact and company properties, activity timeline.
- Web search — free signal research.
- Slack — optional, outbound only, one digest per run. This run opens no port and
  receives nothing; approvals live in the platform's task queue.
- Optional third-party research APIs (ad libraries, post-reaction lookups) keyed
  by env vars. These are optional by design: several such providers only cover a
  fraction of profiles and return empty or error for the rest. Treat an empty
  result as "no data", not as "no signal", and fall back to web search.
