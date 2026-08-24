# Your plays

Drop a Markdown file in this directory to add a play the engine never shipped.
Point your config at the directory:

```yaml
extra_plays: "config/plays"
```

Then bind a bucket to it by `id`:

```yaml
buckets:
  - id: post-demo-followup
    enabled: true
    priority: 2
    daily_cap: 5
    source:
      type: crm.list
      list_id: "12345"
    play: post-demo-followup     # matches the play's id below
```

`npm run preflight` tells you how many custom plays it loaded. If it says zero
when you expected one, the path is wrong — that is the whole reason this check
exists.

**Everything in this directory except this README is gitignored.** That is
deliberate: your plays are yours, and keeping them untracked is what lets you
`git pull upstream main` forever without a merge conflict. Back them up
somewhere, or commit them to your own private fork on a branch you control.

## What a play is, and is not

A play answers: **when does this fire, what is the hook, what research does it
need, what shape is the message, and what disqualifies someone.**

A play does **not** get to decide who the message sends as, whether it needs
approval, or whether suppression runs. Those are engine concerns, enforced in
code — `.claude/hooks/guard-send.mjs` blocks a send regardless of what any play
file says. A play you write cannot make the agent less safe. It also cannot make
it faster by skipping a check, so do not try.

## The format

Plain Markdown with a small YAML frontmatter block:

```markdown
---
id: post-demo-followup
description: Recap and next step after a demo where nobody followed up.
entities: [contact]
---

## Fires when

The demo happened more than 3 days ago, the contact is on the source list, and
no human has emailed or called them since.

## The hook

What was actually discussed on the call. Pull it from the CRM activity timeline
or the meeting notes. If there is no record of what was said, there is no hook —
disqualify rather than writing "great chatting".

## Research needed

- The meeting note or call summary, for one specific thing they said.
- Whether anyone from the team has touched the account since.
- The open deal, if there is one, and its stage.

## Message shape

1. One clause referencing the specific thing they raised on the call.
2. The answer, or the thing you promised to send. Lead with the useful part.
3. One low-friction next step. Not "let me know your thoughts".

Keep it under the word caps in the voice pack. Shorter than a cold email —
you have already met.

## Disqualify

- No record of what was discussed.
- Someone from the team already followed up.
- The deal is closed-lost with a reason that has not changed.
- They asked not to be contacted, ever, for any reason.
```

## Rules that will save you

**Write the disqualify section first.** It is the part that keeps the agent
honest, and the part people skip. A play with a vague hook and no disqualifiers
produces confident, generic outreach — the exact thing that gets a domain
filtered and an account restricted.

**Never put a real person, list id, or customer name in a play file.** Those
belong in the config, and plays get shared between teammates.

**Test it with `npm run dry` before scheduling it.** Read the drafts. Ask
whether you would send that to that person, under your own name.
