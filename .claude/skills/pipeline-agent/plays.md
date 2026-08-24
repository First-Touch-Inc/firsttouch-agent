# Play catalogue

A **play** is the hook logic for one bucket: when it fires, what the hook is,
what research it needs, what shape the message takes, and what disqualifies the
candidate. Voice, positioning, proof points, word caps and CTA wording all come
from the tenant's voice pack — the plays never restate them.

The rule underneath all of them: **lead with something genuinely useful to the
person.** The product is the soft landing at the end, never the opener.

Bucket ids below are the defaults shipped in `config/tenant.yaml`. Rename them
freely; the `play:` key on each bucket is what binds a source to a play.

---

## Formatting — applies to every drafted message

Write for a phone screen.

- **Subject line** — specific to the signal and to the value inside. Never
  generic teaser language ("quick idea", "thought for you", "checking in").
  Tease the useful thing in the email, not the product.
- **Email** — at most **two visual sections** after the greeting. Section one
  proves you know them, in one short specific human beat. Section two gives one
  value-added idea and a soft ask. Greeting on its own line, sign-off on its own
  line after a blank line. No paragraph longer than about three lines.
- **Direct message** — shorter still. One-to-two sentence chunks, a blank line
  between them, three or four short lines maximum. Softer CTA than the email.
- Carry the line breaks as real newlines in the draft field values so they
  render the same way in the approval card and in the platform. Readability beats
  density every time.
- Honour the voice pack's word cap on every step, including follow-ups. Count
  the words before routing. If it is over, **cut — do not reword.**

---

## Play: engager-followup — bucket `social-engagers`

**Fires when** someone liked or commented on a post from one of the tenant's
monitored profiles inside the lookback window, and they plausibly fit the ICP
judged from the free row alone (name, headline, the post they engaged with).

**The hook is the post, not the like.** They showed interest in a *topic*, and
the outreach continues that conversation. "I saw you liked my post" is context,
worth one clause early on, and it is never the value. Comments outrank likes —
if they wrote something, respond to what they actually said.

**Research needed:** the post text or topic (summarise it in about five words),
their comment verbatim if there is one, and a two-minute scan of their company
so section two can be about their world and not a generic idea.

**Message shape (the same hook at two lengths):**
1. One clause of context: which topic they engaged with.
2. One genuinely useful idea that *extends that topic* for their company
   specifically.
3. One line of soft landing, then the low-friction ask.

**Cadence:** two emails and two direct messages, ordered per the tenant's
connection-aware `sequence_defaults`. Email one and DM one share the sharpest
hook; email two switches to a different angle; DM two is a short nudge.

**Disqualifies:** already messaged by any prior flow or enrollment; not ICP; the
post they engaged with was a hiring post, a personal-life post, or a condolence
thread, where outreach reads as scraping a moment that was not about business.

---

## Play: signup-reactivation — bucket `signups-stalled`

**Fires when** someone created an account more than the configured staleness
window ago, has no open or won deal, and is not already an active paying
account. Run the platform and CRM suppression preflight first — this bucket sits
closest to real customers and is the easiest one to embarrass yourself in.

**The hook is where they stalled.** Read the product-usage properties on their
account and pick the FIRST stage that matches. Each stage has exactly one job:
move them to the next stage. Not to a sale.

| Stage (first match wins) | What it looks like | The one job | Angle |
|---|---|---|---|
| 1. Never connected anything | the core integration flag is false | Get the integration connected | "You signed up but never plugged in <system>. That's a couple of minutes and it's where all the value is — here's what it unlocks for you specifically." |
| 2. Connected, never configured | zero workflows/campaigns created | First configuration | Suggest one concrete first thing to run, chosen from what you know about their business. |
| 3. Configured, nothing executed | zero actions sent | First real execution | They are usually blocked on a setup step (a seat, a connected account, a permission). Offer that specific unblock. |
| 4. Executing, no results | actions sent, zero replies/conversions | First result | Give ONE concrete improvement to their approach. This is the most help-first moment in the whole system. Be specific, not salesy. |
| 5. Results, no expansion | they got a result and drifted | A conversation | Ask what happened. Genuinely curious, zero pitch. |
| — No usage data at all | no associated account record | A conversation | Honest and warm: "you signed up a few weeks back — what were you hoping it would do? If it whiffed, tell me why, that's more useful to me than a customer." |

**Rules:**
- **Founder or owner voice.** This is a person writing to someone who tried
  their product. More direct and more personal than the cold plays. No template
  smell.
- Email first. A social step is optional and only when the profile is verified.
- Never guilt-trip. "I noticed you haven't logged in" is surveillance-speak.
  "You signed up but never connected <system>" followed immediately by value is
  honesty.
- Usage properties are context for **tone** only, after eligibility is settled.
  Do not quote their numbers back at them.
- One reactivation attempt per contact per cooldown window. Silence here is a
  strong "leave me alone" — ledger it and respect it.

**Disqualifies:** any paid-plan or active-account signal; an open deal; a live
enrollment; an explicit prior opt-out.

---

## Play: reply-no-activity-followup — bucket `replies-no-followup`

**Fires when** someone replied to a sales or outreach email and nothing
meaningful happened afterwards — no meeting, no logged next step, no new
sequence, no open deal.

**The hook is the missed thread.** They already raised their hand. The follow-up
acknowledges that without sounding like an automation audit and without blaming
whoever dropped it.

**Research needed, in order:**
1. The CRM list or saved search that defines "replied, then nothing".
2. The actual reply: what they asked, what they objected to, what they seemed
   curious about. Without this you cannot draft. See the disqualifiers.
3. The activity timeline after the reply, to confirm the gap is real.
4. Enrichment only if the current role or company is unclear, or a social step
   is part of the plan.

**Prioritise** positive, curious, open-ended and specifically problem-shaped
replies; people who asked a question and never got a useful answer; older gaps
where a personal note can credibly reopen the thread.

**Message shape:**
1. Own the miss lightly, in one clause. "I was going back through a few threads
   and saw your note about X."
2. Answer the question they actually asked, or add the value that never arrived.
3. A very soft ask: "still worth answering?", "want me to send that example?",
   "should I just close the loop here?"

Never write "our system noticed" or "you were never followed up with."

**Disqualifies:** brush-offs, unsubscribes, angry replies, explicit "do not
contact"; anyone with a later meeting, an active deal, an active sequence, or
real logged follow-up after the reply; **any thread whose reply text you cannot
actually read** — report that as a digest item rather than drafting blind.

---

## Play: visitor-intent — bucket `website-visitors`

**Fires when** a known contact, or a de-anonymised company that resolves to an
ICP-plausible account, visited the site inside the window and is not a customer,
an open deal, or a live enrollment.

**The hook is what they were trying to find out, never that you saw them.**
"I noticed you visited our pricing page" is an instant delete. The page they
landed on tells you the *question they were asking*. Answer that question.

**Page-intent ladder, hottest first:**
1. **Pricing** — they are evaluating cost. Angle: the thing that actually
   determines whether this pays for itself for a company shaped like theirs.
2. **Product or feature page** — they have a specific job to be done. Angle: one
   genuinely useful idea about THAT job for their motion.
3. **Integration, security or compliance pages** — they are derisking. Angle: the
   short factual version of that story.
4. **Blog or content only** — weakest intent. Treat it like an engager: continue
   the topic. Only work it if the title and company are strongly ICP.

**Research needed:** last-URL and page-history properties, plus a two-minute
company scan. Repeat visits or several pages in one session mean say more,
sooner — still without ever referencing the visit itself.

**Message shape:** open with the question the page implies they are wrestling
with, give one specific useful idea for their company, then the soft landing and
low-friction ask.

**Disqualifies:** anonymous traffic that does not resolve to an ICP company;
careers-page traffic (job seekers); existing customers and open deals;
competitors; anyone whose only visit was a single blog page and whose title is
not a buyer.

---

## Play: cold-outbound — bucket `target-accounts`

**Fires only as fill**, after every warm and relationship bucket has been swept,
and only for accounts where research produced a real, dated reason. The
mechanics live in the `outbound-bdr` skill; this entry defines when the
orchestrator is allowed to reach for it.

**The hook has to be found, because the bucket has no signal of its own.**
Acceptable reasons, in rough punch order: a leader who started in the role
recently; an open req for the function you sell into; a named competing or
adjacent tool in their stack; live advertising you can actually cite; funding or
headcount movement; genuine audience size or post traction; existing history
with the tenant (a prior thread, an old signup, an owned account, a real
first-degree connection).

**Banned as a reason:** an analogy between what they sell and what the tenant
sells; their stage; their headcount; their marketing copy; membership of the
list. **No reason found means do not draft.** Move to the next account and count
the drop in the run report.

**Research needed:** company firmographics, then free web research for the
signal, then one canonical-role discovery pass per role, then verification that
the person is CURRENT in that role.

**Message shape:** the sharpest single signal in the opening beat, one useful
idea in the second, soft landing, low-friction ask. Never stack signals.

**Disqualifies:** everything in the global suppression list, plus any account
where the only "reason" fails the gate above.

---

## Play: partner-depth — bucket `partner-network`

**Fires when** the tenant wants to go deeper with a partner, platform, or
ecosystem company rather than sell to it. This is relationship mapping, not
outbound.

**The hook is the shared ecosystem.** The useful thing is a concrete way the
tenant can help that partner's team create more value for their own customers.

**Research needed, in order:**
1. Saved first-degree connections for the tenant's own senders.
2. Existing CRM contacts and known conversation history.
3. Public team pages and profile research to find the right function.
4. Paid enrichment only after a promising path or a partner-relevant role exists.

**Target functions:** technology partnerships, marketplace, ecosystem, platform,
channel, alliances, integrations — plus customer-facing reps at the partner who
could surface co-selling or introduction paths.

**What each candidate must produce:**
1. The person and their role.
2. The warmest path to them: a direct connection, a mutual, existing CRM
   history, or an explicit argument for why a cold-but-contextual note is
   credible here.
3. Why this person matters, specifically.
4. The recommended next action, modelled as an approval-gated message, email or
   call when the sender and channel are verified. If the honest next step is an
   introduction request that has to travel through a colleague, that is a digest
   item, not an action.

**Message shape:** lead with one practical partner motion, not the word
"partnership". Sound like an operator exploring a specific path, not a vendor
angling for a channel meeting. The ask is usually soft: the right person to
talk to, feedback on the angle, or permission to compare notes.

**Disqualifies:** generic partner titles with no relevance to the shared
customer base; no identifiable path AND no specific reason the person matters;
anyone already in an active outreach sequence.

**Important constraint:** if the warm path runs through a *colleague's*
connection rather than the sending owner's, do not create outreach owned by the
sender that pretends otherwise. Surface it as an introduction request. This is
the same rule as the owner-assignment invariant in `SKILL.md`, seen from the
messaging side.
