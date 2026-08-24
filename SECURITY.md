# Security

## Reporting a vulnerability

Please report security issues privately to **security@firsttouch.com**, or via
GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. Do not open a public issue for a vulnerability.

Please include what you found, how to reproduce it, and what an attacker could
do with it. We will acknowledge within three business days.

## What this deployment exposes

Deliberately, nothing.

This agent runs as a scheduled job that starts, makes outbound calls, and exits.
It **listens on no port, exposes no HTTP endpoint, receives no webhooks, and
serves no dashboard.** There is no inbound surface to authenticate, and
therefore no unauthenticated endpoint to find. If you ever add a listener, you
are taking on an authentication problem this design does not currently have —
read [docs/security.md](docs/security.md) before you do.

## Your credentials

Every credential lives in the environment. `.env` is gitignored, and CI fails
the build if a `.env`, a token file, or anything under `state/` is ever tracked.

Scope tokens to the minimum that works. The CRM token in particular should be
read-only unless you have deliberately enabled CRM writes — the bundled CRM
adapter refuses to write at all unless `CRM_WRITES_ENABLED=1`.

## Prospect data

`state/` contains real personal data about real people: names, employers,
profile URLs, and the drafts written about them. It is gitignored. Treat that
directory the way you would treat a CRM export, back it up accordingly, and
delete from it when someone asks you to. See
[docs/safety-and-compliance.md](docs/safety-and-compliance.md).

## Prompt injection

The agent reads text written by people who are not you — profile bios, company
websites, CRM notes. That text can contain instructions aimed at the model.

The primary mitigation is structural rather than clever: **the agent cannot write
a message and send it.** Anything it composes waits for a human, so the worst
realistic outcome on that path is a bad draft someone rejects.

The flow-enrolment path is the exception worth understanding. Injected text
cannot change what gets *said* there — the copy is yours and was published before
the run — but it could influence *who* gets enrolled. That is why enrolment is
limited to flows you declare in `flows:`, why the agent may never author or
publish a flow, and why suppression and qualification carry more weight on that
path than on the drafting path. Keep the flow list short and specific.
