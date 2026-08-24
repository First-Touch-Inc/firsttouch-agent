---
description: Interview the operator and generate their tenant config, voice pack and .env, then validate the whole setup end to end.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# /setup — get this repo running for THIS team

You are onboarding someone who just forked this repo. They may be technical or
not. Your job is to end the session with a working, validated configuration —
not a document describing one.

By the end they should have:

1. `config/tenant.yaml` — their real configuration
2. `voice-pack.md` — their positioning and voice
3. `.env` — their credentials (or a precise list of what they still need to get)
4. A green `npm run preflight`
5. A `npm run dry` they have actually read the output of

## How to run the interview

**Ask one thing at a time.** Do not paste a 12-question form. Wait for each
answer and let it inform the next question.

**Look before you ask.** If a credential is already in the environment, if
`config/tenant.yaml` already exists, or if the CRM is reachable, find that out
first and confirm rather than interrogate. Re-running `/setup` on a configured
repo should be a short conversation about what to change.

**Never ask them to paste a secret into the chat.** When you need a token, tell
them exactly where to get it and have them put it in `.env` themselves. If you
can read it from the environment to verify it works, do that instead.

**Default aggressively, and say what you defaulted.** Most answers have a sane
default. Offer it and move on: "I'll start you on supervised mode with a cap of
3 — say the word if you want something else."

## What you need to find out

Work through these in order. Stop and write files as you go, so a session that
gets interrupted leaves real progress behind.

### 1. Who they are

Team or company name, timezone, and who the outreach sends AS. Get the sender's
full name. You will need their user id in the outreach platform — if the
platform MCP is connected, look it up rather than asking.

### 2. Who they sell to

Their ICP, in their words. Push for specifics, especially exclusions: "who is
technically a fit but never buys?" That answer does more work in the config than
the inclusion criteria do. Write it into `icp:` as prose, not as a bulleted
schema — it is read by a model, not parsed.

### 3. What signals they already have

This is the most important question in the interview, so spend time on it. Ask
what warm signals exist today:

- People engaging with their posts or their company page
- Website visitors they can identify
- Signups or trials that went cold
- People who replied to an email and never heard back
- Closed-lost from more than six months ago

Enable a bucket for each real signal they have, in warmth order. If they have
none, say so plainly: the agent will be doing cold outbound, that is the hardest
mode, and the reason gate will drop a lot of accounts. Do not enable
`target-accounts` as the only bucket without telling them that.

For every bucket backed by a CRM list, get the real list id. If the platform MCP
is connected, offer to list their lists so they can pick by name instead of
hunting for an id. **A bucket whose `list_id` is still a placeholder must be left
`enabled: false`** — a wrong list id means working the wrong humans.

### 4. Volume and mode

Start everyone on `run_mode: supervised` with a cap of 3 unless they push back.
Explain why in one sentence: the first runs exist to be read, not to produce
volume. Tell them how to move to `daily` later.

### 5. The customer-suppression signal

Ask which CRM property tells them an account is already a customer — a plan
tier, a seat count, a lifecycle stage. Fill in `providers.crm.customer_signal`.

Do not skip this and do not guess a property name. The failure it prevents is
prospecting your own paying customers, which is the most embarrassing thing this
system can do. If they genuinely do not know, help them find it by listing
company properties from the CRM.

### 6. Voice

Copy `voice-pack.example.md` to `voice-pack.md` and fill in as much as you can
from what they have told you and from their website, which you should read.

Ask for real proof points, and be firm about this: only claims they can actually
back. If they offer a metric, ask where it came from. An invented customer
result in a cold email is a lie sent under a real person's name.

### 7. Credentials

Walk them through `.env`. For each one, tell them where to get it:

- Model access — an Anthropic API key from the console, or `claude setup-token`
  to use an existing Claude subscription. One or the other, not both.
- Outreach platform token
- CRM private-app token, with the scopes from `docs/configuration.md`
- Slack bot token, if they want the digest. Only `chat:write` is needed.

Leave the optional enrichment keys blank unless they already have them.

## Then validate — this is not optional

Never end the session on "you're all set" without proving it.

1. Run `npm run preflight`. Fix what it reports. Re-run until it is green or the
   only remaining items are warnings they have consciously accepted.
2. Run `npm run dry`. This researches and drafts without creating anything.
3. **Read the drafts with them.** Open the run report from `state/runs/`. Ask
   directly: would you send this, under your own name, to this person? If the
   answer is no, that is a voice-pack problem — fix `voice-pack.md` and run the
   dry run again. Iterating here is the whole point of the dry run, and it is
   much cheaper than iterating in someone's inbox.
4. Only once the drafts are good, explain how to schedule it (see
   `docs/deploy-railway.md`) and that the first scheduled runs should stay in
   supervised mode.

## Rules

- Write real values, never placeholders. If you do not know something, ask —
  never invent a list id, a user id, or a property name.
- Config only. Do not edit anything in `.claude/skills/` or `runner/`; those are
  the engine, and keeping them untouched is what lets this fork pull upstream
  updates cleanly.
- Never put a secret in `config/tenant.yaml`. Secrets live in `.env`.
- If they ask for something the repo cannot do, say so plainly and point at
  `docs/providers.md` rather than half-configuring it.
- Tell them what you changed at the end, file by file.
