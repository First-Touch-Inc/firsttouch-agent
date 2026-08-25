# Providers

Every external system the agent touches is reached through an adapter in
[`runner/lib/providers.mjs`](../runner/lib/providers.mjs). That file is the
**only** place provider credentials live, and it runs in trusted processes only
— the host and the tool server. The model's environment never contains these
tokens; it acts on the world only by calling the enumerated tools the tool
server exposes.

- [FirstTouch (outreach)](#firsttouch-outreach)
- [HubSpot (CRM)](#hubspot-crm)
- [The dashboard reader (cs_postclose)](#the-dashboard-reader-cs_postclose)
- [Adding a provider](#adding-a-provider)
- [External tools](#external-tools)

---

## FirstTouch (outreach)

FirstTouch is reached over **MCP** (streamable HTTP), not a REST API: one
bearer token, `FT_MCP_TOKEN`, against `https://mcp.firsttouch.ai`
(override with `FT_MCP_URL`). The adapter covers the whole outreach lifecycle:

- **Source sweeps** — social-engagement engagers, a HubSpot list preview,
  ICP-filter contact discovery.
- **Enrichment** — contact, company, and email-finding (paid reads, behind the
  enrichment cap).
- **Staging and apply** — it creates each action in a **pending, approval-gated**
  state assigned to a specific sending user (owner *and* assignee), reads it
  back, completes it on approval, and cancels it on denial. An action created
  without an explicit owner lands on whoever the API token authenticates as —
  which is how one person's outreach goes out under another person's name.

Each mapped platform tool name is an acceptance criterion: preflight calls the
cheap ones and refuses to start if the platform does not answer, so a renamed
upstream tool fails at boot, not mid-apply.

## HubSpot (CRM)

HubSpot is reached over its **REST API** directly, with `HUBSPOT_ACCESS_TOKEN`.
It is **read-mostly**: the agent searches contacts, reads list memberships and
deals, and lists the customers matching your `customer_signal` (the input to
the suppression seed, so it never prospects a paying customer). The one write
path is a **compare-and-set** property update — read the current value, then
patch — used by motions that are allowed to change specific CRM fields.

## The dashboard reader (cs_postclose)

The `cs_postclose` motion reads an account-health dashboard the tenant
configures. It is **identity-asserted, not just liveness-checked**: before the
first read of a base URL (and again after any failure) the base URL's own
response must contain the configured `identity` string. A stale or moved host
that merely answers `200 ok` is refused — that is the exact incident class the
check exists to prevent.

## Adding a provider

Implement the interface the existing adapters implement in
[`runner/lib/providers.mjs`](../runner/lib/providers.mjs) — the tool server and
the apply path consume those shapes by name, so keep the method names. Two ways
to ship it:

- **In the engine** — add the adapter to `providers.mjs` and wire it in. Fine
  for something you intend to upstream.
- **As a private adapter, without forking** (the sanctioned door) — the overlay
  image sets `EXTRA_ADAPTERS_DIR` to a directory it `COPY`ed into the image,
  whose `index.mjs` exports `register({ providers, cfg })` and may extend or
  replace providers. **The one rule, enforced in code:** that directory must
  **not** live on the writable volume (`CONFIG_DIR`/`STATE_DIR`). Adapter code
  is credential-holding; loading code the agent's own user could have written
  would reopen the self-modification hole the image/volume split exists to
  close. Image-only, or refused. See [upgrading.md](upgrading.md) for the
  overlay model.

## External tools

`external_tools` in the config lets the agent use **any read-only MCP server**
you name — Clay, Apollo, Gong, an internal API — proxied through the agent's
tool server. It is **operator-config only**. Each entry names:

- `url` — the MCP endpoint,
- `token_env` — the **name of the environment variable** holding the token
  (never the token itself; the model's process never holds it),
- `allow` — the exact tools that exist; anything not listed is refused, and the
  allowlist is re-checked on every call.

Keep these to reads. They are proxied outside this agent's own approval loop,
so acting on the world through one would be an explicit, un-gated choice rather
than a default.

---

**Related:** [Configuration reference](configuration.md) ·
[Deploy on Railway](deploy-railway.md) · [Upgrading](upgrading.md) ·
[README](../README.md)
