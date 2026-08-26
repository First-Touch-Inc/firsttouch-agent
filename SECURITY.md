# Security

## Reporting a vulnerability

Please report security issues privately to **security@firsttouch.com**, or via
GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. Do not open a public issue for a vulnerability.

Please include what you found, how to reproduce it, and what an attacker could
do with it. We will acknowledge within three business days.

## What this deployment exposes

Deliberately, nothing. The host **binds no port, exposes no HTTP endpoint,
receives no webhooks, and serves no dashboard.** It dials OUT to Slack over a
WebSocket (Socket Mode), so there is nothing routable to your deployment — and
a speaker's identity comes from Slack's authenticated envelope, not from a
request body, which is what makes the operator allowlist meaningful.

## The trust model, stated plainly

The agent is a full Claude Code session: it runs commands, edits this repo,
and can read its own environment, including the credentials you gave it. The
machine or container it runs on is **the agent's computer** — size what you
hand it accordingly:

- Give it its **own FirstTouch seat**, not a human's.
- Scope the **HubSpot token** to the objects and verbs you actually want it
  using; leave write scopes off until you want writes.
- The Slack tokens are held by the host and stripped from the session's
  environment — the agent works in the repo; the host owns the Slack surface.

What the agent must NOT be able to do is not left to trust:
[`.claude/hooks/guard-send.mjs`](.claude/hooks/guard-send.mjs) runs on every
MCP tool call, in scheduled runs and chat alike, and denies direct sends,
un-approved or un-owned outreach actions, self-approval, email sending, and
flow authoring. It matches bare tool names (rename-proof), fails closed on
anything unparseable, and its tests are a release gate.

## Prospect and operator data

`state/` holds the operator binding, thread→session pairings, and images the
operator uploads. `workspace/` holds what the agent writes about prospects.
Both can contain real personal data — treat them like a CRM export, back them
up accordingly, and delete on request. `state/` is gitignored, and CI fails
any commit that tracks a `.env`, a token file, or anything under `state/`.

## Prompt injection

The agent reads text written by people who are not you — bios, websites, CRM
notes, and anything inside an image the operator forwards. That text can carry
instructions aimed at the model. The primary mitigation is structural rather
than clever: **the agent cannot put a message in front of a person.** Anything
it composes waits in FirstTouch for a human, so the worst realistic outcome on
that path is a bad draft someone rejects. The house rules additionally tell it
to treat all third-party text as data, never instructions — but the guard, not
the telling, is the control.
