# Deploy on Railway

This is the default path. Railway has a native cron scheduler, a persistent
volume, and a build that reads the `Dockerfile` in this repo without any extra
configuration.

Before you deploy anything, get a green `npm run preflight` and a `npm run dry`
you have actually read locally. See [configuration.md](configuration.md). A
scheduled run is not the place to discover that your list id is wrong.

- [What you get](#what-you-get)
- [What this repo deliberately does not ship](#what-this-repo-deliberately-does-not-ship)
- [Step 1 — create the service from your repo](#step-1--create-the-service-from-your-repo)
- [Step 2 — set variables](#step-2--set-variables)
- [Step 3 — attach the volume](#step-3--attach-the-volume)
- [Step 4 — set the cron schedule and restart policy](#step-4--set-the-cron-schedule-and-restart-policy)
- [Step 5 — verify the first run](#step-5--verify-the-first-run)
- [Going live](#going-live)
- [Deploy buttons and templates](#deploy-buttons-and-templates)
- [Troubleshooting](#troubleshooting)

---

## What you get

One Railway service that wakes up on a schedule, runs `node runner/run-daily.mjs`
once, writes its ledger and run report to a mounted volume, and exits. No port,
no listener, no public URL. Railway will show you the container logs for every
run in the deploy history.

That shape matters: the process **must exit**. Railway skips a scheduled run if
the previous container from the same service is still running. `run-daily.mjs`
exits on its own — it has a hard timeout (`RUN_TIMEOUT_MS`, default 45 minutes)
that kills the agent subprocess and exits non-zero rather than hanging forever.

A persistent deployment on Railway requires a paid plan (Hobby or above). Free
trial credits run out. Current plans and prices are at
<https://railway.com/pricing>.

## What this repo deliberately does not ship

**No `railway.json` or `railway.toml`.** Railway's Config as Code files are
deprecated. Existing files keep working until **2026-12-01**, but *new* services
cannot use them at all — so a config file in this repo would do nothing for
anyone deploying today and would mislead everyone reading it. Configure the
service in the dashboard instead. That is what the steps below do.

**No `.railway/railway.ts`.** The replacement, Infrastructure as Code, is
explicitly experimental and at v0. Its DSL is documented as subject to change.
Shipping a v0 file in a public repo means every fork inherits a breaking change
on someone else's schedule. If you want it, add it in your own fork after
reading Railway's current docs — nothing in this repo depends on it.

The consequence for you: **service configuration lives in the Railway dashboard,
not in git.** Write down what you set, or export it, because your fork will not
reproduce it.

---

## Step 1 — create the service from your repo

This works today, with no template involved.

1. Push your fork to GitHub. Your `config/tenant.yaml`, `voice-pack.md`, `.env`
   and `state/` are gitignored and will not be pushed — that is intentional
   (see [upgrading.md](upgrading.md)), and it means your config has to be
   supplied another way. Two options:
   - **Recommended:** un-ignore *only* `config/tenant.yaml` and `voice-pack.md`
     in a **private** fork, so the build has them. Never do this in a public
     fork, and never un-ignore `.env` or `state/`.
   - Or bake them in a private base image and deploy that instead.

   `do-not-contact.txt` needs the same treatment — see the note in
   [Step 3](#step-3--attach-the-volume). Everything in `.env` stays in Railway's
   Variables, never in git, either way.

2. In Railway: **New Project → Deploy from GitHub repo**, and pick your fork.

3. Railway detects the `Dockerfile` at the repo root (capital `D`, root of the
   source directory) and builds with it. You do not need to select a builder.
   The build runs `npm ci --omit=dev`, so `package-lock.json` must be committed
   and in sync with `package.json`. If the build fails at that step, run
   `npm install` locally and commit the lockfile.

Let this first build finish. It will run once immediately and probably fail on
missing credentials — that is expected, you have not set them yet.

## Step 2 — set variables

Service → **Variables**. Add everything from [`.env.example`](../.env.example)
that applies to you. At minimum:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your API key — **or** `CLAUDE_CODE_OAUTH_TOKEN`, not both |
| `FT_MCP_TOKEN` | outreach platform token |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot private-app token |
| `SLACK_BOT_TOKEN` | optional, `chat:write` only |
| `TENANT` | `tenant` unless you renamed your config file |
| `STATE_DIR` | `/data/state` — see the next step |
| `DRY_RUN` | `1` for your first scheduled runs. Remove it to go live. |

Or from the CLI:

```bash
railway variables --set ANTHROPIC_API_KEY=sk-ant-... --set STATE_DIR=/data/state
```

A note on `CLAUDE_CODE_OAUTH_TOKEN`: it lets you run on an existing Claude
subscription instead of API billing, but subscription usage limits are not
designed for unattended automation. Check your plan terms before using it for a
daily scheduled job.

## Step 3 — attach the volume

Service → **Settings → Volumes → Add Volume**. Mount path: `/data`. Then confirm
`STATE_DIR=/data/state` is set in Variables.

The `Dockerfile` already sets `ENV STATE_DIR=/data/state` and declares
`VOLUME ["/data"]`, so a fresh deploy writes to the right place. The variable is
belt and braces, and it is what `preflight` checks.

**`do-not-contact.txt` needs its own answer.** It is gitignored like your config,
and it deliberately lives *outside* `state/` so that clearing run state cannot
resurrect someone who asked you to stop — which also means the volume does not
cover it. Ship it into the image the same way you ship `config/tenant.yaml`
(private repo, or a private base image), and back it up separately. Losing it
means re-contacting people who have already objected.

**Skip the volume and here is what actually happens.** `state/ledger.jsonl` is the
record of every person the agent has worked, and `dedupe.rework_cooldown_days`
(default 30) is enforced against it. On an ephemeral filesystem that ledger is
destroyed on every deploy and, depending on the platform, between runs. The next
run has no memory, so the same people get drafted again — and once a human
approves those drafts, the same people get contacted twice. The run reports in
`state/runs/` disappear too, which is your only record of what the agent did and
why.

Railway volume constraints worth knowing before you design around them:

- **One volume per service.** You cannot mount two.
- **Volumes are incompatible with replicas.** A service with a volume runs one
  instance. That is fine here — this job must not run concurrently with itself
  anyway.
- **Volumes are mounted at runtime only, not during the build.** Nothing in your
  `Dockerfile` build steps can read or write `/data`. This repo does not try to.
- **Non-root images may need `RAILWAY_RUN_UID=0`.** This `Dockerfile` runs as
  the unprivileged `node` user. It `chown`s `/data` at build time, but the
  volume replaces that directory at runtime, so ownership may not carry over. If
  the run fails with a permission error writing to `/data/state`, set
  `RAILWAY_RUN_UID=0` in Variables and redeploy.

## Step 4 — set the cron schedule and restart policy

Service → **Settings**.

**Cron Schedule.** A standard 5-field expression, for example:

```
0 12 * * 1-5
```

Three constraints that will bite you if you skip them:

- **Schedules are UTC only.** There is no timezone setting and no DST handling.
  `0 12 * * 1-5` is 12:00 UTC every weekday — which is 08:00 in New York during
  daylight time and 07:00 in standard time. Either adjust the expression twice a
  year (spring and autumn) or accept that your run drifts by an hour. Note that
  `client.timezone` in `config/tenant.yaml` is what the *agent* uses to reason
  about "today" and business hours; it does not affect when Railway fires the
  job. Set both.
- **Minimum interval is 5 minutes.** Not a problem for a daily job.
- **Timing is not guaranteed to the minute.** Railway does not promise exact
  execution time. Do not build anything that depends on the run starting at
  precisely 12:00:00.

**Restart Policy: NEVER.** This is not optional on a cron service. `ON_FAILURE`
or `ALWAYS` will restart the container the moment it exits — which for a job
that exits by design means it runs again immediately, in a loop, drafting
outreach at whatever rate the container can cycle. Set it to `NEVER` and let the
cron schedule be the only thing that starts a run.

**Do not set a Healthcheck Path.** This service has no listening port. A
healthcheck would poll a port that will never open, fail, and the deploy would
be marked failed. Leave it empty.

## Step 5 — verify the first run

Trigger a deploy (or wait for the schedule) and open the deploy logs. A healthy
run looks like this:

```
[run] tenant=tenant client="Northwind Analytics" runId=tenant-2026-08-24T12-00-01-234Z
[run] mode=supervised cap=3 dryRun=true
[run] buckets=social-engagers
[run] report=/data/state/runs/tenant-2026-08-24T12-00-01-234Z.json
[run] DRY RUN — the agent will research and draft but create nothing.
[run] mcp servers: outreach, crm
[run]   … 10 tool calls
[run] done in 214s · 47 tool calls
```

Check, in order:

1. **`mcp servers:`** lists `outreach, crm`. If it says
   `none (dry run without credentials)`, your tokens did not reach the container.
2. **`report=`** points at `/data/state/...`, not `/app/state/...`. If it points
   at `/app/state`, `STATE_DIR` is unset and your ledger is on ephemeral disk.
3. **The container exits.** The deploy should complete, not stay running.
4. **A run report exists.** If the last line is
   `WARNING: the agent finished without writing a run report`, the run is
   unverified — the process finished but the agent did not report what it did.
   Treat that as a failure and investigate before removing `DRY_RUN`.

To read a report, either check the Slack digest or run a one-off shell against
the service:

```bash
railway run cat /data/state/runs/<run-id>.json
```

## Going live

Only after you have read the drafts from at least one dry run and would send
them under your own name:

1. Remove `DRY_RUN` from Variables (or set it to `0` — the runner only treats
   the literal string `1` as on).
2. Keep `run_mode: supervised` in `config/tenant.yaml` for the first live week.
   It caps the run at `caps.supervised_run_cap` (default 3) regardless of
   `caps.max_per_day`.
3. Read [safety-and-compliance.md](safety-and-compliance.md) first. It is not
   optional reading — this now sends messages to real people under a real
   person's name.

## Deploy buttons and templates

Railway templates are **authored from a live Railway project**, not declared in
a repo. You build the project, get it working, then publish it with the
dashboard's template composer or `railway templates create`. There is no
template file format and nothing you can commit here to create one. That is why
this repo has no template file — not an omission.

If a template exists for this project, its deploy URL and button image look like
this:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/CODE)
```

`railway.app` URLs 301-redirect to `railway.com`, so old links still work, but
write new ones against `railway.com`.

**The thing template documentation usually leaves out:** a service deployed from
a template deploys from the **template's upstream repo**, not from your fork.
Clicking a deploy button does not fork the code to your GitHub account. You get a
running service pointed at someone else's repository, and your commits go
nowhere near it.

To actually own the code you deployed:

**Service → Settings → Source → Upstream Repo → Eject**

Ejecting creates a repository under your own account and repoints the service at
it. Until you do that, you cannot change a prompt, a play, or the skill — which
is most of the point of this project. If you intend to customize anything (and
you should — the voice pack alone determines draft quality), deploy from your own
GitHub repo per [Step 1](#step-1--create-the-service-from-your-repo) and skip
templates entirely.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Build fails at `npm ci` | `package-lock.json` missing or out of sync with `package.json` | `npm install` locally, commit the lockfile, redeploy |
| `No config at /app/config/tenant.yaml` | Your gitignored config never reached the image | See [Step 1](#step-1--create-the-service-from-your-repo). Also check `TENANT` matches the filename |
| Exit code 2, `Configuration is not valid` | A required config key is blank or still a `<PLACEHOLDER>` | The message lists every problem at once. See [configuration.md](configuration.md) |
| Exit code 2, `Missing required credentials` | A fatal env var is unset in Variables | Note that `FT_MCP_TOKEN` and `HUBSPOT_ACCESS_TOKEN` are only non-fatal when `DRY_RUN=1` |
| `The \`claude\` CLI was not found on PATH` | Dependencies were not installed in the image | The Dockerfile installs them via `npm ci --omit=dev`; check the build log actually ran it |
| Permission denied writing `/data/state` | Volume ownership vs the non-root `node` user | Set `RAILWAY_RUN_UID=0` and redeploy |
| Runs are skipped, deploy shows as still running | Previous run never exited | Check for `Run exceeded RUN_TIMEOUT_MS`. Confirm Restart Policy is `NEVER` |
| The job runs over and over in a loop | Restart Policy is `ON_FAILURE` or `ALWAYS` | Set it to `NEVER` |
| Deploy marked failed, container looks fine | A Healthcheck Path is set on a service with no port | Clear the healthcheck path |
| Same people drafted on consecutive days | Ledger is not persisting | Volume not attached, or `STATE_DIR` not `/data/state`. Check the `report=` path in the logs |
| Run fires an hour early or late twice a year | Railway cron is UTC and does not follow DST | Adjust the cron expression, or accept the drift |
| `report=` shows `/app/state/...` | `STATE_DIR` unset | Set `STATE_DIR=/data/state` in Variables |
| Preflight warns `STATE_DIR is not an absolute path on an ephemeral host` | Relative `STATE_DIR` while `RAILWAY_ENVIRONMENT` is set | Use the absolute `/data/state` |

---

**Related:** [Deploy anywhere else](deploy-other.md) ·
[Configuration reference](configuration.md) ·
[Safety and compliance](safety-and-compliance.md) · [Security](security.md) ·
[Upgrading](upgrading.md) · [README](../README.md)
