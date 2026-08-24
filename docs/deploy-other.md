# Deploy anywhere else

[Railway](deploy-railway.md) is the default path. This covers everything else.

The job is the same everywhere: run `node runner/run-daily.mjs` once a day, let
it exit, and give it a durable place to write `state/`. Nothing listens on a
port, so there is no reverse proxy, no TLS termination, and no firewall rule to
write.

- [Choosing](#choosing)
- [Docker and Compose](#docker-and-compose)
- [A plain VPS with host crontab](#a-plain-vps-with-host-crontab)
- [Render](#render)
- [Fly.io](#flyio)
- [What every host needs to get right](#what-every-host-needs-to-get-right)

---

## Choosing

| Host | Native cron | Persistent state | Notes |
|---|---|---|---|
| [Railway](deploy-railway.md) | Yes | Volume, one per service | The default. UTC only |
| [Docker / Compose](#docker-and-compose) | Via `runner/scheduler.mjs` | Named volume | Simplest thing that works on any box |
| [VPS + crontab](#a-plain-vps-with-host-crontab) | Yes, the real one | The filesystem | Most control, most to get wrong |
| [Render](#render) | Yes, `type: cron` | See the caveat below | UTC only, per-job monthly minimum |
| [Fly.io](#flyio) | **No** | Volume, single-attach | Needs supercronic or similar |

---

## Docker and Compose

[`docker-compose.yml`](../docker-compose.yml) is already in the repo, with two
services. There are no `ports:` in it. If you ever add one, be certain you know
what is listening.

**One run, right now:**

```bash
docker compose run --rm agent --dry     # research and draft, create nothing
docker compose run --rm agent           # a real run
```

The `agent` service is one-shot. It does not stay running.

**Every weekday morning:**

```bash
docker compose up -d scheduler
docker compose logs -f scheduler
```

The `scheduler` service runs [`runner/scheduler.mjs`](../runner/scheduler.mjs),
a dependency-free 5-field cron matcher that spawns one run at a time and refuses
to start a second while the first is going. It is set to `0 8 * * 1-5` in the
compose file and reads `TZ` from your environment, so unlike Railway and Render
it can schedule in local time with real DST handling:

```bash
TZ=America/New_York docker compose up -d scheduler
```

Two things about the scheduler worth knowing:

- It supports `*`, `,`, `-`, `/` and numeric ranges only. No `@daily`, no `L`,
  `W`, `#`, no named months or weekdays. A bad expression exits with code 2 and
  tells you which field.
- Set `RUN_ON_START=1` to also run once immediately at boot. Useful for testing,
  a bad idea to leave on if the container restarts often.

Both services mount `./config` and `./voice-pack.md` read-only, so editing them
on the host takes effect on the next run without a rebuild, and a compromised
container cannot rewrite them.

**Add your opt-out list to those mounts.** As shipped,
`docker-compose.yml` does not mount `do-not-contact.txt`, so the container falls
back to whatever the image was built with. Add it to the `volumes:` list of both
services:

```yaml
      - ./do-not-contact.txt:/app/do-not-contact.txt:ro
```

Same reasoning as the config mounts: edit it on the host, take effect next run,
and the container cannot rewrite it.

Or without Compose:

```bash
docker build -t pipeline-agent .
docker run --rm --env-file .env -v pipeline-state:/data pipeline-agent
```

---

## A plain VPS with host crontab

The most control, and the option with the trap that catches everyone.

**Setup:**

```bash
git clone https://github.com/First-Touch-Inc/firsttouch-pipeline-agent.git /opt/pipeline-agent
cd /opt/pipeline-agent
npm ci --omit=dev
cp .env.example .env          # fill it in
cp config/tenant.example.yaml config/tenant.yaml
cp voice-pack.example.md voice-pack.md
cp do-not-contact.example.txt do-not-contact.txt
npm run preflight
npm run dry
```

Run it as a dedicated unprivileged user that owns nothing else. `.env` holds
tokens with real blast radius — see [security.md](security.md):

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin pipeline
sudo chown -R pipeline:pipeline /opt/pipeline-agent
sudo chmod 600 /opt/pipeline-agent/.env
```

### The trap: cron has almost no environment

A cron job does **not** get your login shell's environment. It gets a nearly
empty one — typically just `HOME`, `LOGNAME`, `SHELL`, `PATH` (often only
`/usr/bin:/bin`), and nothing else. No `nvm`, no `.bashrc`, no `.profile`, and
**no `.env`**: this repo does not call `dotenv` anywhere, it reads
`process.env` directly. Locally that works because your shell loaded `.env` for
you or you exported the values. Under cron nothing does.

So a naive crontab line fails in one of two ways: `node: command not found`, or
worse, it runs and exits 2 with `Missing required credentials` — a job that
looks scheduled and quietly does nothing every morning.

Use a wrapper script rather than trying to cram this into the crontab line:

```bash
sudo tee /opt/pipeline-agent/run.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

cd /opt/pipeline-agent

# Absolute paths. Do not rely on cron's PATH.
export PATH="/usr/local/bin:/usr/bin:/bin:/opt/pipeline-agent/node_modules/.bin"

# Load .env. `set -a` exports everything the file defines.
# This handles KEY=value lines and comments; it does NOT handle values with
# embedded newlines. Keep .env boring.
set -a
# shellcheck disable=SC1091
. /opt/pipeline-agent/.env
set +a

exec /usr/bin/node /opt/pipeline-agent/runner/run-daily.mjs
EOF

sudo chmod 700 /opt/pipeline-agent/run.sh
sudo chown pipeline:pipeline /opt/pipeline-agent/run.sh
```

Check `which node` on the box and use that absolute path. If you installed Node
through `nvm`, its path is under `$HOME/.nvm/versions/node/<version>/bin/node`
and it is not on cron's `PATH` — either hardcode it or install a system Node.

Then the crontab, as the `pipeline` user:

```bash
sudo crontab -u pipeline -e
```

```cron
# Weekdays at 08:00. CRON_TZ is honoured by cronie and vixie-cron on most
# distributions; verify with `man 5 crontab` on yours. Without it, the job runs
# in the system timezone (usually UTC).
CRON_TZ=America/New_York

0 8 * * 1-5 /opt/pipeline-agent/run.sh >> /var/log/pipeline-agent.log 2>&1
```

Note `2>&1` — without it, stderr goes to the local mail spool, which on most
modern servers means nowhere. That is how a failing job stays invisible.

Create the log file and let the user write it:

```bash
sudo touch /var/log/pipeline-agent.log
sudo chown pipeline:pipeline /var/log/pipeline-agent.log
```

**Verify the wrapper works under cron's environment, not yours:**

```bash
sudo -u pipeline env -i /opt/pipeline-agent/run.sh
```

`env -i` strips the environment, which is roughly what cron gives you. If it
works there, it will work at 08:00.

Rotate the log, or it grows forever:

```
/var/log/pipeline-agent.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
}
```

If you would rather use systemd timers, the same rules apply — set
`EnvironmentFile=/opt/pipeline-agent/.env` and `WorkingDirectory=` explicitly,
and use `Type=oneshot`.

---

## Render

Render has a native cron service type. [`render.yaml`](../render.yaml) is in the
repo and ready to use:

```yaml
services:
  - type: cron
    name: pipeline-agent
    runtime: docker
    dockerfilePath: ./Dockerfile
    dockerContext: .
    dockerCommand: node runner/run-daily.mjs

    schedule: "0 12 * * 1-5"

    region: oregon

    envVars:
      - key: TENANT
        value: tenant
      - key: STATE_DIR
        value: /app/state
      - key: DRY_RUN
        value: "1"
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: FT_MCP_TOKEN
        sync: false
      - key: HUBSPOT_ACCESS_TOKEN
        sync: false
      - key: SLACK_BOT_TOKEN
        sync: false
```

Push it and create a Blueprint from the repo in the Render dashboard. `sync:
false` means Render prompts you for the value in the dashboard instead of
reading it from git — never put a real secret in this file.

What to know:

- **The command must exit.** Render considers the job done when the process
  exits. `run-daily.mjs` does.
- **Schedules are UTC.** No timezone field, no DST. `0 12` is 08:00 New York in
  summer and 07:00 in winter. Adjust twice a year or accept the drift.
- **There is a maximum runtime of about 12 hours** for a cron job. This run's own
  timeout (`RUN_TIMEOUT_MS`, default 45 minutes) fires long before that, so it
  is not a practical limit here — but if you raise `RUN_TIMEOUT_MS`, keep it well
  under Render's ceiling.
- **Render bills a monthly minimum per cron service.** Check
  <https://render.com/pricing> for the current figure before you create several.
- **State is the problem.** Render's persistent disks attach to web and private
  services; cron jobs do not get one. `STATE_DIR=/app/state` in the blueprint is
  therefore ephemeral, and the [consequence](#what-every-host-needs-to-get-right)
  is real: dedupe and the rework cooldown reset, so people get contacted twice.
  Verify current disk support in Render's docs before you go past a dry run, and
  if there is none, use Railway or a VPS instead.

---

## Fly.io

**Fly has no native cron.** Three options, in the order most people should try
them:

1. **Supercronic inside the container** — a cron implementation built for
   containers: runs in the foreground, logs to stdout, and honours `TZ`. This is
   what [`fly.toml`](../fly.toml) is written for.
2. **Fly's Cron Manager** — Fly's own managed scheduler app. Reasonable if you
   already run one; it is another component to operate.
3. **Scheduled Machines** — set a machine's schedule to an interval bucket
   (hourly, daily, weekly, monthly). Fly's own documentation says this is **not
   for precise timing**: you get "roughly daily", not 08:00. Fine for a job whose
   exact minute does not matter, not fine if you want the digest to land before
   standup.

A fourth option that needs no new dependency at all: run
[`runner/scheduler.mjs`](../runner/scheduler.mjs) as the process command, exactly
as `docker-compose.yml` does. It is already in this repo and does the same job as
supercronic for this one use case.

### Supercronic setup

[`fly.toml`](../fly.toml) is in the repo but **requires a `Dockerfile` change** —
the repo's `Dockerfile` has no supercronic in it and no crontab. Add both in your
fork:

```dockerfile
# --- Fly only: supercronic + a crontab -------------------------------------
# Pin the version and verify the checksum. This binary runs with your CRM
# credentials in its environment; see docs/security.md.
ARG SUPERCRONIC_VERSION=v0.2.29
ARG SUPERCRONIC_SHA1SUM=<checksum published for the release you pin>
ADD --chmod=755 https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64 /usr/local/bin/supercronic
RUN echo "${SUPERCRONIC_SHA1SUM}  /usr/local/bin/supercronic" | sha1sum -c -

COPY crontab /app/crontab
```

And a `crontab` file at the repo root:

```cron
0 8 * * 1-5 node /app/runner/run-daily.mjs
```

Then:

```toml
app = "pipeline-agent"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[processes]
  cron = "/usr/local/bin/supercronic /app/crontab"

[env]
  TENANT = "tenant"
  STATE_DIR = "/data/state"
  TZ = "America/New_York"
  DRY_RUN = "1"

[mounts]
  source = "pipeline_state"
  destination = "/data"
  processes = ["cron"]

[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"
  processes = ["cron"]
```

Deploy:

```bash
fly volumes create pipeline_state --size 1 --region iad
fly secrets set ANTHROPIC_API_KEY=... FT_MCP_TOKEN=... HUBSPOT_ACCESS_TOKEN=...
fly deploy
fly logs
```

What to know:

- **Fly volumes are single-attach.** One volume, one machine. Keep this app at
  `fly scale count 1`. A second machine gets no state, its ledger diverges from
  the first, and the two will draft the same people.
- **The machine must stay awake.** Supercronic only fires while the process is
  running. Do not enable autostop/autosuspend on this app — there is no inbound
  request to wake it, because nothing listens.
- There is no `[http_service]` block and no `[[services]]` block in that file. It
  exposes nothing. Adding a port here would be the only thing that gives this
  deployment an attack surface.

---

## What every host needs to get right

Whatever you pick, four things:

1. **The process must exit.** All of these schedulers assume a job that
   finishes. `run-daily.mjs` exits: `0` on success, `1` on run failure, `2` on
   bad config or missing credentials.

2. **Never let two runs overlap.** The ledger is written at the end of a run, so
   two concurrent runs cannot see each other's work and will draft the same
   people. `scheduler.mjs` refuses to start a second run; Railway skips a
   scheduled run if the previous one is still going; a host crontab does not
   protect you, so use `flock` if you shorten the interval.

3. **`do-not-contact.txt` must survive, separately.** It holds the people who
   asked you to stop, and it lives outside `state/` precisely so that clearing
   run state cannot resurrect them. Mount it into the container
   (`-v ./do-not-contact.txt:/app/do-not-contact.txt:ro`), back it up on its own,
   and never let a volume wipe take it with everything else.

4. **`state/` must survive.** `state/ledger.jsonl` is the only record of who has
   already been worked, and `dedupe.rework_cooldown_days` (default 30) is
   enforced against it. Lose it and the next run has no memory — the same people
   get drafted, and once someone approves those drafts, the same people get
   contacted twice. `state/runs/` is your only record of what the agent did and
   why. Set `STATE_DIR` to an absolute path on durable storage.

5. **Set `DRY_RUN=1` first.** Read the drafts. Then remove it. The runner treats
   only the literal string `1` as on.

---

**Related:** [Deploy on Railway](deploy-railway.md) ·
[Configuration reference](configuration.md) ·
[Safety and compliance](safety-and-compliance.md) · [Security](security.md) ·
[Upgrading](upgrading.md) · [README](../README.md)
