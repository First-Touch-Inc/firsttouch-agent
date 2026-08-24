# Upgrading

How a fork pulls engine updates without losing its customization.

- [Why this works](#why-this-works)
- [One-time setup](#one-time-setup)
- [The upgrade](#the-upgrade)
- [When an upgrade adds a required config key](#when-an-upgrade-adds-a-required-config-key)
- [Diffing the config template between versions](#diffing-the-config-template-between-versions)
- [If you deployed from a Railway template](#if-you-deployed-from-a-railway-template)
- [Always re-run preflight and a dry run](#always-re-run-preflight-and-a-dry-run)
- [If you did modify the engine](#if-you-did-modify-the-engine)

---

## Why this works

The design decision that makes upgrades painless is in
[`.gitignore`](../.gitignore): **your configuration is not tracked.**

```
config/tenant.yaml
config/*.local.yaml
voice-pack.md
do-not-contact.txt
state/
.env
```

What is tracked is `config/tenant.example.yaml`, `voice-pack.example.md` and
`do-not-contact.example.txt` — the templates. Your copies are untracked working
files that git does not know about and therefore never tries to merge.

So the split is clean:

| Yours, untracked | Upstream's, tracked |
|---|---|
| `config/tenant.yaml` | `runner/**` |
| `voice-pack.md` | `.claude/skills/**` |
| `do-not-contact.txt` | `.claude/commands/**` |
| `.env` | the `*.example.*` templates |
| `state/**` | `Dockerfile`, `docker-compose.yml`, `docs/**` |

`git pull upstream main` touches only the right-hand column. Nothing in the left
column is in the index, so there is nothing to conflict.

This is also why [`/setup`](../.claude/commands/setup.md) is instructed not to
edit anything in `.claude/skills/` or `runner/`, and why customizing the agent's
behaviour is meant to happen through `voice-pack.md` and `config/tenant.yaml`
rather than by editing the skill. Every engine file you edit is a merge conflict
you have chosen to own.

## One-time setup

If you cloned directly rather than forking through GitHub, add upstream as a
second remote:

```bash
git remote add upstream https://github.com/First-Touch-Inc/firsttouch-pipeline-agent.git
git remote -v
```

You should see `origin` (yours) and `upstream` (ours). If you forked on GitHub,
`origin` is your fork and you still need to add `upstream` — a GitHub fork does
not create the remote in your local clone.

## The upgrade

```bash
# 1. Know what you have, and be on a clean tree.
git status
git rev-parse --short HEAD

# 2. Fetch and look before you pull.
git fetch upstream
git log --oneline HEAD..upstream/main

# 3. See exactly which tracked files change.
git diff --stat HEAD upstream/main

# 4. Pull.
git pull upstream main

# 5. Dependencies may have moved.
npm install
```

`npm install` rather than `npm ci` here, because `package-lock.json` may need to
be regenerated locally — then commit the updated lockfile so your Docker builds,
which use `npm ci --omit=dev`, keep working.

**Read the diff before step 4, not after.** Two paths deserve real attention:

- **`.claude/skills/pipeline-agent/SKILL.md` and `plays.md`.** This is the
  agent's judgement — who gets contacted, what counts as a reason, how drafts are
  routed and owner-verified. It is Markdown, so it reads like prose, and it is as
  consequential as any code in the repo. Read it the way you would read a diff to
  a payment path.
- **`.claude/settings.json` and `.claude/hooks/guard-send.mjs`.** The send guard
  is what makes "anything the agent writes waits for approval" a control rather than a
  promise. It is committed precisely so that changes to it are a reviewable
  diff. A diff that weakens it is the most consequential change this repo can
  receive — read it carefully, and never resolve a conflict here by keeping
  whichever side is shorter. See
  [security.md](security.md#the-send-guard).
- **`config/tenant.example.yaml`.** New keys appear here first. See
  [below](#diffing-the-config-template-between-versions).

If your tree is not clean, stash first (`git stash`) — but note that your config
and voice pack are untracked, so they are not what `git status` is complaining
about. Anything dirty is an engine file you edited; see
[the last section](#if-you-did-modify-the-engine).

## When an upgrade adds a required config key

This is the case worth understanding, because the failure is deliberate.

Your `config/tenant.yaml` was written against an older
`config/tenant.example.yaml`. If an upgrade adds a key that
`runner/lib/config.mjs` requires, your config does not have it — and the loader
has **no silent defaults for anything tenant-specific**, by design. So the next
run does not start:

```
Configuration is not valid:

  - providers.crm.customer_signal needs at least one entry with a real CRM
    property name. This is how the agent recognises an existing customer so it
    never prospects one. There is no safe default — it must be a property from
    YOUR CRM.

Run `npm run preflight` for the full picture.
```

Exit code `2`. Nothing ran. Nobody was contacted.

**That loud failure is the discovery mechanism.** The alternative — a plausible
fallback value — is how a misconfigured run silently works the wrong list, or
sends from the wrong person's account. `ConfigError` lists *every* problem it
finds rather than stopping at the first, so one `npm run preflight` gives you the
whole list to fix in a single pass.

The fix is always the same:

```bash
npm run preflight
```

Read what it says, add the key to `config/tenant.yaml` using
`config/tenant.example.yaml` as the reference for shape and comments, and re-run
until green.

**Do this before the next scheduled run fires**, not after. On a scheduled
deployment, a config error means the job exits 2 every morning — visible in your
platform's logs, invisible everywhere else. There is no digest, because the run
never got far enough to post one. A silent morning is the symptom.

## Diffing the config template between versions

The template is tracked, so git can tell you exactly what changed in it:

```bash
# What changed in the config template since the commit you were on.
git diff <old-sha>..<new-sha> -- config/tenant.example.yaml

# Or against upstream before you pull.
git fetch upstream
git diff HEAD..upstream/main -- config/tenant.example.yaml

# Same question for the voice pack template.
git diff HEAD..upstream/main -- voice-pack.example.md

# And for the agent's behaviour.
git diff HEAD..upstream/main -- .claude/skills/
```

If you tag your deploys, `<old-sha>` is a tag name. If you do not, the commit
you were on is in your platform's deploy history — Railway shows the deployed
commit on each deployment.

The example file's comments are part of the documentation. When a new key
appears, the comment above it usually explains the consequence of getting it
wrong; that is worth reading rather than just copying the key across.

To compare against your own config side by side:

```bash
diff -u config/tenant.example.yaml config/tenant.yaml | less
```

Expect noise — your real values differ from the placeholders, and you have
probably disabled buckets you do not use. You are looking for *keys present in
the template and absent in yours*, not for value differences.

## If you deployed from a Railway template

A service created from a Railway template deploys from the **template's upstream
repo**, not from your fork. Pulling upstream into your local clone changes
nothing about what that service runs, and pushing to your fork does not deploy.

To get control of the code:

**Service → Settings → Source → Upstream Repo → Eject**

That creates a repository under your account and repoints the service at it.
Until then you cannot ship a change to the skill, the plays, or the runner — and
you also cannot control *when* an upstream change reaches your deployment.

After ejecting, add `upstream` as described in
[One-time setup](#one-time-setup) and upgrade normally. Full detail in
[deploy-railway.md](deploy-railway.md#deploy-buttons-and-templates).

## Always re-run preflight and a dry run

Every upgrade. No exceptions, and in this order:

```bash
npm run preflight
npm run dry
```

`npm run preflight` validates the config against the new loader, confirms every
credential is present, and makes one cheap read-only call to each connected
service to prove the tokens still work. It creates nothing. Add `--offline` to
skip the network checks if you are somewhere without connectivity.

`npm run dry` is a complete run — it sweeps buckets, researches, qualifies and
drafts — but creates nothing in the outreach platform or the CRM and posts no
digest. It writes what it *would* have created into the run report:

```bash
ls -t state/runs/ | head -1
```

**Read the drafts.** This is the point of the exercise. An upgrade that changes
`SKILL.md` or `plays.md` changes how the agent judges who to write to and what to
say, and the only way to know whether you like the new behaviour is to look at
its output. The question is the same one from `/setup`: would you send this,
under your own name, to this person?

If the answer is no, the fix is usually `voice-pack.md`, not the engine.

Then deploy. Keep `run_mode: supervised` for the first live run after a
significant upgrade — it caps the run at `caps.supervised_run_cap` (default 3),
which is few enough to read every draft.

## If you did modify the engine

Sometimes you have to. If you edited `runner/`, `.claude/skills/`, or the
`Dockerfile`, upgrades stop being free — but they stay manageable if you keep
your changes legible.

- **Keep engine changes on their own commits**, separate from anything else, with
  messages that say why. When a pull conflicts, you want to be able to read your
  own intent.
- **Prefer rebase over merge** so your changes stay on top and stay identifiable:
  ```bash
  git fetch upstream
  git rebase upstream/main
  ```
- **Resolve conflicts by re-applying your intent to the new upstream code**, not
  by keeping your old version. Upstream changed that file for a reason, and in
  this repo the reason is often a safety property — the owner-verification step,
  a suppression check, the reason gate. Losing one of those in a conflict
  resolution is a real risk, and the failure is silent.
- **Consider whether the change belongs upstream.** If you fixed a bug or added a
  provider adapter, a pull request means you stop carrying it. See
  [providers.md](providers.md) for the adapter path.
- After any conflicted upgrade, re-run preflight and a dry run and read the
  output twice. This is exactly the case where behaviour drifts quietly.

---

**Related:** [Configuration reference](configuration.md) ·
[Deploy on Railway](deploy-railway.md) · [Deploy anywhere else](deploy-other.md)
· [Safety and compliance](safety-and-compliance.md) · [Security](security.md) ·
[README](../README.md)
