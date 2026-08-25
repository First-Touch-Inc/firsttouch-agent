# Configuration reference

The agent is configured by one YAML file. In Docker it lives at
`/data/config/agent.yaml`; locally it is `config/agent.yaml`. Which file is
read is decided by `AGENT_CONFIG` (default `agent`, i.e. `config/agent.yaml`).

[`config/agent.example.yaml`](../config/agent.example.yaml) is the
authoritative, annotated reference — every key, with a comment explaining the
consequence of getting it wrong. This page is the map; that file is the
territory. Copy it to `config/agent.yaml` and edit, **or** let the agent write
it for you: say "onboard" in Slack and it interviews you and writes the file.
Both paths run the **same** validation — onboarding cannot produce a config
that hand-editing would reject.

Two rules hold across the whole file:

- **No silent defaults for anything tenant-specific.** A missing owner id, a
  blank list id, or an `<angle-bracket>` placeholder left in place is a startup
  error, not a warning. The loader reports every problem at once.
- **Slack and provider ids are raw ids** (`U…`, `C…`, `usr_…`), never display
  names.

Secrets are never in this file. They are environment variables — see the
deploy guides ([Railway](deploy-railway.md), [others](deploy-other.md)).

---

## The sections

### `client`

Company name and IANA `timezone`. Every schedule below runs in this zone.

### `icp`

Prose describing who you sell to — and, more usefully, who is **not** a fit.
The agent quotes this back during onboarding and pushes for exclusions. Blank
fails load.

### `voice_pack`

Path to your voice pack (written by onboarding). Lessons distilled from your
edits override it over time.

### `run_mode`

`supervised` (every run capped small, ends in a digest for review) or `daily`
(normal operation). Onboarding always starts `supervised`.

### `providers`

- `outreach.kind: firsttouch` — the only implemented outreach adapter.
- `crm.kind: hubspot`, plus `customer_signal`: the CRM properties that mark an
  existing customer, so the agent never prospects one. There is no safe default
  here — these are properties from **your** CRM.

See [providers.md](providers.md) for how the adapters work.

### `motions`

The jobs the agent does. Enable any subset; each runs on its own `schedule`
(cron, in `client.timezone`). `kind` is one of:

- `outbound` — sweeps warm signals and lists, researches, drafts first touches.
- `inbound` — triages hand-raise lists, more often and cheaply.
- `deal_followup` — nudges stalled deals; may propose changes only to the CRM
  properties listed in `crm_fields_may_change`, shown on the card as from → to.
- `cs_postclose` — drafts check-ins for at-risk/milestone accounts, routed to
  the account's CS owner, reading an identity-asserted CS dashboard.

Turning a motion on later is a chat exchange, not a redeploy.

### `approval` and `approval_routing`

Approvals happen **in Slack**, on interactive cards: **Approve** /
**Edit & approve** / **Deny** (reason required), with a 45-second undo after
approval. Cards route **by owner, not by motion** — each owner has their own
channel (`slack_channel`, e.g. `#ada-approvals`), because only the person a
message sends *as* may approve it. `approval.digest_channel` gets run digests
and report-only cards; `expiry_hours` cards expire **unapplied**. Exactly one
owner has `match: default`.

### `limits` and `dedupe`

Hard caps enforced in code against the ledger — per day, per week, per
contact/company per quarter, enrichment credits per run. A denied card returns
its reservation. `dedupe.rework_cooldown_days` rests a denied/ignored prospect.

### `suppression` and `excluded_domains`

The people the agent will never contact, **enforced in code**: the ledger is
seeded from `crm_customer_signal`, the operator-owned `do_not_contact_file`
(`config/do-not-contact.txt`), and `excluded_domains`. Domain entries are the
backstop that catches people with no CRM record. Checked at stage and
re-checked at apply.

### `flows`

The allowlist of FirstTouch flows the agent may enrol contacts into. **The
allowlist is the permission** — enrolling into any flow not listed is refused
in code. Empty = none.

### `external_tools`

Any read-only MCP server you want the agent to use (Clay, Apollo, Gong, an
internal API), proxied through the agent's tool server. The model never holds
the token — the config names the **env-var name** (`token_env`), not the token
— and only the tools you `allow` exist. Operator-config only. See
[providers.md](providers.md#external-tools).

### `chat`

The always-on conversational surface. `allowed_users` gates who it answers
(empty = nobody, and it refuses to start); `campaigns_enabled` turns on one-off
campaigns from chat.

### `slack` and `state`

`slack.operator` is bound by the claim code at first boot; onboarding cannot
change it. `state.ledger` is the SQLite ledger path (on the writable volume via
`STATE_DIR`).

---

**Related:** [Deploy on Railway](deploy-railway.md) ·
[Deploy anywhere else](deploy-other.md) · [Providers](providers.md) ·
[Upgrading](upgrading.md) · [README](../README.md)
