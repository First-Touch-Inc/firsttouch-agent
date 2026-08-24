# CRM adapters

This directory holds the agent's CRM adapters. Each one is a self-contained MCP
server the agent spawns over stdio.

`hubspot-server.mjs` is the HubSpot adapter: it authenticates with a HubSpot
**private-app token** (`HUBSPOT_ACCESS_TOKEN`, sent as `Bearer` against
`api.hubapi.com`) and exposes twelve tools the agent uses to decide who is worth
working today. Eleven of them read. One writes, and it is switched off by
default — see [the write gate](#the-write-gate).

**There are no deal writes at all** — not gated, not implemented. The four deal
tools read pipeline state so the agent can avoid people it should not contact;
moving a deal stage is a sales decision, not an agent one.

It has **no npm dependencies**. Node >= 20 provides `fetch`, and MCP over stdio
is small enough to implement directly, so it is implemented directly: JSON-RPC
2.0, newline-delimited JSON, roughly 700 readable lines. This process runs
inside your infrastructure holding a token to your entire customer database, and
every dependency here would be supply-chain surface next to that token.

- **Protocol**: MCP revision `2025-11-25` (the `initialize` handshake era). It
  also answers `2025-06-18`, `2025-03-26` and `2024-11-05` if a client asks for
  them. Revision `2026-07-28` replaced the handshake with per-request metadata;
  this server does not implement that era, and correctly signals as much, so
  dual-era clients negotiate down to the handshake automatically.
- **Transport**: stdio. **stdout carries protocol frames only** — all logging
  goes to stderr, and the server aliases `console.log` onto stderr so a stray
  log line can never corrupt the stream.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | yes | Private-app token, starts with `pat-`. Settings > Integrations > Private Apps. |
| `CRM_WRITES_ENABLED` | no | Must be exactly `1` to allow the one write tool. Anything else, including unset, means read-only. |
| `HUBSPOT_API_BASE_URL` | no | Test seam for pointing at a mock server. Leave unset in production. |

The runner registers this adapter automatically in `buildMcpConfig()` in
[`../run-daily.mjs`](../run-daily.mjs), under the server name `crm`. That name
matters: the agent's `--allowedTools` allowlist grants `mcp__crm__*`, so an
adapter registered under any other name has all of its tools denied.

**A missing token is not a startup failure.** The server still starts and still
serves `tools/list`; every `tools/call` returns a clear error naming
`HUBSPOT_ACCESS_TOKEN`. Exiting at startup would surface to the operator as
"MCP server failed to start" and send them debugging the wrong thing.

## Required private-app scopes

Add these in HubSpot under Settings > Integrations > Private Apps > *(your app)*
> Scopes. **Changing scopes invalidates the existing token**, so re-copy it
afterwards and update your `.env`.

| Tool | Scope(s) |
|---|---|
| `crm_get_list_members` | `crm.lists.read`, plus `crm.objects.contacts.read` or `crm.objects.companies.read` depending on what the list holds |
| `crm_get_contact` | `crm.objects.contacts.read` |
| `crm_get_company` | `crm.objects.companies.read` |
| `crm_search_contacts` | `crm.objects.contacts.read` |
| `crm_search_companies` | `crm.objects.companies.read` |
| `crm_search_deals` | `crm.objects.deals.read` (the same scope covers the cached pipelines lookup) |
| `crm_get_deal` | `crm.objects.deals.read` |
| `crm_get_deals_for_contact` | **both** `crm.objects.contacts.read` **and** `crm.objects.deals.read` — the call reads a contact and its deal associations, so either scope can 403 it |
| `crm_get_pipelines` | `crm.objects.deals.read` |
| `crm_get_owners` | `crm.objects.owners.read` |
| `crm_get_contact_activity` | `crm.objects.contacts.read`; **plus `sales-email-read` for the `emails` type** |
| `crm_update_property` | `crm.objects.contacts.write` and/or `crm.objects.companies.write` (in addition to the matching read scope) |

The minimum read-only set for a normal run:

```
crm.lists.read
crm.objects.contacts.read
crm.objects.companies.read
crm.objects.deals.read
crm.objects.owners.read
sales-email-read
```

`crm.objects.deals.read` is the only scope the deal tools need. It covers three
different endpoint families, which is worth knowing because none of them have a
scope of their own:

- deal reads and search — `/crm/v3/objects/deals/*`
- **deal pipelines** — `GET /crm/v3/pipelines/deals`. There is no
  `crm.pipelines.read`. The only scope strings HubSpot publishes under
  "pipelines" are `crm.pipelines.orders.read` / `.write`, and those are for
  **order** pipelines in Commerce Hub, not deals. Granting one of those instead
  will not make `crm_get_pipelines` work.
- **the contact→deal association**, read via the `associations` parameter on the
  contact. This one needs the scope for *both* ends, so
  `crm_get_deals_for_contact` fails without `crm.objects.contacts.read` as well.

If a call comes back `403`, the adapter names the scope it thinks is missing in
the error text rather than making you guess from a bare status code — and for
the two-object-type call it names both candidates.

> **Not fully verified:** HubSpot's public docs do not state the scope for the
> notes/calls/meetings/tasks engagement endpoints as clearly as they do for
> contacts, companies and owners. The adapter assumes `crm.objects.contacts.read`
> covers them and `sales-email-read` covers email engagements. If
> `crm_get_contact_activity` returns a `403` for one activity type, read the
> scope named in the message and add it — the tool degrades per type rather than
> failing the whole call, so the other activity types still come back.

## The deal tools

Four read-only tools, added for two motions that were previously impossible:

| Tool | What it answers |
|---|---|
| `crm_search_deals` | "Which open deals has nobody touched in 30 days?" Filter-based deal search |
| `crm_get_deal` | One deal with its properties and its associated contact and company ids |
| `crm_get_deals_for_contact` | "Does this person have an open deal?" — the open-deal suppression check |
| `crm_get_pipelines` | Every pipeline and stage, with `closed` / `won` / `lost` decoded |

**Open-deal suppression.** `config/tenant.example.yaml` lists `"Contacts with an
open deal"` under `suppression`, and the skills reference it. `crm_get_deals_for_contact`
is what implements it: it returns `hasOpenDeal` plus a per-deal
`status` of `open` / `won` / `lost`.

**Stalled-deal follow-up.** `crm_search_deals` takes `only_open: true` with
`no_activity_days: 30` and returns open deals that have gone quiet, with stage,
amount, close date and owner attached, so the agent can diagnose the stall.

### Why stage ids are not hardcoded anywhere

Deal stage ids are **portal-specific opaque strings** — `appointmentscheduled`
in one account, `9876543` in the next — so nothing in this adapter can know
which stage means "won". Two independent mechanisms resolve it, and both are
returned to the agent:

1. **`hs_is_closed`, `hs_is_closed_won` and `hs_is_closed_lost`** — HubSpot
   *calculates* these read-only booleans on every deal, so they cost nothing
   extra. They arrive as the strings `"true"` / `"false"`, not JSON booleans.
2. **`crm_get_pipelines`** — each stage's `metadata.isClosed` says whether it
   stops the deal, and `metadata.probability` says which way it went: HubSpot
   defines **1.0 as Closed Won and 0.0 as Closed Lost**. The adapter decodes
   that into plain `closed` / `won` / `lost` booleans plus a single `meaning`
   field, so the agent never has to know the rule. Pipeline definitions are
   cached for **ten minutes**, so the extra call happens at most once a run.

**Unclassifiable deals are reported as `"unknown"`, never as "not open".** The
two mistakes are not symmetric: reading a live negotiation as "no open deal"
sends prospecting mail into an account your team is trying to close, so
`crm_get_deals_for_contact` returns an `unclassifiedCount` and tells the agent
in words to suppress the contact when it is above zero.

## The write gate

`crm_update_property` is the only tool that changes anything, and it refuses to
run unless:

```bash
CRM_WRITES_ENABLED=1
```

The check is `=== '1'` and nothing else. Not truthiness, not `true`, not `yes` —
a gate that accepts several spellings is a gate that opens by accident when a
deploy script sets the variable to the wrong thing. Unset means closed; anything
unexpected means closed. When it is closed the tool returns a normal tool error
explaining the gate and telling the model to report what it *would* have changed,
so a run continues usefully instead of dying.

**Why this exists.** An outbound agent holding a CRM write credential is one bad
inference away from rewriting a company's pipeline, and CRM writes fan out:
they trigger workflows, move deal stages, and notify reps. HubSpot has no undo.
So the capability lives in the environment, where a human sets it and the model
cannot reach it.

Even with the gate open, the tool is deliberately narrow:

- **one record per call** — there is no bulk form to accidentally reach for
- **at most 10 properties per call**, so a single mistaken call cannot rewrite a record
- **no creates, no deletes, no merges, no associations** — `PATCH` on an existing record only
- **HubSpot-managed properties are rejected** (`hs_object_id`, `createdate`, `lastmodifieddate`, …)
- **clearing a value requires `allow_clear: true`.** HubSpot treats `null` and
  `""` as "erase this property", which is the closest thing to a delete this
  adapter could ever do, so it is never the default reading of a model-produced
  value.

> **Operator note.** The variable has to reach *this process*, not just your
> shell. `buildMcpConfig()` passes an explicit `env` block when it registers the
> adapter — if you enable writes, make sure `CRM_WRITES_ENABLED` is listed there
> too, then confirm with the startup line on stderr, which reports
> `writes ENABLED` or `writes disabled` on every boot.

## Keeping results small

Everything a tool returns is pasted into the agent's context window, and HubSpot
contacts routinely carry 300+ mostly-empty properties. The adapter therefore
enforces, in code:

- a **default property whitelist** per object type (callers may add tenant-specific
  fields, up to 40 total)
- a hard ceiling of **100 records per call**, with over-large `limit` values
  clamped rather than rejected, so the agent still makes progress
- **empty values dropped** and long free-text values **truncated at 500 characters**

## Error handling

| Status | What the agent is told |
|---|---|
| 401 | Check `HUBSPOT_ACCESS_TOKEN` — wrong, expired, rotated, or the wrong portal |
| 403 | The private app is missing a scope, and **which** scope that likely is |
| 404 | No such record or list, with a reminder that a list id is the ILS id |
| 429 | Rate-limited, including the `Retry-After` value |
| 5xx | Transient server error |

Retries are bounded and narrow: **at most 3 attempts**, only on `429`, `5xx`, and
transport errors. Any other `4xx` is a deterministic answer and is never
retried — repeating it only burns rate limit and delays the real error reaching
the agent. `Retry-After` is honoured when present, otherwise exponential backoff
with jitter. If `Retry-After` exceeds 10 seconds the adapter stops and returns
the rate-limit error instead of blocking: an agent told "rate limited, wait 90s"
can reschedule, whereas a tool call that silently blocks for 90 seconds looks
like a hang and gets killed by the client's own timeout.

## Adding an adapter for a different CRM

The contract is the twelve tool names in
[`docs/providers.md`](../../docs/providers.md) — the skills call them by name, so
an adapter that renames them will not work. Start by copying
`hubspot-server.mjs`; the protocol half (framing, handshake, dispatch) is generic
and only the HubSpot half below it needs replacing.

1. **Keep the tool names and result shapes.** Return compact JSON inside a single
   `{ type: "text" }` content block.
2. **Keep the failure messages diagnostic.** The model reads them and relays them
   to a human. Say *"the private app is missing the owners read scope"*, not *"403"*.
3. **Keep results small.** Whitelist properties and cap record counts. One
   unconstrained call that dumps a megabyte of records into the context degrades
   every decision the agent makes afterwards.
4. **Keep the write gate.** Whatever your CRM calls it, the single write stays
   behind `CRM_WRITES_ENABLED=1`, and creates/deletes stay unimplemented.
5. **Register it** in `buildMcpConfig()` in [`../run-daily.mjs`](../run-daily.mjs)
   under the server name `crm`, add the `kind` to `IMPLEMENTED_CRM` in
   [`../lib/config.mjs`](../lib/config.mjs), and add a test.

Then `npm run preflight` to confirm it connects, and `npm run dry` for a full run
that creates nothing.

## Testing it by hand

The server is just a process that reads JSON-RPC on stdin, so you can drive it
without an agent. It needs no token to answer the handshake:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"manual","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node runner/mcp/hubspot-server.mjs
```

You should get two JSON frames on stdout — an `initialize` result naming
protocol `2025-11-25`, and the twelve tool descriptors — with all logging on
stderr. Add `HUBSPOT_ACCESS_TOKEN=...` and a `tools/call` frame to exercise a
real read:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"manual","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"crm_get_pipelines","arguments":{}}}' \
  | HUBSPOT_ACCESS_TOKEN=pat-... node runner/mcp/hubspot-server.mjs
```

`HUBSPOT_API_BASE_URL` points the adapter at a mock server instead, which is how
the retry, error-mapping and deal-classification paths get exercised without a
live portal.
