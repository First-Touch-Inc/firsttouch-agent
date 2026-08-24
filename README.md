# Pipeline Agent

**A self-hosted sales agent that finds your warmest prospects each morning, writes the outreach, and hands it to a human to approve.**

It sweeps the signals you already have — people engaging with your posts, visitors, cold signups, replies nobody followed up on — researches each person, drafts a personalized sequence in your voice, and puts it in an approval queue. **Anything it writes waits for a human to approve it.**

You run it. Your keys, your infrastructure, your data.

```bash
git clone https://github.com/First-Touch-Inc/firsttouch-pipeline-agent.git
cd firsttouch-pipeline-agent
npm install
cp .env.example .env          # add your keys
claude /setup                 # interviews you, writes your config
npm run preflight             # proves the setup works
npm run dry                   # a full run that creates nothing
```

Read the drafts from `npm run dry`. When you would send them under your own name, schedule it — [Railway](docs/deploy-railway.md), [Docker, Render, Fly, or a VPS](docs/deploy-other.md).

---

## Why this exists

Most "AI SDR" tools are a black box that sends on your behalf and burns your domain. That category earned its reputation.

This is the opposite shape:

- **The agent never writes a message and sends it.** Anything it composes is approval-gated, and no config flag changes that. It *can* enrol qualified people into flows you wrote and published yourself — including flows with automated steps — because you approved that copy when you published it. It cannot author a flow, publish one, or enrol into a flow you did not declare.
- **Warm before cold.** Buckets are worked in warmth order. Cold outbound is the fill of last resort, and it is gated: no researched, dated reason to contact someone means no draft, even if that means a short day.
- **Yours.** Fork it, read every prompt, change anything. The agent's behavior lives in Markdown you can edit, not in a vendor's backend.
- **Small attack surface.** It opens no ports and runs no server. It makes outbound calls and exits. There is nothing here for the internet to reach.

## How it works

```
  schedule ──> runner ──> Claude Code + your skills
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
            your CRM   outreach platform  research
           (read-only)  (creates DRAFTS)   (optional)
                            │
                            ▼
                   approval queue  ── a human approves ──> sent
                            │
                            ▼
                    Slack digest (posted, never listens)
```

The runner is ~200 lines that loads config, checks credentials, and hands off to a headless [Claude Code](https://claude.com/claude-code) session. The judgement lives in [`.claude/skills/pipeline-agent/SKILL.md`](.claude/skills/pipeline-agent/SKILL.md) — plain Markdown, version controlled, yours to edit.

## What you need

| | |
|---|---|
| **Model access** | An Anthropic API key, or an existing Claude subscription via `claude setup-token` |
| **Outreach platform** | [FirstTouch](https://www.firsttouch.com) — executes touches and owns the approval queue |
| **CRM** | HubSpot private-app token |
| **Slack** *(optional)* | A bot token with `chat:write` for the daily digest |

Other providers need an adapter — see [docs/providers.md](docs/providers.md). The config declares which you use, so an unimplemented one fails at preflight with a clear message instead of half-working.

## Configuration

Two files, both gitignored, both written for you by `claude /setup`:

- **[`config/tenant.yaml`](config/tenant.example.yaml)** — buckets, caps, ICP, ownership, suppression
- **`voice-pack.md`** — your positioning, proof points and voice. The biggest lever on draft quality.

Keeping them untracked is deliberate: it means `git pull upstream main` never conflicts with your customization. See [docs/upgrading.md](docs/upgrading.md).

There are no silent defaults for anything tenant-specific. A missing owner id or a placeholder list id fails loudly at startup, because the alternative is sending real outreach to the wrong list from the wrong person's account.

## Safety

This drafts messages to real people, to be sent under a real person's name. Read **[docs/safety-and-compliance.md](docs/safety-and-compliance.md)** before you go live.

The gate is enforced in code, not asked for in a prompt. [`.claude/hooks/guard-send.mjs`](.claude/hooks/guard-send.mjs) blocks any tool that would deliver a message directly, any agent-composed action created without human approval required, and any action created without an explicit sender — an action with no owner sends from whichever account the API token belongs to, and that cannot be undone.

It draws one deliberate line. **Composing is gated; enrolling is not.** A message the agent wrote is text no human has read, so it waits for approval. A flow is copy you wrote and published, so the agent may put a qualified person into it without re-approving your own words — but only into flows you list in `flows:`, and it may never create or publish one. That moves the human review earlier rather than removing it, which makes qualification and suppression the load-bearing checks on that path. Both halves are covered by tests.

Defaults are conservative on purpose: supervised mode, a cap of 3, dry run on. Turn them up deliberately, after reading the output.

**On platform terms — read this before automating social channels.** LinkedIn's User Agreement (§8.2) prohibits using bots or automated methods to send messages or add contacts, and prohibits sharing login credentials with third-party tools. LinkedIn enforces this: it restricts accounts, does not disclose its reasons, and has taken action against automation vendors and their staff. Restrictions land on the **individual's account**, not on this software.

Nothing here is "ToS-safe", and this project does not claim to make you compliant with anything. You are the sender, and in data-protection terms you are the controller. The compliance doc explains what that means in practice, including CAN-SPAM's requirements and why the defaults do **not** make you compliant in the EU, the UK, or Canada.

## Documentation

| | |
|---|---|
| [Configuration reference](docs/configuration.md) | Every key, and the CRM scopes you need |
| [Deploy on Railway](docs/deploy-railway.md) | The default path |
| [Deploy anywhere else](docs/deploy-other.md) | Docker, Render, Fly, VPS |
| [Safety and compliance](docs/safety-and-compliance.md) | Read before going live |
| [Security](docs/security.md) | Threat model and what this does not expose |
| [Adding a provider](docs/providers.md) | Wire up a different CRM or platform |
| [Upgrading](docs/upgrading.md) | Pull engine updates without losing your config |

## License

MIT. See [LICENSE](LICENSE).
