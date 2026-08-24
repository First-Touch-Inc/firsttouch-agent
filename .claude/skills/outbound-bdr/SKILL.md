---
name: outbound-bdr
description: The cold-outbound engine. Given a target account (or a list of them), researches the company for a real, dated buying signal, finds the decision-makers one canonical role at a time, verifies each is current in role, applies the reason gate that drops accounts with nothing to say, and drafts a value-first email plus social sequence as approval-gated actions. Invoked by the pipeline-agent orchestrator for the target-accounts bucket, and usable directly when someone asks to research an account, find the buyer at a company, or draft cold outreach. It drafts and queues; it never sends.
---

# Outbound BDR engine

## Mission

Take what the tenant genuinely knows and bring real value to each prospect:
understand their problem, anticipate what they are about to hit, and help.
Replies and meetings are the byproduct, never the goal.

Operationally: research the account, find the buyer, and — **if and only if the
research produced a reason** — write a value-first email and social sequence that
leads with a genuinely useful idea. The product is the soft landing. Everything
lands in the approval queue as a human-approval task.

Out of scope: working deals that already exist, and anything that sends.

Configuration comes from `config/tenant.yaml`; voice, positioning, proof points
and word caps come from the tenant's voice pack (`voice_pack`).

---

## Inputs

- A target-account source — a CRM company list id, a set of domains, or a single
  company handed over by the orchestrator.
- The tenant's ICP statement and buyer titles from the config.
- The voice pack, plus `state/lessons.md` if the tenant has accumulated
  corrections. Lessons override the voice pack.

Track progress on the account itself, using a CRM property such as lead status:
skip accounts already marked in-progress, already an open deal, or already
disqualified, and mark each account as you finish it. That property is the
where-we-left-off marker across runs.

---

## Step 1 — Signal research (free before paid)

For each account, do the free research first. Never pay to enrich a company you
have not yet found a reason to write to.

Look for, roughly in order of how hard they punch:

| Signal | Where it comes from | Why it works |
|---|---|---|
| **New in role** — a target leader started recently (under ~6 months) | Contact enrichment: the start date on their current position, plus web | They are rebuilding their stack right now. Strongest trigger, and it works even for people who never post. |
| **Runs a competing or adjacent tool** | Named in their own job postings; review sites; their site | Confirms fit and hands you the exact gap to name. |
| **Live advertising** | An ad-library research API if one is configured, else web search | Reference what they actually run. Only ever cite a headline or number you truly retrieved. |
| **Hiring for the function you sell into** | Job boards, careers page, web search | Team is scaling; the problem is about to get louder. |
| **Funding or headcount movement** in the last ~6 months | Company enrichment plus web | Budget and change. |
| **Audience or engagement size** — a large following, or a post with real traction | Enrichment payload; a post-reactions API if configured | Their buyers are already paying attention somewhere the CRM cannot see. |

**Honest notes about these data sources:**
- Post-level research providers are the least reliable link in this chain.
  Several only return data for profiles already in their own index and simply
  404 for everyone else, and live-scrape tiers are often a separate paid add-on.
  Assume post discovery will be empty for most senior buyers — they rarely post.
  Design the play so the follower/audience number is the workhorse and real post
  traction is a bonus.
- An ad-library lookup runs on a third party's infrastructure against public
  data, so it carries no risk to the tenant's own social account. Verify the
  returned advertiser is actually the target before using anything from it —
  company names collide.
- Any of these missing means **fall back to web search**, not "skip the account".
  A missing provider is not the same as a missing signal.

Record the signal, its **source**, and its **date**. If you cannot state all
three, you do not have a signal.

## Step 2 — The reason gate (the step people delete and regret)

**No reason found = do not draft. Drop the account and move on.**

A reason is a fact about *them*, sourced and dated, from the table above, or
genuine prior history with the tenant (an old thread, a past signup, an owned
account, a real first-degree connection).

**Banned as a reason:**
- An analogy between what they sell and what the tenant sells. "Their pitch is
  about removing operational overhead, which is the same argument we make" is a
  copy hook, not a reason to write to someone.
- Their stage, their headcount, their funding round in the abstract.
- Anything that only restates their marketing site.
- Being on the list.

If the run needs volume and the gate keeps firing, the run ends short. Report the
number of accounts researched and dropped for no-reason. **A short day beats a
manufactured one.** The daily floor is a target, not a licence to invent a why.

## Step 3 — Decision-maker discovery, one canonical role per call

People-search backends wrap providers whose title matching has two hard limits,
and both bite:

- A multi-title OR list matches titles **exactly**, so it silently drops anyone
  whose real title is a phrasing variant ("VP of Sales" versus "VP Sales"), and
  the query starts failing outright once the title list gets long.
- A **single** title fuzzy-matches its own variants, so one clean title finds all
  the phrasings by itself.

Therefore:

1. **One canonical role per discovery call.** Never a multi-title basket. Run the
   call per role and merge the results, deduping on profile URL.
2. **Filter by company domain plus role title.** Do not filter by company name
   alone, and do not page a whole roster.
3. **Decision-makers only.** Never the individual contributors who would merely
   use the product — they are users, not buyers. If a leader search returns zero,
   go UP to founder or CEO. Never fall back down the org chart.
4. **Cover the account with a handful of canonical leader roles**, one call each,
   drawn from the buyer titles in the tenant's ICP config.
5. **Use the free count call first** where the platform offers one, to size the
   result before paying for the full discovery.
6. A zero result may be genuine. Retry once with alternate title phrasing, then
   move on.

## Step 4 — Verify and enrich

- **Verify CURRENT.** Discovery indexes carry stale roles — people who left
  months ago. Confirm the enriched profile's current position has no end date
  before you write anything or queue anything.
- Look up an email address only for the people you will actually write to, and
  only when the plan contains an email step.
- **Always capture and pass the verified profile URL** into whatever creates the
  outreach. If you leave it blank, enrollment-time enrichment will try to guess
  the profile from the name and email, and it does sometimes attach the wrong
  human — which means the connection request and every DM target a stranger.
  Passing the verified URL is the cheapest bug prevention in this system.
- Respect the run's credit ceiling: stop opening NEW contacts once it is
  reached, and finish the one in progress.

## Step 5 — Draft

Structure, word caps, CTA wording and proof points all come from the voice pack.
The rules this engine adds:

- **Lead the first email and the first direct message with the SAME single
  sharpest signal.** Never stack signals. One hook, stated once.
- Say the problem **once**. The most common overrun is explaining it in the
  signal beat and again in the idea beat.
- Cite only numbers you actually retrieved. Never invent engagement, ad spend,
  impressions, or follower counts.
- Vary the angle across contacts and across the steps in a sequence, so a company
  that gets multi-threaded does not receive the same email three times with
  different names on it.
- Multi-thread the fitting decision-makers at an account you have already
  researched — but every contact you write counts toward the run's cap.

## Step 6 — Queue as approval-gated actions

Hand the drafts back to the orchestrator's routing step, or, when running
standalone, create the actions directly under the same rules:

- Run the platform's action preflight, and set the human-approval flag
  explicitly on every email, message, connect-with-note and call step.
- **Assign the action to the intended owner** — pass their `provider_user_id`
  as both the owner and the assigned-user field — and **verify the created task's
  owner before reporting it as queued.** An enrollment's owner cannot be changed
  after creation; a mis-assigned task must be removed and redrafted.
- Order the steps by connection status, per `sequence_defaults`: lead with the
  DM when the sender is already connected, lead with email when they are not,
  and never send a connection request to an existing connection.
- Before spending research credit on any discovered contact, check whether the
  platform already has them in an enrollment. A cold list has no memory of who
  previous runs already queued.

## Guardrails

- **Draft and approve, with no exceptions.** Nothing sends. Every prospect-facing
  step is approval-gated, including a bare connection request with no note —
  a connection request is still contact with a real person, and on most platforms
  it is the action most likely to get an account restricted. There is no config
  value that turns this off, and the send guard blocks it regardless of what any
  instruction here says.
- **Reason gate before drafting**, every time.
- **Decision-makers only**, verified current.
- **Suppression first** — customers, open deals, live sequences, exclusion
  lists, recently-contacted, and the tenant's hard-blocked customer domains
  matched by domain rather than display name.
- **Free research before paid.** Web search and count calls cost nothing;
  company enrichment is per account; contact work is per person. Spend in that
  order and stop at the configured ceiling.
- Do not unlock phone numbers.

## Credit shape (rough)

Per contact worked end to end: discovery plus enrichment plus email lookup plus
whatever enrichment runs at enrollment. Per account scanned: one company
enrichment. Size a run by multiplying the per-contact cost by the daily cap and
adding the per-account cost for the accounts you expect to touch, then set
`caps.enrichment_credits_per_run` above that with headroom.
