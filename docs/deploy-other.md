# Deploy anywhere else

[Railway](deploy-railway.md) is the default path. The shape is identical
everywhere else, because there is only one shape: **one always-on process**
(the host in [`runner/host.mjs`](../runner/host.mjs)) with a **persistent
volume or disk at `/data`**. No cron — the host schedules its own motions. No
port — it dials out to Slack over Socket Mode and nothing reaches in. **A
single instance only** — two hosts would split Slack button clicks and diverge
the ledger.

The environment is the same on every host: `SLACK_BOT_TOKEN`,
`SLACK_APP_TOKEN`, exactly one model credential (`CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`), `FT_MCP_TOKEN`, and `HUBSPOT_ACCESS_TOKEN` if a motion
needs the CRM. On every host, watch the logs for the claim code, DM the bot,
and say "onboard".

- [Docker / Compose](#docker--compose)
- [Fly.io](#flyio)
- [Render](#render)

---

## Docker / Compose

[`docker-compose.yml`](../docker-compose.yml) is in the repo, with one service,
`host`, and one named volume mounted at `/data`. There are no `ports:` in it on
purpose.

```bash
cp .env.example .env      # fill in the tokens above
docker compose up -d      # start the always-on host
docker compose logs -f    # watch for the claim code, then DM the bot
```

The compose file sets `STATE_DIR=/data/state` and `CONFIG_DIR=/data/config` and
uses `restart: unless-stopped`, so the host comes back after a reboot. A fresh
volume starts empty and the bot onboards you. Optionally mount your
operator-owned do-not-contact list read-only, outside the agent-writable
config, so the agent can neither read nor edit it (see the commented line in the
compose file).

Without Compose:

```bash
docker run -d --restart unless-stopped --env-file .env \
  -v agent-data:/data ghcr.io/first-touch-inc/firsttouch-agent
```

## Fly.io

[`fly.toml`](../fly.toml) runs the same single always-on host — there is no
`[http_service]` block because it opens no port, and no scheduler because the
host schedules itself.

```bash
fly launch --no-deploy
fly secrets set SLACK_BOT_TOKEN=… SLACK_APP_TOKEN=… \
  CLAUDE_CODE_OAUTH_TOKEN=… FT_MCP_TOKEN=…
fly volumes create agent_data --size 1
fly deploy
fly logs                  # watch for the claim code, then DM the bot
```

Fly volumes are single-attach: one volume, one machine. Keep the app at
`fly scale count 1` — a second machine gets no state, its ledger diverges, and
the two would split Slack clicks. Do not enable autostop/autosuspend: there is
no inbound request to wake the host, because nothing listens.

## Render

[`render.yaml`](../render.yaml) is a **worker** service (not a cron job, not a
web service) with a persistent disk at `/data`.

```
Render dashboard → New → Blueprint → point at this repo.
```

Set the secrets when prompted (`sync: false` means Render asks you in the
dashboard rather than reading them from git — never put a real secret in the
file), deploy, then watch the logs for the claim code and DM the bot. The
blueprint already sets `STATE_DIR`, `CONFIG_DIR`, and `AGENT_CONFIG`. It is a
worker because the host is long-running and opens no port; the disk is what
makes the ledger survive a redeploy.

---

**Related:** [Deploy on Railway](deploy-railway.md) ·
[Configuration reference](configuration.md) · [Providers](providers.md) ·
[Upgrading](upgrading.md) · [README](../README.md)
