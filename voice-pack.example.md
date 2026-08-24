# Voice pack — TEMPLATE

Copy this file to `voice-pack.md`, fill in every `<...>` placeholder, and point
`voice_pack:` in `config/tenant.yaml` at your copy. **This file ships with no
positioning in it.** Everything below the structural guidance is yours to write.

This is the messaging brain. The plays decide *why* someone gets a message; this
file decides *what it sounds like*. When this file and the plays disagree about
tone, this file wins. When `state/lessons.md` (accumulated corrections from
whoever approves the drafts) and this file disagree, **lessons win** — that is
how the system learns.

Write it for an agent, not for a brand team. Every line should be something a
drafting agent can actually obey or check.

---

## 1. Positioning

> One paragraph. What category are you in, in the buyer's words? What is the
> shift you are arguing for? Be concrete enough that a message written from this
> paragraph could not have been written by your competitor.

<POSITIONING>

**Lead with:** <the frame every message should start from>

**Never sound like:** <the adjacent category you get mistaken for, and the exact
phrases that cause it>

---

## 2. What we are and what we are not

> Agents drift toward generic category language under pressure. Name the drift
> explicitly so it can be caught.

**We are:**
- <...>
- <...>

**We are NOT:**
- <...> — if a draft implies this, it is wrong even if it reads well.
- <...>

**Banned phrases** (exact strings a reviewer can grep for):
- <"phrase">
- <"phrase">

---

## 3. Buyer personas and their pain

> One block per persona. The "pain" line is the one the agent actually uses, so
> write it as the problem in their words, not as your feature in disguise.

### Persona A — <TITLE / FUNCTION>
- **What they own:** <...>
- **The pain, in their words:** <...>
- **What they are measured on:** <...>
- **The value framing that lands with them:** <...>
- **What makes them delete the email:** <...>

### Persona B — <TITLE / FUNCTION>
- **What they own:** <...>
- **The pain, in their words:** <...>
- **What they are measured on:** <...>
- **The value framing that lands with them:** <...>
- **What makes them delete the email:** <...>

**Never the buyer:** <the titles that look adjacent but cannot buy — the agent
should go UP the org chart, never down, when a search comes back empty>

---

## 4. Proof points

> **Use only real, verifiable customer results, and only ones you have
> permission to name.** An invented or "representative" number is the single
> fastest way to lose a deal and, depending on your market, to create a legal
> problem. If you cannot cite it in a public deck, it does not belong here.
>
> Name the customer. "A company like yours" persuades nobody. If a customer has
> not agreed to be named, leave them out rather than anonymising them.
>
> Keep each entry to: who, what they did, what happened, over what period.

| Customer | What they run | Result | Timeframe | Cleared for use? |
|---|---|---|---|---|
| <NAME> | <...> | <...> | <...> | <yes / logo-only / no> |
| <NAME> | <...> | <...> | <...> | <...> |

**Matching rule:** cite the customer **closest to this prospect's size and
motion**, not the most impressive one. A prospect ignores a logo that is ten
times their size.

**Use at most one proof point per message.** Two reads as a brochure.

---

## 5. Message structure and word caps

> These caps are craft, not preference. Length is the most common reason a draft
> gets sent back. Tune the numbers if you must, but keep hard numbers — a cap an
> agent can count is worth more than an instruction to "be concise".

**Email — two visual sections after the greeting, maximum.**
1. **Show me you know me.** The single sharpest signal, short, specific,
   human. What you saw and why it matters in *their* world. **Do not stack
   signals** — one hook, stated once.
2. **A useful idea, then a soft ask.** One thing they could act on, then a
   low-friction CTA. The product is the soft landing, never the opener.

- **Hard cap: under <60> words** of body, greeting and sign-off excluded.
  Target <35-50>. Applies to every email in the sequence.
- Follow-ups run shorter: <25-40> words.
- **Count the words before routing a draft. If it is over, cut — do not
  reword.** The usual overrun is explaining the problem twice, once in the
  signal beat and again in the idea beat. Say it once.
- Greeting format: `<First name> - ` on its own line.
- Sign-off: `<SENDER FIRST NAME>` on its own line.
- No P.S. Never mention that a system wrote it.

**Direct message.**
- Lead with the **same** hook the first email opens with. Never bury the best
  research point, and never jump straight from the signal to "here's what we do".
- Short blocks with real line breaks. Three or four lines maximum.
- Softer CTA than the email: "worth sending over?", "want the example?"
- The accepted-connection follow-up is the shortest message in any plan:
  introduce yourself, reference the earlier email in one clause, one soft line.

**Connection request.**
- <no note / short note — pick one and say which> If a note, it obeys the same
  caps.

**Subject lines.**
- Specific to the signal and to the value inside. Tease the useful thing, not
  the product.
- Short and human. No hype, no clickbait, no "checking in".
- **Banned:** "quick idea", "thought for you", "quick question", "touching base".

---

## 6. Voice rules

- **Lead with value.** Every message must contain something useful even if they
  never reply. If you deleted the CTA and the message became worthless, rewrite
  it.
- **One ask per message.** Two asks is zero asks.
- **No fake familiarity.** A shared trait only earns a line if it is *strong* —
  the same specific school, the same actual hometown, the same sport played
  competitively, a real mutual connection, something genuinely distinctive.
  Weak overlaps (both like the outdoors, both in the same large metro, both
  "into AI") are **worse than nothing**: they read as forced and instantly
  identify the message as automated. Default to no rapport line at all and lead
  with the research instead. Never write "fellow <anything> here".
- **Verify the overlap is about the PERSON, not their company.** A company
  headquartered in your city does not mean the prospect lives there.
- **Never fabricate.** No invented metrics, engagement numbers, ad copy, mutual
  connections, or customer results. If you did not retrieve it, you cannot cite
  it.
- **Write about them, not about you.** Count the sentences whose subject is your
  company. More than one is too many.
- Tone: <short, direct, casual, peer-to-peer — set yours here>.
- Punctuation and formatting rules: <e.g. no em dashes, no exclamation marks,
  no bullet lists inside emails>.
- **AI-tell filler to avoid:** "here's the thing", "let's be honest", "at the end
  of the day", "that's the whole game", "I hope this finds you well". Add your
  own as you spot them in sent-back drafts.

---

## 7. CTA menu

> Rotate these. One repeated CTA across a whole day of cards is the most visible
> tell that a machine wrote them.

- <"...">
- <"...">
- <"...">

**Never:** <the phrasings you have found land badly>

---

## 8. `sender_profile` — the human the outreach sends as

> Fill one block per sending human. The agent uses this for credibility clauses
> and for the strong-overlap check. Keep it factual: these are things the sender
> can defend in a reply, not personality colour.
>
> Do not put anything here that the sender would not want quoted back to them by
> a stranger.

```yaml
sender_profile:
  - id: <owner_id matching approval_routing.owners[].id in config/tenant.yaml>
    name: "<Full name>"
    title: "<Title>"
    signs_as: "<First name>"

    # At most ONE of these may appear in any single message, as a short clause,
    # and only where it earns trust. Two credentials in one message reads as a
    # brag and stops sounding like a person. At a hard word cap, a credential
    # has to displace a sentence — only spend it when it beats what it replaces.
    credibility:
      - "<e.g. founder, and looking at this personally>"
      - "<e.g. previously ran this function at a company the buyer respects>"

    # Used ONLY for the strong-overlap bar in section 6. Leave empty rather
    # than padding it; a thin list is safer than a forced rapport line.
    background:
      hometown: "<...>"
      schools: ["<...>"]
      previous_companies: ["<...>"]
      distinctive: ["<the genuinely unusual things — these are the only ones
                     that ever make good rapport lines>"]

    channels:
      email: <true|false>       # is there a connected mailbox for this sender?
      social: <true|false>      # is there a connected social account?
    # If a channel is false, the agent must report a routing gap rather than
    # quietly reassigning the play to someone else.
```

---

## Worked example (fictional — delete before use)

Everything below is about **Northwind Analytics**, a company that does not
exist. It is here so you can see the shape of a filled-in pack.

**Positioning.** Northwind turns the warehouse data a finance team already has
into the weekly cash-flow view they currently rebuild by hand in a spreadsheet.
We are not a BI tool and we are not a forecasting model — we are the piping that
makes an existing number trustworthy on a Monday morning. Lead with the manual
rebuild, never with "dashboards".

**Never sound like:** a BI vendor. Banned: "single source of truth", "unlock
your data", "actionable insights".

**Persona A — VP Finance at a 200-800 person company.** Owns the board pack.
Pain, in their words: "I don't trust the number until I've checked it myself,
and checking it takes two days." Measured on close speed and forecast accuracy.
Value framing: the number arrives already reconciled. Deletes anything that
opens with the word "platform".

**Never the buyer:** financial analysts. They rebuild the spreadsheet; they do
not buy the thing that replaces it. If no VP Finance turns up, go to the CFO.

**Proof points.** Harbor Freight Logistics — moved a five-day manual close to a
two-day close in one quarter (cleared, named). Cascade Dental Group — cut
forecast variance from 18% to 6% over two quarters (cleared, named).

**Caps.** Email body under 60 words, target 40. Follow-ups 25-40. Greeting
`Dana - `. Sign `Priya`.

**A draft that passes:**

> Subject: your two-day close
>
> Dana -
>
> Saw you took over finance at Cascade six weeks ago, right before a close.
>
> The teams I've seen shorten that fastest start by reconciling one line item
> automatically instead of the whole pack. Harbor Freight went five days to two
> that way. Want me to send how they scoped it?
>
> Priya

38 words in the body. One signal, dated and sourced. One idea. One proof point,
size-matched. One ask. No rapport line, because there was no strong overlap —
and the message is better for it.

**The same draft, failing:**

> Subject: quick idea for Cascade
>
> Hi Dana! I hope this finds you well. I noticed you recently joined Cascade as
> VP Finance — congrats! I'm also a big fan of the Pacific Northwest. At
> Northwind Analytics we're building the single source of truth for modern
> finance teams, unlocking actionable insights from the data you already have.
> Companies like yours have seen dramatic improvements. Would you be open to a
> quick 15-minute call next week to explore synergies?

Banned subject. Fake familiarity from a weak geographic overlap that is about the
company, not the person. Three banned phrases. An unnamed, unverifiable proof
claim. All about the sender. 78 words. This is what the caps and the rapport bar
exist to catch.
