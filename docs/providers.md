# Providers

The agent talks to two external systems, declared in `config/tenant.yaml`:

```yaml
providers:
  outreach:
    kind: firsttouch      # executes touches, owns the approval queue
  crm:
    kind: hubspot         # accounts, contacts, ownership
```

Only those two values have adapters today. Anything else fails at startup with a
message naming what is implemented — deliberately, rather than starting up and
half-working:

```
providers.crm.kind "salesforce" has no adapter in this repo.
Implemented: hubspot. See docs/providers.md to add one.
```

That check lives in [`runner/lib/config.mjs`](../runner/lib/config.mjs).

## The two roles are not interchangeable

**The outreach provider is the safety boundary.** It creates approval-gated
actions, holds the queue a human reviews, and is the thing that eventually
sends. The agent never sends directly — it asks the outreach provider to create
something *pending*. If you swap this out, you are replacing the approval gate,
so whatever you put there must have one.

**The CRM is read-mostly.** The agent reads lists, contacts, companies, owners
and activity from it. The bundled adapter can write exactly one thing — a
property update — and refuses even that unless `CRM_WRITES_ENABLED=1`.

## Adding a CRM adapter

The CRM adapter is a small MCP server in this repo. There is no plugin system to
learn: it is one file, no dependencies, and the runner points at it.

Start from [`runner/mcp/hubspot-server.mjs`](../runner/mcp/hubspot-server.mjs).
It is deliberately plain — JSON-RPC over stdio, `fetch`, no SDK — so it is
readable end to end.

**1. Implement the same tools.** The skills call these by name, so an adapter
that renames them will not work:

| Tool | Returns |
|---|---|
| `crm_get_list_members` | Contacts or companies on a saved list, paged |
| `crm_get_contact` | One contact by id or email, with its company |
| `crm_get_company` | One company by id or domain |
| `crm_search_contacts` | Filter-based contact search |
| `crm_search_companies` | Filter-based company search |
| `crm_get_owners` | Users who can own a record — used to route drafts |
| `crm_get_contact_activity` | Recent engagements, so the agent can tell whether anyone followed up |
| `crm_update_property` | The only write. Must stay behind `CRM_WRITES_ENABLED`. |

**2. Keep the failure messages diagnostic.** The model reads them and reports
them to a human. Say *"the private app is missing the owners read scope"*, not
*"403"*. The bundled adapter maps every common status this way — copy that.

**3. Keep results small.** Whitelist the properties you return. One
unconstrained call that dumps a megabyte of CRM records into the context window
degrades every decision the agent makes afterwards.

**4. Register it** in `buildMcpConfig()` in
[`runner/run-daily.mjs`](../runner/run-daily.mjs), under the server name `crm`.
The name matters: the `--allowedTools` allowlist grants `mcp__crm__*`, so a
server registered under a different name will have all of its tools denied.

**5. Add the `kind` to `IMPLEMENTED_CRM`** in `runner/lib/config.mjs`, and a test.

Then:

```bash
npm run preflight     # confirms the adapter connects and the token works
npm run dry           # a full run against it, creating nothing
```

## Adding an outreach provider

Harder, and worth being honest about: this is not a drop-in swap.

The outreach provider is not just a send API. The agent depends on it for
signals (who engaged with your content), enrichment, connection status, and —
critically — an **approval queue with per-action ownership**. Substituting a
provider that only sends gives you an agent that drafts into nothing, with no
gate between a draft and a real person's inbox.

If you want to try, the provider must be able to:

- Create an action in a **pending** state that does not send until a human approves it
- **Assign each action to a specific sending user**, and let you read that assignment back to verify it. This one is not negotiable — see the ownership rule in [the orchestrator skill](../.claude/skills/pipeline-agent/SKILL.md). Without it, an approved draft sends from whichever account the API token belongs to, which means one person's outreach goes out under another person's name, and it cannot be undone.
- Report existing enrollments so the agent can suppress anyone already in a sequence
- Report connection status for social channels

Talk to us before building one — open an issue describing the provider and what
it can do, and we will tell you honestly whether the shape fits.

## Why there is no generic "any CRM" abstraction

It was considered and rejected. The lowest common denominator across CRMs is
roughly "a contact has an email", which is not enough to do this job — the agent
needs list membership, ownership, lifecycle, and activity history, and every CRM
models those differently enough that a generic layer becomes a config language
of its own.

A concrete adapter per CRM is more code and far less rope. When you hit
something your CRM cannot express, you find out at preflight rather than three
weeks into a schedule.
