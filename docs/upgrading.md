# Upgrading

This engine ships as a **versioned container image**, and a deployment is a
thin overlay on top of it. You upgrade by bumping the version you pin — never by
forking the engine to customize it.

- [The overlay model](#the-overlay-model)
- [What survives an upgrade](#what-survives-an-upgrade)
- [Upgrading](#upgrading)
- [Never fork the engine](#never-fork-the-engine)

---

## The overlay model

The public engine is published as a versioned image to GHCR:

```
ghcr.io/first-touch-inc/firsttouch-agent:X.Y
```

A deployment is its own small image that **pins** a version of the engine and
adds only what is deployment-specific:

```dockerfile
FROM ghcr.io/first-touch-inc/firsttouch-agent:X.Y
# your private adapters, baked into the image (never onto the volume) —
# EXTRA_ADAPTERS_DIR points here; see docs/providers.md
COPY adapters/ /opt/adapters/
ENV EXTRA_ADAPTERS_DIR=/opt/adapters
```

Everything else — your `config/agent.yaml`, plays, voice pack — lives on the
`/data` volume, written during onboarding, not baked into any image. So a
deployment is three cleanly separated layers: the pinned **engine** (upstream,
read-only in the image), your private **adapters** (in your overlay image), and
your **configuration and state** (on the volume).

## What survives an upgrade

The `/data` volume is untouched by an image swap, so everything on it carries
across an upgrade unchanged:

- `config/agent.yaml` and your plays
- the voice pack and the lessons distilled from your edits
- the SQLite **ledger** — identity, suppression seed, caps, decisions, durable
  undo intents, lessons

That is the whole point of the volume/image split: the engine is disposable and
replaceable; the agent's world is durable.

## Upgrading

Bump the pin deliberately and redeploy:

```bash
# in your overlay Dockerfile
FROM ghcr.io/first-touch-inc/firsttouch-agent:X.Z
```

```bash
docker build -t your-agent:latest .
# then redeploy the image on your host (Railway/Fly/Render/Docker)
```

Because config and the ledger live on `/data`, the new host boots against your
existing world. If a new engine version requires a new config key, the loader
fails **loudly** at startup with no silent default — read the message, add the
key (using [`config/agent.example.yaml`](../config/agent.example.yaml) as the
reference), and redeploy. A loud failure before anyone is contacted is the
design; a plausible fallback that quietly works the wrong list is what it
avoids.

Pin to a specific `X.Y` rather than a moving tag, so an upgrade is a change you
make on purpose and can roll back by re-pinning the previous version.

## Never fork the engine

The guard, the tool server, and the approval loop live in the engine image,
root-owned and read-only to the agent's runtime user — that filesystem fact is
what makes "can reprogram its own plays, cannot weaken its guardrails" true.
Forking the engine to customize it throws that away and puts you on a manual
merge with every upstream safety fix. You do not need to:

- **Behaviour** — plays (Markdown in `/data/config/plays/`) and the voice pack.
- **Integrations** — private adapters via `EXTRA_ADAPTERS_DIR`, baked into your
  overlay image (see [providers.md](providers.md)).
- **What it does** — the config file, maintained by validated writes.

If you genuinely improved the engine itself — a bug fix, a new first-class
adapter — send it upstream so you stop carrying it.

---

**Related:** [Configuration reference](configuration.md) ·
[Providers](providers.md) · [Deploy on Railway](deploy-railway.md) ·
[Deploy anywhere else](deploy-other.md) · [README](../README.md)
