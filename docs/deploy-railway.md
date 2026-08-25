# Deploy on Railway

The agent is **one always-on process** — the host in
[`runner/host.mjs`](../runner/host.mjs). It lives in Slack over Socket Mode,
schedules its own motions, and gates every send behind an approval card. There
is **no cron to arrange** (the host schedules itself) and **no port to expose**
(it dials out — nothing reaches in). You need one Railway service, a volume,
and a handful of environment variables.

- [Step 1 — create the service](#step-1--create-the-service)
- [Step 2 — attach a volume at /data](#step-2--attach-a-volume-at-data)
- [Step 3 — set the environment](#step-3--set-the-environment)
- [Step 4 — claim it and onboard](#step-4--claim-it-and-onboard)
- [One instance only](#one-instance-only)

---

## Step 1 — create the service

In Railway: **New Project → Deploy from GitHub repo**, and pick this repo (or
your fork). Railway detects the `Dockerfile` at the repo root and builds it —
no builder to select. The image's `CMD` runs the host, so there is no start
command to set.

**Do not set a Restart Policy of the cron kind, a Cron Schedule, or a
Healthcheck Path.** This is a long-running worker, not a scheduled job and not
a web service: it should stay up, it opens no port, and it fires its own
schedule internally.

## Step 2 — attach a volume at /data

Service → **Settings → Volumes → Add Volume**, mount path **`/data`**.

Everything the agent owns lives here: `config/agent.yaml`, your plays, the
voice pack, and the SQLite ledger (identity, suppression, caps, decisions,
durable undo intents, lessons). The `Dockerfile` sets `STATE_DIR=/data/state`
and `CONFIG_DIR=/data/config` and declares `VOLUME ["/data"]`, so a fresh
deploy writes to the right place. Without the volume the ledger resets on every
deploy and the same people get contacted twice.

If the run hits a permission error writing `/data`, set `RAILWAY_RUN_UID=0` in
Variables and redeploy — the image runs as the unprivileged `node` user and a
runtime-mounted volume can land root-owned.

## Step 3 — set the environment

Service → **Variables**. Set:

| Variable | Required | What it is |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | `xoxb-…`, from installing the Slack app (README step 1). |
| `SLACK_APP_TOKEN` | Yes | `xapp-…` with `connections:write`, for Socket Mode. |
| `CLAUDE_CODE_OAUTH_TOKEN` **or** `ANTHROPIC_API_KEY` | Yes, exactly one | Model access. Setting both is a startup error. |
| `FT_MCP_TOKEN` | Yes | FirstTouch MCP bearer token (`https://mcp.firsttouch.ai`). |
| `HUBSPOT_ACCESS_TOKEN` | If a motion needs CRM | HubSpot private-app token. |

The `Dockerfile` already sets `STATE_DIR`, `CONFIG_DIR`, and
`AGENT_CONFIG=agent`; you only override those if you renamed your config file.
No cron variable, no port variable — neither exists.

```bash
railway variables \
  --set SLACK_BOT_TOKEN=xoxb-... \
  --set SLACK_APP_TOKEN=xapp-... \
  --set CLAUDE_CODE_OAUTH_TOKEN=... \
  --set FT_MCP_TOKEN=...
```

A note on `CLAUDE_CODE_OAUTH_TOKEN`: it runs on an existing Claude subscription
instead of API billing, but subscription limits are not designed for
unattended automation. Check your plan terms before using it for an always-on
host.

## Step 4 — claim it and onboard

Watch the logs:

```bash
railway logs
```

On first boot with an empty volume the host prints a **claim code**. DM the bot
that code in Slack — you become the operator. Then say **"onboard"**: the agent
interviews you (which motions, who sends, an approvals channel per sender, your
ICP and voice), validates each step live, writes `config/agent.yaml` to the
volume, and finishes with a supervised dry run.

## One instance only

Keep this service at a single replica. Two hosts would split Slack button
clicks and diverge the ledger — a Railway volume attaches to one instance
anyway, which is exactly the constraint you want here.

---

**Related:** [Deploy anywhere else](deploy-other.md) ·
[Configuration reference](configuration.md) · [Providers](providers.md) ·
[Upgrading](upgrading.md) · [README](../README.md)
