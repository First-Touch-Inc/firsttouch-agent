# Configuration reference

Two files configure this agent, and neither is tracked by git:

- **`config/tenant.yaml`** — what the agent does. Copy from
  [`config/tenant.example.yaml`](../config/tenant.example.yaml).
- **`voice-pack.md`** — what it sounds like. Copy from
  [`voice-pack.example.md`](../voice-pack.example.md).

Secrets go in `.env` and nowhere else. Copy from
[`.env.example`](../.env.example).

`claude /setup` will interview you and write all three. This document is the
reference for when you want to change something afterwards, or understand why a
key exists.

- [The design rule: no silent defaults](#the-design-rule-no-silent-defaults)
- [tenant.yaml — every key](#tenantyaml--every-key)
- [Environment variables](#environment-variables)
- [HubSpot private-app scopes](#hubspot-private-app-scopes)
- [Your first 15 minutes](#your-first-15-minutes)
- [Troubleshooting by error message](#troubleshooting-by-error-message)

---

## The design rule: no silent defaults

`runner/lib/config.mjs` refuses to invent a value for anything tenant-specific. A
missing owner id, a blank list id, or a `<PLACEHOLDER>` left in place is a
`ConfigError` at load time — exit code 2, before anything touches a real person.

Placeholders are detected by pattern: any string matching `<...>` counts as
blank, so the example file's `"<YOUR_VISITOR_LIST_ID>"` fails exactly as an empty
string would.

The loader reports **every** problem it finds, not the first one, so one
`npm run preflight` gives you the whole list to fix in a single pass.

Defaults exist only for things that are genuinely universal — a cooldown window,
a word cap. Never for who you send as or which list you work.

---

## tenant.yaml — every key

### `client`

| Key | Type | Required | What it does | If you get it wrong |
|---|---|---|---|---|
| `client.name` | string | **Yes** | The team this agent works for. Appears in digests and run reports. | Blank fails config load. |
| `client.timezone` | string (IANA) | **Yes** | Drives what the agent considers "today" and business hours. Validated against `Intl.DateTimeFormat`. | An invalid name fails load with the name quoted back. A *valid but wrong* name loads fine and the agent reasons about the wrong day — nothing catches this. Note this does **not** set your scheduler's timezone; see [deploy-railway.md](deploy-railway.md#step-4--set-the-cron-schedule-and-restart-policy). |
| `client.approval_queue_url` | string (URL) | No | Where a human reviews drafts. Included in the digest so approvers have a link. | Not validated. A wrong URL means approvers follow a dead link; the queue itself still works. |
| `client.digest.slack_channel` | string | No | Channel name or ID for the daily digest. Overridden by the `SLACK_CHANNEL` env var. | Wrong channel = the digest lands somewhere else, or fails to post. Approvals are unaffected — the platform queue is the source of truth. |
| `client.digest.email` | string | No | Only used if `approval_channels.email` is true. | — |

### `providers`

| Key | Type | Required | What it does | If you get it wrong |
|---|---|---|---|---|
| `providers.outreach.kind` | enum | **Yes** | Which outreach platform. Implemented: `firsttouch`. | Anything else fails load with a message naming what is implemented and pointing at [providers.md](providers.md). It does not half-work. |
| `providers.outreach.mcp_url` | string (URL) | No | The MCP endpoint. Falls back to `FT_MCP_URL`, then `https://mcp.firsttouch.ai`. | Wrong URL = the outreach MCP server is not configured or fails to connect; preflight catches it. |
| `providers.crm.kind` | enum | **Yes** | Which CRM. Implemented: `hubspot`. | Anything else fails load. Note the runner only wires the CRM MCP server when this is exactly `hubspot`. |
| `providers.crm.customer_signal` | list | **Yes** | How the agent recognises an existing customer so it never prospects one. Each entry is `{property, operator, value}`. Suppress the account when **any** is true. | **This is the most consequential key in the file.** It ships blank and fails load on purpose. There is no safe default because the property name is yours. Get it wrong and the agent prospects your own paying customers. |

`customer_signal[].operator` accepts: `eq`, `gte`, `lte`, `is_known`, `in`.
`property` must be a real property name from your CRM — the example's
`active_seats` is illustrative, not a default. If you do not know which property
marks a customer, list your company properties from HubSpot and find it before
you run anything; `/setup` will help.

### `caps`

| Key | Type | Required | What it does | If you get it wrong |
|---|---|---|---|---|
| `caps.min_per_day` | integer ≥ 0 | **Yes** | Floor. Keep sweeping buckets until this many drafts exist. **A target, not a quota** — the agent reports a shortfall rather than manufacturing filler. | Non-integer or negative fails load. Greater than `max_per_day` fails load. |
| `caps.max_per_day` | integer ≥ 1 | **Yes** | Hard ceiling. The run stops here, mid-bucket if necessary. | Set it high and you get volume you have not read. Set it equal to the floor for a fixed-size day. |
| `caps.enrichment_credits_per_run` | integer | No | Soft ceiling on paid enrichment. The agent stops opening new contacts past it and finishes the one in progress. | Not validated. Too high is a billing surprise, not a safety problem. |
| `caps.supervised_run_cap` | integer | No | The ceiling used when `run_mode: supervised`. Defaults to **3** if absent. | This is the only cap that applies in supervised mode. `max_per_day` is ignored there. |
| `caps.count_delegated_owners` | boolean | No | Whether drafts routed to a teammate count toward the numbers above. | `false` means a two-person team can produce double the volume you think you configured. |

### `run_mode`

| Key | Type | Required | What it does |
|---|---|---|---|
| `run_mode` | `supervised` \| `daily` | **Yes** | `supervised` uses `caps.supervised_run_cap` as the global ceiling and narrates its decisions. `daily` uses `caps.min_per_day`/`caps.max_per_day`. |

Anything other than those two strings fails load. **Start on `supervised`.**
Preflight warns when you are on `daily`, because the first runs exist to be read,
not to produce volume.

### `icp`

| Key | Type | Required | What it does | If you get it wrong |
|---|---|---|---|---|
| `icp` | string (prose) | **Yes** | Qualification context, fed to the model. Write it the way you would brief a new rep. | Blank fails load. Vague costs you enrichment credits on people who were never going to buy. **Be specific about who is NOT a fit** — the exclusions do more work than the inclusions. This is prose read by a model, not a schema that gets parsed. |

### `voice_pack` and `extra_plays`

| Key | Type | Required | What it does | If you get it wrong |
|---|---|---|---|---|
| `voice_pack` | string (path) | No, but | Path to your voice pack, relative to the repo root or absolute. **The single biggest lever on draft quality.** | Absent → preflight warns "Drafts will be generic". Present but the file does not exist → preflight **fails**. |
| `extra_plays` | string (path) | No | Path to the play catalogue. Defaults to the shipped `.claude/skills/pipeline-agent/plays.md`. | Not validated by the loader. |

### `buckets`

A bucket is one source of people plus the rules for working them. Buckets are
swept in `priority` order (1 first), each capped by its own `daily_cap`, and the
whole run stops at the effective cap.

| Key | Type | Required | What it does | If you get it wrong |
|---|---|---|---|---|
| `buckets` | list | **Yes** | Must be non-empty, and **at least one must be enabled**. | Zero enabled buckets fails load — the agent would have nothing to work. |
| `[].id` | string | **Yes** | Unique identifier. Validated on every bucket, enabled or not. | Blank or duplicate fails load. |
| `[].enabled` | boolean | **Yes** | Whether this bucket runs. Only enabled buckets are validated further. | **A disabled bucket is never used as fill**, even on a short day. |
| `[].priority` | integer | **Yes** (if enabled) | Sweep order. 1 runs first. **Order by warmth.** | Non-integer fails load. Preflight warns if a cold bucket outranks a warm one — cold outbound should have the highest number so it runs last. |
| `[].daily_cap` | integer ≥ 1 | **Yes** (if enabled) | Per-bucket ceiling, so one busy source cannot starve the others. | Non-positive fails load. |
| `[].source.type` | string | **Yes** (if enabled) | Where candidates come from: `outreach.social_engagement`, `crm.list`, or `relationship_research`. | Blank fails load. |
| `[].source.list_id` | string | **Yes** for `crm.list` | Your real CRM list id. | **The single most likely misconfiguration, and the failure mode is working the wrong list of humans.** A blank or `<PLACEHOLDER>` value fails load with the bucket id named. Fix it or set `enabled: false`. |
| `[].source.monitored_profiles` | string \| list | No | For `outreach.social_engagement`: `all-active`, or a list of profile handles. | — |
| `[].play` | string | **Yes** (if enabled) | Which play in `plays.md` binds to this source. | Blank fails load. A name with no matching play means the agent has no hook logic for the bucket. |
| `[].rules` | list of strings | No | Free-text constraints applied to this bucket only, read by the model. | Not validated. This is where the **reason gate** lives for `cold-outbound` — see below. |

**The reason gate.** The `target-accounts` bucket in the example carries three
rules that are the main thing separating personalized outbound from spam: every
draft needs a real, dated, sourced reason found by research; an analogy between
what they sell and what you sell is explicitly banned as a reason, as are
headcount, funding stage, and list membership alone; and no reason found means do
not draft. **Do not delete these rules to increase volume.** A short day is the
intended outcome when the research comes up empty.

### `approval_channels`

| Key | Type | Required | What it does |
|---|---|---|---|
| `approval_channels.slack` | boolean | No | Fan the digest out to Slack. |
| `approval_channels.email` | boolean | No | Fan out by email. Uses `client.digest.email`. |
| `approval_channels.crm_task` | boolean | No | Mirror as a CRM task. Needs CRM write scopes. |

None of these change where approval actually happens. **The outreach platform's
task queue is always the source of truth**; everything here is a mirror, and the
first decision from any surface wins.

### `approval_routing`

Read this section even if you are a team of one. It is the highest-consequence
part of the file.

| Key | Type | Required | What it does | If you get it wrong |
|---|---|---|---|---|
| `approval_routing.owners` | list | **Yes** | At least one owner. Every action must have an explicit sender. | Empty fails load. |
| `[].id` | string | **Yes** | Unique key for this owner. | Blank or duplicate fails load. |
| `[].name` | string | **Yes** | Used in the digest. | Blank fails load. |
| `[].provider_user_id` | string | **Yes** | **Whose account the message sends from.** | Blank fails load, with the longest error message in the codebase. Omit it and the platform assigns the action to whichever user the API authenticated as — so approving it sends one person's outreach from another person's account. **That is not reversible.** The engine also verifies the owner after creating each action and refuses to post the card if the check fails. |
| `[].crm_owner_id` | string | No | Used to match prior account history. | Absent just means history matching falls back to other signals. |
| `[].slack_channel` | string | No | Where this owner's approval cards go. | Routing a card to a channel is **not** routing the play — the `provider_user_id` is what decides the sender. |
| `[].match` | `default` \| `prior_account_history` | **Yes** | `default` is the fallback owner. `prior_account_history` takes the play when the account, thread, or connection already belongs to that person. | **Exactly one owner must have `match: default`.** Zero fails load; two or more fails load with both ids named. |

### `sequence_defaults`

Not validated by the loader — it is read by the agent as instructions.

| Key | Type | What it does |
|---|---|---|
| `omni_channel` | boolean | Whether to use both email and social channels. |
| `connection_check` | list of strings | How to resolve whether the sender is already connected to the person, before drafting. The last entry is the important one: if status cannot be resolved, **treat as not connected**. |
| `order_when_connected` | list | Channel order for an existing connection. Leads with the DM — never send a connection request to someone you are already connected to. |
| `order_when_not_connected` | list | Channel order otherwise. Email first, connection request later. |
| `rules` | list of strings | Cross-cutting constraints: emit drafts in send order, always include a follow-up, word caps (under 60 words, target 35-50, follow-ups 25-40). |

### `dedupe`

| Key | Type | Required | What it does | If you get it wrong |
|---|---|---|---|---|
| `dedupe.key` | string | No | What identifies a person across buckets. Default `linkedin_url_or_email`. | — |
| `dedupe.rework_cooldown_days` | integer | **Yes if `dedupe` exists** | Never draft the same person twice inside this window. Enforced against `state/ledger.jsonl`. | Non-integer fails load. Set to 0 and someone can be contacted every single day. **This key is only as good as your state persistence** — see [`state`](#state). |

### `suppression` and `excluded_domains`

| Key | Type | Required | What it does | If you get it wrong |
|---|---|---|---|---|
| `suppression` | list of strings | **Yes** | Ordered checks that run **before** a draft is created. | Empty fails load: "Removing all of them means prospecting your own customers." |
| `excluded_domains` | list | No | Hard block, matched on **domain**, not display name. Each entry is `{domain, reason, added}`. | An empty list is valid but means you are relying entirely on CRM signals. A candidate that arrived from a live signal feed may have no CRM record at all, so membership-based exclusion never fires for them — **the domain block is the only thing that catches those.** Use it for customers your CRM lists miss, partners, competitors, and your own domains. |

### `do_not_contact`

| Key | Type | Required | What it does | If you get it wrong |
|---|---|---|---|---|
| `do_not_contact` | string (path) | No, but treat it as required | Path to a plain-text file of individual opt-outs. One entry per line: an email address, an email domain, or a profile URL. `#` comments and blank lines are ignored, matching is case-insensitive. Default `do-not-contact.txt`. | Anyone listed is never contacted again, on any channel, in any run. Losing this file means re-contacting people who have already objected, which in several jurisdictions is a violation rather than an embarrassment. |

```bash
cp do-not-contact.example.txt do-not-contact.txt
```

Three things about this file that are deliberate:

- **It lives outside `state/`.** Clearing run state must not resurrect someone
  who asked you to stop. Wiping a volume is a normal operational act; losing your
  opt-out list should not be a consequence of it.
- **It is gitignored** — it contains personal data about people who objected. But
  it is also the file you most need to back up and mount into your container.
  Those two facts pull in opposite directions; resolve them deliberately rather
  than by accident.
- **Add, never remove.** Suppress rather than delete the underlying CRM record: a
  deleted contact gets re-added by the next sweep, a suppressed one does not.

Add someone the moment they ask — by reply, by unsubscribe, or in person. See
[safety-and-compliance.md](safety-and-compliance.md).

### `limits` — channel rate limits

Separate from `caps` on purpose. `caps` is how much work the agent does;
`limits` is how hard it leans on any one channel — which is what gets a sending
domain filtered or a social account restricted.

| Key | Type | What it does |
|---|---|---|
| `limits.email.max_per_day` | integer | Emails drafted per day. Shipped default: 20. |
| `limits.social.max_connection_requests_per_day` | integer | Shipped default: 10. |
| `limits.social.max_connection_requests_per_week` | integer | Shipped default: 40. |
| `limits.social.max_messages_per_day` | integer | Shipped default: 15. |
| `limits.max_contacts_per_company_per_quarter` | integer | Never contact more than this many people at one company per quarter. Shipped default: 3. Prevents the pattern that reads to a buying committee as a spray. |
| `limits.max_touches_per_contact_per_quarter` | integer | Total touches one person may receive from you in a quarter, all channels. Shipped default: 6. |

**The defaults are deliberately low.** Social platforms publish no reliable
public number, enforce silently, and restrict the **account** rather than the
tool — and that account belongs to a real person on your team. Read
[safety-and-compliance.md](safety-and-compliance.md#linkedin-and-platform-automation-rules)
before raising anything here.

The per-quarter limits are enforced against `state/ledger.jsonl`, so they share
the ledger's fate: on an ephemeral host without a volume, they reset.

### `sender_identity`

| Key | Type | What it is |
|---|---|---|
| `sender_identity.legal_entity_name` | string | The legal entity sending the mail. |
| `sender_identity.postal_address` | string | A real, physical mailing address. **Required in commercial email by CAN-SPAM** and by the equivalent rules in most other jurisdictions. |
| `sender_identity.unsubscribe_url` | string | Must actually work, and must be honoured promptly. |
| `sender_identity.privacy_notice_url` | string | Where you tell people how you got their data. This is how you meet GDPR Article 14 transparency when you did not collect the data from the person themselves. |

All four ship blank. The intent, per the template's own comment, is that the
agent injects the address and opt-out into every email it drafts and **refuses to
draft email at all** while they are blank.

> **Verify this before you rely on it.** As of this writing these keys are not
> validated by `runner/lib/config.mjs` and are not referenced in
> `.claude/skills/pipeline-agent/SKILL.md`, so the refusal is a stated intent
> rather than something I could confirm is enforced in code. Run `npm run dry`
> with them blank and read a drafted email: if the address and opt-out are
> missing, fill these in and treat the enforcement as your responsibility until
> the engine catches up. The legal obligation is yours either way — see
> [safety-and-compliance.md](safety-and-compliance.md#can-spam-us).

The same caveat applies to `do_not_contact` and `limits`: they are documented
config surface that the loader does not currently validate. A typo in a key name
under any of the three will be silently ignored rather than reported, which is
the opposite of how the validated keys behave.

### `state`

| Key | Type | Required | What it does |
|---|---|---|---|
| `state.ledger` | string (path) | No | One line per person worked: who, bucket, when, run id. Default `state/ledger.jsonl`. |
| `state.run_reports` | string (path) | No | One JSON report per run. Default `state/runs/`. |

Both live under `STATE_DIR`. On an ephemeral host they **must** be on a mounted
volume or dedupe and the cooldown reset on every deploy and people get contacted
twice. See [deploy-railway.md](deploy-railway.md#step-3--attach-the-volume).

Both contain real prospect PII and are gitignored. See
[security.md](security.md#state-files-contain-pii).

---

## Environment variables

Every one of these is read from `process.env`. **This repo does not load `.env`
itself** — your shell or your hosting platform has to put them in the
environment. That matters under cron; see
[deploy-other.md](deploy-other.md#the-trap-cron-has-almost-no-environment).

### Required

| Variable | Fatal when | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` **or** `CLAUDE_CODE_OAUTH_TOKEN` | Always | Model access. Exactly one. The API key is pay-as-you-go and the right choice for a server. The OAuth token uses an existing Claude subscription — generate it with `claude setup-token` on a machine where you are logged in, and check your plan's terms before running it unattended, since subscription limits are not designed for continuous automation. |
| `FT_MCP_TOKEN` | Except in a dry run | Outreach platform bearer token. Required to create approval-gated actions. Not fatal with `DRY_RUN=1`, because nothing is created. |
| `HUBSPOT_ACCESS_TOKEN` | Except in a dry run | HubSpot private-app token. Required to read lists, contacts and ownership. |

### Optional

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_MODEL` | unset | Model for the run. Leave unset for the default. |
| `FT_MCP_URL` | `https://mcp.firsttouch.ai` | Overrides the MCP endpoint. `providers.outreach.mcp_url` in the config takes precedence over this. |
| `SLACK_BOT_TOKEN` | unset | `xoxb-…`. Needs only `chat:write`. Invite the bot to your approvals channel. Absent = the digest is skipped and approvals still land in the platform queue. |
| `SLACK_CHANNEL` | from config | Overrides `client.digest.slack_channel`. |
| `SERPER_API_KEY` | unset | Web search for company signals (funding, hiring, news). Absent = that signal is skipped and the run says so. |
| `SCRAPECREATORS_API_KEY` | unset | Ad-library signal. Absent = skipped. |
| `TENANT` | `tenant` | Which file in `config/` to run: `config/<TENANT>.yaml`. Also settable per-run with `--tenant <name>`. |
| `STATE_DIR` | `<repo>/state` | Where run state lives. Relative paths resolve against the repo root. **Set this to an absolute path on a mounted volume on any ephemeral host.** |
| `DRY_RUN` | unset | `1` (the literal string) = research and draft, create nothing. Anything else is off. Also settable with `--dry`. Enforced by the [send guard](security.md#the-send-guard) hook, which denies every mutating tool call while it is set — so "creates nothing" is a control, not an instruction. It also forces `CRM_WRITES_ENABLED=0`. |
| `RUN_TIMEOUT_MS` | `2700000` (45 min) | Hard timeout. The agent subprocess is `SIGTERM`ed and the run exits non-zero rather than hanging forever. |
| `CRON_SCHEDULE` | `0 8 * * 1-5` | Read by `runner/scheduler.mjs` only. Five fields, in the container's local time. |
| `RUN_ON_START` | unset | `1` = `scheduler.mjs` also runs once immediately at boot. |
| `TZ` | system | Standard. `scheduler.mjs` schedules in this timezone; Railway and Render cron ignore it entirely (both are UTC). |
| `CRM_WRITES_ENABLED` | unset (closed) | Must be **exactly** the string `1` to allow the CRM adapter's single write tool. Not `true`, not `yes` — a gate that accepts several spellings opens by accident when a deploy script sets the wrong thing. Unset means closed. A dry run forces it to `0` regardless of what you set. |
| `HUBSPOT_API_BASE_URL` | HubSpot's API | Test seam for pointing the adapter at a mock server. Leave unset in production. |
| `RAILWAY_RUN_UID` | unset | Railway only. Set to `0` if the non-root container cannot write to the mounted volume. |

`RAILWAY_ENVIRONMENT` is not something you set — Railway sets it, and preflight
uses its presence to warn when `STATE_DIR` is a relative path on an ephemeral
host.

### CLI flags

```bash
node runner/run-daily.mjs                 # config/tenant.yaml
node runner/run-daily.mjs --tenant acme   # config/acme.yaml
node runner/run-daily.mjs --dry           # research and draft, create nothing

node runner/preflight.mjs                 # validate everything
node runner/preflight.mjs --offline       # skip the live connectivity checks
node runner/preflight.mjs --tenant acme
```

Or through npm: `npm run preflight`, `npm run dry`, `npm start`.

---

## HubSpot private-app scopes

Create the app under **Settings → Integrations → Private Apps**, and copy the
token (it starts with `pat-`) into `HUBSPOT_ACCESS_TOKEN`.

**Changing scopes invalidates the existing token.** Re-copy it afterwards and
update your `.env`, or the next run fails with a 401.

### The minimum read-only set

This is everything a normal run needs. Grant exactly this and nothing else:

```
crm.lists.read
crm.objects.contacts.read
crm.objects.companies.read
crm.objects.deals.read
crm.objects.owners.read
sales-email-read
```

| Scope | What it grants | Required? |
|---|---|---|
| `crm.objects.owners.read` | `GET /crm/v3/owners`. This is the call `npm run preflight` makes, so a missing scope here shows up as `CRM token is missing a scope (403)` immediately. | **Yes** |
| `crm.objects.contacts.read` | Contact properties and search — **and every engagement read**: notes, tasks, calls, emails and meetings. See the note below. | **Yes** |
| `crm.objects.companies.read` | Company properties and search. Needed for `providers.crm.customer_signal` when your signal is a company property. | **Yes** |
| `crm.objects.deals.read` | Deal properties and search. This is what backs the `"Contacts with an open deal"` suppression check. | **Yes** |
| `crm.lists.read` | List definitions **and** memberships. Every `crm.list` bucket needs it. | **Yes** |
| `sales-email-read` | The *content* of email engagements. Without it you get email metadata but not bodies — which means the `replies-no-followup` bucket cannot read the reply it is supposed to be following up on. | **Yes**, if you read replies |

**The thing that surprises people:** there is no `crm.objects.notes.read`,
`crm.objects.tasks.read`, `crm.objects.calls.read`, or
`crm.objects.emails.read`. Those scope strings do not exist. Engagement and
activity objects in the CRM v3 API are gated by the **contacts** scope, so
`crm.objects.contacts.read` is what lets the agent read a contact's activity
timeline.

Reading list *memberships* needs only `crm.lists.read` — memberships come back
as record IDs. You need `crm.objects.contacts.read` separately to turn those IDs
into people, which you are granting anyway.

### Write scopes — only if you enable CRM writes

**You do not need these for a normal run.** The agent is read-mostly against your
CRM by design, and the bundled adapter refuses to write at all unless
`CRM_WRITES_ENABLED=1`. Leave them off until you deliberately turn logging on.

| Scope | What it grants | When |
|---|---|---|
| `crm.objects.contacts.write` | Update contact properties, **and create notes and tasks**. | Only with `CRM_WRITES_ENABLED=1`, or `approval_channels.crm_task: true` |
| `crm.objects.companies.write` | Update company properties. | Only with `CRM_WRITES_ENABLED=1` |

**Understand the trade before you grant these.** Because engagements are gated by
the contacts scope, *there is no narrower permission that lets you log a note or
a task*. Granting `crm.objects.contacts.write` so the agent can write a note also
grants it the ability to modify every contact property in your CRM. That is a
HubSpot design constraint, not something this repo can scope around, and it is
why the write gate lives in the environment where a human sets it and the model
cannot reach it. The adapter narrows the blast radius further — one record per
call, at most 10 properties, no creates, no deletes, no merges, HubSpot-managed
properties rejected, and clearing a value requires an explicit flag — but the
token itself is as broad as HubSpot makes it.

### Tier requirements

None. Every scope above is available on a **Free** HubSpot account — the
endpoints are all marked `FREE` across marketing, sales, service, CMS, commerce
and CRM tiers. Only sensitive-property variants require Enterprise, and nothing
here uses them.

Whether a Free-tier portal can *have* the active lists you want to point a bucket
at is a separate product-packaging question that HubSpot's developer docs do not
address. The scope is free; the feature may not be.

### Do not grant

- **`crm.objects.users.read`** — that is the Users/settings API and it requires
  elevated account permissions. `crm.objects.owners.read` is the read-only
  alternative and is what the adapter uses.
- **`engagements-read`** — legacy. HubSpot's docs state that an app holding only
  this scope receives an empty result set (HTTP 200, zero results) rather than an
  error on the engagements endpoint. A silent-empty failure mode is worse than a
  403, so make sure `crm.objects.contacts.read` is present.
- Anything not on the list above. The token is a bearer token to your entire
  customer database; see [security.md](security.md#blast-radius-per-token).

If a call comes back 403, the adapter names the scope it believes is missing in
the error text rather than making you decode a bare status code. The per-tool
scope breakdown is in
[`runner/mcp/README.md`](../runner/mcp/README.md#required-private-app-scopes).

> **Sources**, all accessed 2026-08-24:
> [Scopes reference](https://developers.hubspot.com/docs/guides/apps/authentication/scopes) ·
> [Owners API](https://developers.hubspot.com/docs/api-reference/latest/crm/owners/guide) ·
> [Lists API](https://developers.hubspot.com/docs/api-reference/latest/crm/lists/guide) ·
> [Activities/notes](https://developers.hubspot.com/docs/api-reference/latest/crm/activities/notes/get-notes) ·
> [Contacts](https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/get-contacts).
> The v1 Lists API was sunset on 2026-04-30; this repo uses v3.

---

## Your first 15 minutes

```bash
git clone https://github.com/First-Touch-Inc/firsttouch-pipeline-agent.git
cd firsttouch-pipeline-agent
npm install
```

**1. Credentials (5 min).**

```bash
cp .env.example .env
```

Fill in `ANTHROPIC_API_KEY`, `FT_MCP_TOKEN` and `HUBSPOT_ACCESS_TOKEN`. Leave
`DRY_RUN=1` where it is. Leave the optional enrichment keys blank.

**2. Config (5 min).** The fast path is to let the setup agent interview you:

```bash
claude /setup
```

It asks one question at a time, writes real values rather than placeholders, and
will not ask you to paste a secret into the chat. If you would rather do it by
hand:

```bash
cp config/tenant.example.yaml config/tenant.yaml
cp voice-pack.example.md voice-pack.md
cp do-not-contact.example.txt do-not-contact.txt
```

Then edit `config/tenant.yaml` and change, at minimum:

- `client.name`, `client.timezone`
- `providers.crm.customer_signal[0].property` — a real property from your CRM
- `icp` — including who is *not* a fit
- `approval_routing.owners[0]`: `name` and `provider_user_id`
- Leave `run_mode: supervised`. Leave every `crm.list` bucket
  `enabled: false` until you have real list ids.

The example ships with `social-engagers` as the only enabled bucket, which is a
reasonable starting point if you have that signal. If you do not, you will need
to enable a bucket with a real list id.

Then fill in `voice-pack.md`. Do not skip this — it is the difference between
drafts you would send and drafts you would not. Only claims you can actually
back: an invented customer metric in a cold email is a lie sent under a real
person's name.

**3. Prove it works (2 min).**

```bash
npm run preflight
```

Fix every `FAIL`. Warnings are yours to accept consciously. Green looks like
`Ready.` or `Ready, with N warning(s).`

**4. Read the output (3 min, and then more).**

```bash
npm run dry
```

A complete run that creates nothing. Then open the newest report:

```bash
ls -t state/runs/ | head -1
```

**Read the drafts.** The only question that matters: would you send this, under
your own name, to this person? If no, that is almost always a `voice-pack.md`
problem. Fix it and run `npm run dry` again. Iterating here is much cheaper than
iterating in someone's inbox.

**5. Only then.** Read
[safety-and-compliance.md](safety-and-compliance.md) — properly, not skimmed —
and then schedule it: [Railway](deploy-railway.md) or
[somewhere else](deploy-other.md).

---

## Troubleshooting by error message

These are the actual strings `runner/lib/config.mjs` and `runner/preflight.mjs`
produce.

### Config load failures (exit code 2)

| Message | Cause | Fix |
|---|---|---|
| `No config at <path>` | `config/tenant.yaml` does not exist, or `TENANT` names a file that does not. | `cp config/tenant.example.yaml config/tenant.yaml`, or `claude /setup`. |
| `<path> is not valid YAML: …` | Syntax error. Usually a tab character, or an unquoted string containing `:`. | Fix the YAML. Quote values with colons. |
| `<path> is empty or is not a YAML mapping.` | Empty file, or the top level is a list. | Start from the example file. |
| `client.name is required.` | Blank or a `<placeholder>`. | Set your team name. |
| `client.timezone is required.` | Blank. | An IANA name, e.g. `America/New_York`. |
| `client.timezone "X" is not a valid IANA timezone.` | Not a real zone — `EST`, `GMT+5` and `Eastern` all fail. | Use a full IANA name. |
| `providers.outreach.kind is required.` | Blank. | `firsttouch`. |
| `providers.outreach.kind "X" has no adapter in this repo.` | You named an unimplemented provider. | Only `firsttouch` today. See [providers.md](providers.md). |
| `providers.crm.kind is required.` / `… has no adapter in this repo.` | Same, for the CRM. | Only `hubspot` today. |
| `providers.crm.customer_signal needs at least one entry with a real CRM property name.` | The list is missing, empty, or every entry has a blank `property`. This ships blank deliberately. | Put a real company property from your CRM here. This is what stops the agent prospecting your own customers. |
| `caps.min_per_day must be a non-negative integer.` | Missing, a string, or negative. | An integer. Quoted numbers in YAML are strings. |
| `caps.max_per_day must be a positive integer.` | Missing, zero, or not an integer. | An integer ≥ 1. |
| `caps.min_per_day (N) cannot exceed caps.max_per_day (M).` | Floor above ceiling. | Lower the floor or raise the ceiling. |
| `run_mode must be either "supervised" or "daily".` | Typo, or something else entirely. | Exactly one of those two strings. |
| `icp is required.` | Blank. | Describe who you sell to, and who is not a fit. |
| `buckets must be a non-empty list.` | Missing or empty. | Keep at least one bucket. |
| `No bucket is enabled, so the agent would have nothing to work.` | Every bucket is `enabled: false`. | Enable one. Start with your warmest signal. |
| `Every bucket needs an id.` | A bucket has no `id`. | Add one. |
| `Duplicate bucket id "X".` | Two buckets share an id. | Rename one. |
| `bucket "X": priority must be an integer (1 runs first).` | Missing or not an integer, on an **enabled** bucket. | Add it. Lower number = worked earlier. |
| `bucket "X": daily_cap must be a positive integer.` | Missing or ≤ 0. | An integer ≥ 1. |
| `bucket "X": play is required.` | Blank. | Name a play from `plays.md`. |
| `bucket "X": source.type is required.` | Blank. | `crm.list`, `outreach.social_engagement`, or `relationship_research`. |
| `bucket "X": source.list_id is still a placeholder.` | A `crm.list` bucket still has `<YOUR_..._LIST_ID>`. | Put your real list id in, **or set `enabled: false`**. A wrong list id means working the wrong humans. |
| `approval_routing.owners must list at least one owner.` | Missing or empty. | Add yourself. |
| `Exactly one owner needs \`match: default\`. None has it.` | No owner is the fallback. | Set `match: default` on one. |
| `Exactly one owner may have \`match: default\`; found N: a, b` | Two or more fallbacks. | Only one. The others should be `prior_account_history`. |
| `Every owner needs an id.` / `Duplicate owner id "X".` | — | Give each owner a unique id. |
| `owner "X": name is required.` | Blank. | Used in the digest. |
| `owner "X": provider_user_id is required. This decides WHOSE ACCOUNT the message sends from…` | Blank or a placeholder. | Get the user id from your outreach platform. Without it the platform assigns the action to the authenticated API user, and approving it sends someone else's outreach from the wrong account — **not reversible**. |
| `suppression must list at least one check.` | You emptied the list. | Restore the checks from the example. |
| `dedupe.rework_cooldown_days must be an integer number of days.` | Not an integer. | An integer. `30` is the shipped value. |

### Credential failures (exit code 2)

Printed as `Missing required credentials:` followed by the specific line.

| Message | Fix |
|---|---|
| `model access: Set ANTHROPIC_API_KEY (pay-as-you-go) or CLAUDE_CODE_OAUTH_TOKEN (existing Claude subscription).` | Set one of them. Not both. |
| `outreach platform: FT_MCP_TOKEN is not set. Required to create approval-gated actions.` | Set it. In a dry run this is a warning, not fatal. |
| `CRM: HUBSPOT_ACCESS_TOKEN is not set. Required to read lists, contacts and ownership.` | Set it. In a dry run this is a warning, not fatal. |

### Preflight warnings and failures

| Message | Meaning | Fix |
|---|---|---|
| `WARN  run_mode is "daily"` | You are past the training-wheels setting. | Intentional? Fine. If you have not read a full run's drafts yet, go back to `supervised`. |
| `WARN  only cold buckets are enabled` | Every enabled bucket uses `play: cold-outbound`. | Warm signals convert far better. Enable a warm bucket if you have one. |
| `WARN  a cold bucket outranks a warm one` | A cold bucket has a lower (earlier) `priority` than a warm one. | Give cold outbound the highest priority number so it runs last. |
| `WARN  no voice_pack configured` | The key is absent. | Drafts will be generic. Set it. |
| `FAIL  voice pack not found` | The path in `voice_pack:` does not exist. | `cp voice-pack.example.md voice-pack.md` and fill it in. |
| `FAIL  state directory is not writable` | Permissions, or a volume that is not mounted. | Fix ownership. On Railway, try `RAILWAY_RUN_UID=0`. |
| `WARN  STATE_DIR is not an absolute path on an ephemeral host` | Relative `STATE_DIR` while `RAILWAY_ENVIRONMENT` is set. | Use an absolute path on a mounted volume — `/data/state`. Otherwise dedupe resets on every deploy and people get contacted twice. |
| `FAIL  CRM rejected the token (401)` | `HUBSPOT_ACCESS_TOKEN` is wrong, expired, or revoked. Also: a trailing newline from a copy-paste. | Reissue it. Check for whitespace. |
| `FAIL  CRM token is missing a scope (403)` | The private app does not have a scope the call needs. | See the [scope table](#hubspot-private-app-scopes). The preflight call itself needs owners read. |
| `WARN  CRM returned <status>` | Something unexpected but not obviously fatal. | Check HubSpot's status page. Rate limiting shows as 429. |
| `WARN  could not reach the CRM` | Network, DNS, or egress firewall. | Confirm the host has outbound HTTPS to `api.hubapi.com`. |
| `FAIL  outreach platform rejected the token (401/403)` | `FT_MCP_TOKEN` is wrong or revoked. | Reissue it. |
| `WARN  outreach platform returned <status>` | Unexpected response from the MCP endpoint. | Check `providers.outreach.mcp_url` / `FT_MCP_URL`. |
| `WARN  Slack rejected the token` | Bad or revoked `SLACK_BOT_TOKEN`. | Reissue. The digest is skipped; approvals still work. |
| `FAIL  claude CLI not runnable` / `claude CLI not found on PATH` | The agent runtime is not installed or not on `PATH`. | `npm install` in this repo, or `npm install -g @anthropic-ai/claude-code`. Under cron, see the [environment trap](deploy-other.md#the-trap-cron-has-almost-no-environment). |

### Run failures (exit code 1)

| Message | Meaning | Fix |
|---|---|---|
| `The \`claude\` CLI was not found on PATH.` | Same as above, hit at spawn time. | `npm install`, or install globally. |
| `Run exceeded RUN_TIMEOUT_MS (Nms) and was terminated.` | The run took longer than 45 minutes. | Usually a cap set too high, or a slow provider. Lower `caps.max_per_day`, or raise `RUN_TIMEOUT_MS` — but keep it under your platform's job ceiling. |
| `claude exited N: …` | The agent subprocess failed. The last 800 characters of stderr are included. | Read the stderr tail. |
| `WARNING: the agent finished without writing a run report.` | Not a failure exit, but the run is **unverified** — it finished without reporting what it did. Status is recorded as `completed-no-report`. | Do not treat this as a quiet day. Investigate before the next run, and do not remove `DRY_RUN` until it stops happening. |

---

**Related:** [Safety and compliance](safety-and-compliance.md) ·
[Security](security.md) · [Deploy on Railway](deploy-railway.md) ·
[Deploy anywhere else](deploy-other.md) · [Upgrading](upgrading.md) ·
[Adding a provider](providers.md) · [README](../README.md)
