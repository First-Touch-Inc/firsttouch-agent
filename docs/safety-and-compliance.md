# Safety and compliance

**Read this before you go live.** Not after the first scheduled run, and not
after the first complaint.

This agent drafts messages to real people, to be sent under a real person's name,
using personal data about people who did not ask to hear from you. That is a
regulated activity in most of the world, and the obligations land on **you**, not
on this software.

> **This is not legal advice.** It is an engineer's summary written to help you
> ask the right questions, with sources so you can check the current position
> yourself. Laws change, enforcement practice changes, and none of this is
> tailored to your business or your jurisdiction. If you are sending at any
> volume, or into the EU, the UK or Canada, get advice from someone qualified to
> give it.
>
> **You are the data controller.** You decide who gets contacted and why. This
> repo is a tool you operate; running it does not make anyone else responsible
> for what it produces. Nothing here makes you compliant with anything, and this
> project makes no such claim.

- [The approval gate](#the-approval-gate)
- [Volume discipline](#volume-discipline)
- [CAN-SPAM (US)](#can-spam-us)
- [GDPR and ePrivacy (EU/EEA and UK)](#gdpr-and-eprivacy-eueea-and-uk)
- [CASL (Canada)](#casl-canada)
- [LinkedIn and platform automation rules](#linkedin-and-platform-automation-rules)
- [Data protection in practice](#data-protection-in-practice)
- [Pre-launch checklist](#pre-launch-checklist)

---

## The approval gate

**Every message this agent composes stops in a human queue.** Someone reads it
and clicks approve before it reaches anyone. No configuration flag changes that.

There is one deliberate exception, and you should understand it before you enable
it. If you list a flow under `flows:` in your config, the agent may enrol a
qualified person into that flow without a further approval — because **you** wrote
that copy and **you** published it, so the human review happened at publication
rather than per contact. The agent cannot author a flow, cannot publish one, and
cannot enrol into a flow you did not list. Leave `flows:` empty and the agent
works purely in approval-gated drafts.

The trade is worth naming plainly: on the flow path nobody reads the individual
before messages start going out. **Qualification and suppression are the controls
there**, not the queue. Keep the flow list short, and give a new flow a dry run
before you list it.

That is not a default. It is enforced in three places:

1. **[`.claude/hooks/guard-send.mjs`](../.claude/hooks/guard-send.mjs)** — a
   `PreToolUse` hook that denies any tool call which would deliver a message
   directly, any agent-composed action created without the human-approval flag
   set to true, any action created without an explicit owner, any attempt to
   author or publish a flow, and any enrolment into a flow you did not declare. It fails closed, and it denies
   rather than asks, because during a scheduled run there is no human at a
   terminal to answer. See [security.md](security.md#the-send-guard).
2. **The runner's tool allowlist** — `--allowedTools` grants the outreach and CRM
   MCP servers, file reads and writes, and web search. `Bash` is denied three
   times over. There is no sending tool in the list.
3. **The outreach platform's own task queue**, which is the source of truth for
   what actually goes out.

### Why it is not optional

Because the failure mode is unrecoverable in a way that most software failures
are not.

- **A sent message cannot be unsent.** There is no rollback. The person has read
  it, and their opinion of you is formed. A bad database write can be repaired;
  a bad first impression at 200 recipients cannot.
- **It sends as a real human.** Every message goes out under a named person's
  identity, from their mailbox or their social account. The reputational cost
  lands on that individual, not on "the tool" — and if the message is wrong about
  who they are or what their company does, that person looks careless to a buyer
  they may need later.
- **The agent reads attacker-controllable text.** Prospect bios, company
  websites and CRM notes can contain instructions aimed at the model. The
  approval gate is the mitigation that survives a successful prompt injection: an
  injection can change what the agent *drafts*, but a human still reads it before
  it goes anywhere. See [security.md](security.md#prompt-injection).
- **Models are confidently wrong.** Research produces a plausible sentence about
  a funding round that did not happen, or a role the person left a year ago.
  Approval is where that gets caught.
- **Legally, it is where your obligations get met.** The reviewer is the last
  point at which you can confirm this person has not opted out, that the message
  is not deceptive, and that you actually have a basis for contacting them.

**Approve like a reviewer, not a rubber stamp.** A queue that is always approved
in bulk is the same as no queue — you have the compliance posture of an
autonomous sender with extra steps. If you find yourself approving 20 drafts in
30 seconds, either lower the cap or fix the voice pack until the drafts are worth
reading. The `run_mode: supervised` default and its cap of 3 exist to make the
first weeks small enough to actually read.

### What the gate does not protect you from

Be clear about the boundary. The gate ensures a human made the decision. It does
not make the decision correct.

- It does not make the message legal. **You** approved it.
- It does not create a lawful basis for processing someone's data — the
  processing already happened during research, before anyone saw a draft.
- It does not satisfy a platform's automation rules. See
  [LinkedIn](#linkedin-and-platform-automation-rules).
- It does not stop you from approving something you should not have.

---

## Volume discipline

The single most common way this kind of system fails is not a legal one. It is
that someone turns the cap up, the replies stop, the domain gets filtered, and
six months of sender reputation is gone.

### Why warm beats volume, concretely

The buckets in `config/tenant.yaml` are worked in warmth order, and cold outbound
is deliberately last with the highest `priority` number. That ordering is not
sentiment:

- **Someone who engaged yesterday has a real reason to hear from you**, and the
  message can name it. That is the difference between a note that reads as
  observed and one that reads as generated.
- **Reply rate compounds into deliverability.** Mailbox providers weight
  engagement. Replies and opens from real conversations keep you in the inbox;
  a high volume of ignored mail moves you to spam, and it moves *all* your mail
  to spam, including the messages your colleagues send to customers.
- **Cold volume has a floor on quality that cold research cannot raise.** Sending
  more of it does not produce more meetings past a certain point; it produces
  more complaints, which is the input to the filtering that then suppresses the
  warm messages that were working.
- **On social channels, volume is what triggers enforcement.** Connection
  requests and messages are the metered actions, and the account that gets
  restricted belongs to a person on your team.

The reason gate in the `target-accounts` bucket is the mechanism that keeps cold
outbound honest: no researched, dated, sourced reason means no draft, even if
that means the day ends short. **A short day beats a manufactured one.** Do not
delete those rules to hit a number — the number is a target, never a quota.

### The limits block

`limits` in `config/tenant.yaml` is separate from `caps` on purpose. `caps` is
how much work the agent does; `limits` is how hard it leans on any one channel.
The shipped defaults are deliberately conservative:

| Limit | Shipped default |
|---|---|
| `limits.email.max_per_day` | 20 |
| `limits.social.max_connection_requests_per_day` | 10 |
| `limits.social.max_connection_requests_per_week` | 40 |
| `limits.social.max_messages_per_day` | 15 |
| `limits.max_contacts_per_company_per_quarter` | 3 |
| `limits.max_touches_per_contact_per_quarter` | 6 |

The last two matter more than people expect. Contacting eight people at one
company in a month reads to a buying committee as a spray, and they *do* compare
notes — the internal forward of "we've all been getting these" has killed more
deals than a low reply rate ever did.

**Before you raise any of these:**

- Warm up a new sending domain and mailbox properly first. A brand-new domain
  sending 20 cold emails on day one is the textbook spam signature.
- Have SPF, DKIM and DMARC configured and passing. This is table stakes, and it
  is not optional at any volume.
- Read a month of replies. If you are not getting positive replies at 10/day,
  20/day produces twice as much of the same problem.
- Raise one channel at a time, and watch bounce and complaint rates.

Social platforms publish no reliable public number, enforce silently, and
restrict the account rather than the tool. Treat any figure you read online —
including the defaults above — as a guess, not a safe harbour.

---

## CAN-SPAM (US)

The US regime is **opt-out**. Nothing in the statute requires consent before a
first commercial email, which is why cold outbound is a normal business practice
in the US and not in much of Europe.

**It applies to B2B.** A "commercial electronic mail message" is defined by its
content — a message whose primary purpose is advertising or promoting a product
or service (15 U.S.C. § 7702(2)(A)). There is no exception for work addresses,
corporate domains, or business recipients. If you have read otherwise, it was
wrong.

What § 7704(a) requires of every message:

| | Requirement |
|---|---|
| Headers | No materially false or misleading header information |
| Subject | No subject line likely to mislead about what is inside |
| Identification | Say clearly that the message is an advertisement or solicitation |
| Address | Include a **valid physical postal address** of the sender |
| Opt-out | A working opt-out, clearly displayed, that keeps working **at least 30 days** after the message |
| Honour it | Stop within **10 business days** of the request, and never sell or transfer that address afterwards |

The opt-out must be cheap to use. Under 16 C.F.R. § 316.5 you may not charge a
fee, demand anything beyond an email address and their preferences, or require
more than a reply or **a single web page**. A login wall or a multi-step
preference centre as the only route does not comply.

You are also responsible for what is done on your behalf — you cannot contract
compliance away to a vendor or an agency.

**Penalties.** The FTC's maximum civil penalty is **$53,088 per email**, set at
16 C.F.R. § 1.98 (90 FR 5580, January 2025) and still current — there was no
2026 adjustment, because the funding lapse meant the CPI figure the formula needs
was never published (OMB Memorandum M-26-11, April 2026). Separately, state
attorneys general can pursue $250 per message up to $2,000,000, trebled for
willful conduct, with each separately addressed message counted as its own
violation (§ 7706(f)(3)).

FTC penalties are not strict liability — they require actual or fairly implied
knowledge. That is thinner comfort than it sounds once you are running an
automated system you configured yourself.

**This is enforced against exactly this use case.** In August 2024, Verkada paid
a **$2.95 million** civil penalty, reportedly the largest CAN-SPAM penalty to
date, over commercial email to *prospective* customers with a broken opt-out
path and no physical address. That is a B2B prospecting programme, not a consumer
spam operation.

**State law is the sharper risk.** CAN-SPAM gives recipients no private right of
action, but it does not preempt state laws targeting falsity or deception, and
those often do. California's Business & Professions Code § 17529.5 allows
recipients to sue for **$1,000 per email, up to $1,000,000 per incident** — and
reduces that tenfold where the sender "implemented and maintained reasonable
practices and procedures to effectively prevent" violations. Your suppression
list, your header accuracy, and your run ledger are the evidence for that
reduction. That is a concrete reason to keep them, beyond tidiness.

Fill in `sender_identity` in your config before sending a single email. A blank
`postal_address` or `unsubscribe_url` is not a formatting problem; it is the
violation.

## GDPR and ePrivacy (EU/EEA and UK)

**Do not assume your US defaults travel.** They do not. If you may contact people
in the EU, the EEA, or the UK, read this section properly or exclude those
regions in your targeting.

### B2B is not exempt

This is the most common and most expensive misconception. GDPR protects
**natural persons**, whatever capacity they are acting in. `jane.doe@acme.com`
plus a name and a job title is personal data. What falls outside is data about
the **legal person** — the company name, its legal form, and its corporate
contact details (Recital 14). So `contact@acme.com` is plausibly out of scope
while a named individual's work address is squarely in scope.

"B2B versus B2C" is not the line. "Legal person versus natural person" is.

### Two separate gates

The mistake almost every vendor makes is treating these as one question:

1. **May you process the data at all?** That is GDPR Article 6. For prospecting
   the workable basis is legitimate interests, Art 6(1)(f).
2. **May you send the message?** That is the ePrivacy Directive, Article 13, as
   implemented in each country's national law.

**Passing the first does not satisfy the second.** The EDPB says so directly in
its guidelines on Art 6(1)(f): where unsolicited direct marketing by electronic
mail requires prior consent, "the processing for direct marketing purposes may
not be based on Article 6(1)(f) GDPR." A well-documented legitimate-interests
assessment does not cure a missing opt-in.

Recital 47 says direct marketing "may be regarded as" a legitimate interest.
That is permission to run the balancing test, not the result of it. The same
recital says interests can be overridden where people "do not reasonably expect
further processing" — which is precisely the position of someone who has never
heard of you.

The assessment has three cumulative parts: a real, specific, present interest;
processing that is genuinely necessary for it; and the person's rights not
overriding it. **Document it before you start**, not after a complaint.

### The country problem is permanent

ePrivacy Art 13(5) requires prior consent for **natural-person** subscribers and
tells member states only that the interests of everyone else must be
"sufficiently protected" — without saying how. Each country answered
differently, and the ePrivacy Regulation that was meant to harmonise this was
**withdrawn by the Commission in October 2025**. The fragmentation is the settled
state of affairs, not a transitional one.

Two consequences follow, and only the first is something this document can
settle for you.

**The rule genuinely differs by country, and the difference is opt-in versus
opt-out.** Some member states require prior consent before a cold B2B email;
others allow an opt-out approach where the message relates to the recipient's
professional role. Germany is at the strict end and is enforced through
competition law, which means competitors and trade associations can act, not
just a regulator. France sits at the permissive end via its regulator's
legitimate-interest position. The Netherlands, Ireland, Italy, Spain, Austria
and the Nordics all differ again.

**This document deliberately does not tell you which bucket your market is in.**
Restating national implementing law accurately is a moving target — the texts
are amended, regulator guidance is revised, and a confident sentence here that
turns out to be a year stale is worse than no sentence, because you would rely
on it. What this project can honestly give you is the shape of the problem and
the primary sources:

- [ePrivacy Directive 2002/58/EC, Article 13](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A02002L0058-20091219) — the consent rule, and 13(5), which is where the divergence comes from
- [GDPR Articles 6, 14 and 21](https://eur-lex.europa.eu/eli/reg/2016/679/oj) — lawful basis, the disclosure you owe, the absolute objection right
- Your own national regulator's direct-marketing guidance, which is the only source that will be current

**Practical default:** treat EU, EEA and UK recipients as consent-required until
you have confirmed otherwise for that specific market, and get advice for the
markets you actually sell into. If you are only sending to the US, none of this
section applies to you — [CAN-SPAM](#can-spam-us) does.

### What you must tell people

Because you did not collect the data from the person, **Article 14** applies. You
must disclose who you are, the purposes and the **legal basis**, the categories
of data, retention, the legitimate interests you are relying on, their rights,
their right to complain to a regulator, and — the one prospecting tools
consistently omit — **where you got their data**.

The timing is the part that surprises people. Art 14(3)(b): if the data is used
to communicate with the person, the information is due **at the latest at the
time of the first communication**. Your first email or DM is the deadline, not a
month later. In practice that means a privacy notice, linked prominently from
the first message, that actually names your data sources.

### The right to object is absolute

Art 21(2)–(3): a person may object to direct marketing at any time, and the data
"shall no longer be processed for such purposes." There is no balancing test and
no compelling-grounds exception — those exist in Art 21(1) for other processing,
not for marketing.

And Art 21(4) is a **formatting requirement**, not just a policy: the right must
be brought to their attention "at the latest at the time of the first
communication," explicitly, and "presented clearly and separately from any other
information." An unsubscribe link folded into a footer alongside your address and
a logo does not meet that on its face.

Operationally: an objection goes into `do-not-contact.txt` immediately and
permanently. Suppress, never delete — a deleted contact gets re-added by the next
CRM sweep.

### The fines sit in the higher tier

Article 83 has two tiers: €10M or 2% of worldwide annual turnover, and €20M or
4%, whichever is higher in each case. Data-subject rights under Articles 12–22
are in the **4% tier** — which means both a failed Article 21 objection and an
Article 14 transparency failure are top-tier exposures, not minor paperwork.
Failing your lawful basis under Article 6 is also 4%.

ePrivacy penalties are separate, set nationally, and not capped by these figures.

### Who is responsible

Because you fork this, run it on your own infrastructure, choose the targeting
and send from your own accounts, **you are the data controller**. The authors of
this software do not receive your prospect data and are not a processor for it.
Enrichment vendors you configure are your processors, and diligence on them is
your job.

## CASL (Canada)

Canada is **consent-based**, and materially stricter than the US. If your
targeting includes Canada, your US-shaped configuration is not sufficient.

The differences that matter:

- **Consent is required before sending**, express or implied — not an opt-out
  after the fact.
- **The sender bears the burden of proving consent.** In the leading case a
  company sent hundreds of thousands of messages relying on addresses being
  publicly available and lost purely on evidence: it could not show where or when
  it obtained them. Keep provenance per contact.
- **Implied consent is narrower than "I found it online."** The conspicuous-
  publication route requires the person to have published the address themselves,
  without a no-solicitation statement, **and** the message must be relevant to
  their role. A purchased or third-party-compiled list does not create implied
  consent.
- **Scope is broader than email.** CASL's "electronic address" covers instant
  messaging and similar accounts, and the regulator has indicated that direct
  messages on social platforms — LinkedIn messaging included — qualify. **A
  message asking for permission to send you a pitch is itself a commercial
  message**, so you cannot DM your way to consent.
- **Unsubscribe must be honoured without delay and no later than 10 business
  days**, and the mechanism must stay valid for 60 days.
- **Penalties are up to CAD $1,000,000 for an individual and $10,000,000
  otherwise**, and officers and directors can be personally liable where they
  directed or acquiesced in the violation.

There is a further provision worth knowing if you build on this: CASL prohibits
aiding or procuring a violation, and the regulator has named software developers
and electronic marketers as parties who can be exposed under it.

Whether a LinkedIn connection request *with a note* is a commercial message, and
whether a bare request is a message at all, appears genuinely unsettled with no
published guidance. Treat both as in scope.

## LinkedIn and platform automation rules

Read this before you enable any social bucket.

**The terms are not ambiguous.** LinkedIn's User Agreement § 8.2 prohibits, among
other things:

- **§ 8.2.13** — using "bots or other unauthorized automated methods" to access
  the service, **add or download contacts, send or redirect messages**, or drive
  inauthentic engagement.
- **§ 8.2.2** — developing, **supporting**, or using software, scripts, robots,
  crawlers or browser extensions to scrape or copy the service. Note that it
  binds the person who *builds or supports* the tool, not only the person running
  it.
- **§ 8.2.1** — misrepresenting identity or using another's account, expressly
  including **sharing login credentials**. That clause describes the mechanism of
  every hosted tool that operates a member's session on their behalf.
- **§ 8.2.3** — circumventing access controls or **use limits**.

There is no reading of § 8.2.13 under which automated sending is permitted. The
variable is enforcement, not permission.

**There is no sanctioned API for this.** No self-serve LinkedIn API sends
connection requests or cold direct messages. The partner messaging API is gated,
limited to existing connections and threads, and explicitly excludes automated or
scheduled sending. The only sanctioned route for messaging strangers at scale is
paid, clearly labelled advertising.

**Enforcement is real and current.** LinkedIn restricts accounts, and its own help
pages state that restrictions follow when many invitations go ignored or are
marked as spam, and when it "suspects the use of an automation tool." It does not
disclose the reason, support cannot shorten a restriction, and withdrawing
pending invitations does not lift one. Repeated temporary restrictions can become
permanent, and LinkedIn states that certain egregious violations can bring a
permanent restriction after a **single** incident — there is no documented
warning ladder to rely on.

LinkedIn has also acted against automation vendors themselves, including
litigation that ended with a vendor shutting down, and in one 2026 case deleting
a vendor's company page and restricting its executives' **personal** profiles.
Being a customer of a vendor is not insulation; one settlement required the
vendor to notify its own customers of the injunction.

**The cost lands on a person, not on software.** A restriction hits the
individual's account — their profile, their first-degree network, their message
history, a decade of professional capital that cannot be recreated or moved. That
person is you or a colleague, and this repo cannot protect them.

**What this project does about it.** The defaults are deliberately low, every
social action is approval-gated by [the send guard](../.claude/hooks/guard-send.mjs),
and nothing here operates your session automatically or handles your credentials.
Any figure in `limits` is a conservative guess, because **LinkedIn publishes no
invitation cap** — every number circulating online is vendor inference, not
policy. If you are restricted, stop; do not retry into it.

This project does not claim to be compliant with LinkedIn's terms, and you should
distrust any tool that does.

## Data protection in practice

Whatever regime applies to you, the mechanics are the same: know where the
personal data is, be able to find one person in it, and be able to delete or
suppress them quickly. This section is the concrete version for this repo.

### Where personal data lives

Four places, and you are responsible for all of them:

| Location | What it holds | Tracked by git? |
|---|---|---|
| `state/ledger.jsonl` | One line per person worked: identity key (LinkedIn URL or email), company, bucket, run id, and why they were selected. | No — `state/` is gitignored |
| `state/runs/*.json` | Full run reports: per-bucket candidate counts, skip reasons, and in a dry run **the complete text of every draft** — names, roles, researched facts, message bodies. | No |
| `do-not-contact.txt` | Email addresses, domains and profile URLs of people who asked not to be contacted. | No |
| Your CRM and outreach platform | The actual contact records, enrollments and sent messages. | Not this repo's storage |

The run reports are the richest and the most easily overlooked. A dry-run report
is effectively a small dossier on each person, and it is the file people are most
likely to paste into a ticket or a Slack thread. Do not.

Note that `do-not-contact.txt` deliberately lives **outside** `state/`, so that
clearing run state cannot resurrect someone who asked you to stop. That also
means a volume snapshot covering `state/` does not cover it — back it up
separately. See [security.md](security.md#state-files-contain-pii).

### Honouring an objection or a deletion request

When someone says stop — by reply, by clicking unsubscribe, or in person —
**suppress first, then clean up.** The order matters, because a deleted record
gets re-added by the next CRM sweep and a suppressed one does not.

1. **Add them to `do-not-contact.txt` immediately.** One line: their email
   address, or their profile URL, or their company's email domain if the request
   covers the whole organisation. Comments start with `#`; matching is
   case-insensitive.

   ```
   someone@example.com
   https://www.linkedin.com/in/some-profile/
   competitor.example.com
   ```

   This is the only step that is time-critical, and it is the one that must
   happen before the next scheduled run. **Add, never remove.**

2. **Mark them suppressed in your CRM and outreach platform**, and cancel any
   live enrollment or queued action. The `suppression` list in
   `config/tenant.yaml` checks for disqualified, bounced, unsubscribed and
   previously-cancelled rows, so a correctly-marked record stays out on its own.

3. **For an erasure request specifically, remove them from the local files too:**

   ```bash
   # Find every mention first — never delete blind.
   grep -rin "someone@example.com" state/ do-not-contact.txt

   # Remove their ledger lines (keep a backup until you have verified the result).
   cp state/ledger.jsonl state/ledger.jsonl.bak
   grep -iv "someone@example.com" state/ledger.jsonl > state/ledger.tmp \
     && mv state/ledger.tmp state/ledger.jsonl

   # Run reports need editing rather than line-deletion — they are JSON.
   grep -ril "someone@example.com" state/runs/
   ```

   **Keep them in `do-not-contact.txt`.** This is the one apparent contradiction
   worth understanding: an erasure request and a suppression list pull in
   opposite directions, and every major regulator resolves it the same way —
   retaining the minimum identifier needed to *ensure you do not contact someone
   again* is generally accepted, and often expected. Deleting them from the
   suppression list is how you end up contacting them again next quarter, which
   is a worse violation than the retention. If in doubt, ask your counsel; do not
   resolve it by emptying the file.

4. **Confirm to the person that you have done it**, and within whatever window
   your jurisdiction requires. See the sections above.

### Retention

The repo sets no retention policy, deletes nothing automatically, and will keep
run reports forever. That is a decision you have to make, not a default you can
inherit.

A defensible starting point:

- **Run reports** — keep 90 days. They are a QA and costing dataset, and their
  value decays fast. Rotate them:

  ```bash
  find state/runs -name '*.json' -mtime +90 -delete
  ```

- **The ledger** — keep at least as long as `dedupe.rework_cooldown_days`
  (default 30) plus your longest `limits.*_per_quarter` window, or dedupe and the
  per-quarter caps stop working. In practice that means about 12 months. Trimming
  it below the cooldown window silently re-enables double-contacting.
- **`do-not-contact.txt`** — indefinitely. See above.

Whatever you choose, write it down and automate it. A retention policy that
depends on someone remembering is not a retention policy.

### Transparency

You obtained this data from somewhere other than the person themselves —
research, enrichment providers, a purchased list, your CRM. That triggers a duty
to tell them, in most regimes, and it is the obligation people most often miss
because there is no obvious moment where it comes up.

The practical answer is `sender_identity.privacy_notice_url` in
`config/tenant.yaml`: a real page that says what data you hold, where you got it,
what you use it for, and how to object. Link it in the message. It costs you
nothing and it is the difference between a defensible position and an
indefensible one.

### Enrichment providers are processors

`SERPER_API_KEY` and `SCRAPECREATORS_API_KEY` send data to third parties on your
behalf, and the outreach platform's enrichment does the same. Those are
sub-processors in your compliance story: you need a lawful basis for the
disclosure, a data-processing agreement with each, and they belong on whatever
sub-processor list you publish. Both keys are optional — if you cannot account
for a provider, leave it unset and the run skips that signal and says so in the
report.



## Pre-launch checklist

Work through this before the first live run. Not after.

### Configuration

- [ ] `npm run preflight` is green, or the only remaining items are warnings you
      have consciously accepted.
- [ ] `run_mode: supervised`, with `caps.supervised_run_cap` small enough that
      you will genuinely read every draft.
- [ ] `providers.crm.customer_signal` names a **real** property from your CRM, and
      you have verified it actually identifies customers. Getting this wrong
      means prospecting people who already pay you.
- [ ] Every enabled `crm.list` bucket has a real list id, and you have opened
      that list and looked at who is in it.
- [ ] `approval_routing.owners[].provider_user_id` is set for every owner, and
      you have confirmed each id is the person you think it is.
- [ ] `excluded_domains` covers your own domains, your customers, your partners
      and your competitors.
- [ ] The reason-gate rules on the `target-accounts` bucket are intact.

### Compliance

- [ ] `sender_identity.legal_entity_name` and `postal_address` are filled in with
      a real, physical address.
- [ ] `sender_identity.unsubscribe_url` points at something that **works** — click
      it yourself — and you know who processes the resulting requests, and how
      fast.
- [ ] `sender_identity.privacy_notice_url` points at a published page that says
      what data you hold, where you got it, and how to object.
- [ ] `do-not-contact.txt` exists, is populated from any existing suppression
      list you already have, and is backed up somewhere that is not the container.
- [ ] You have decided which jurisdictions you will contact, and you know which
      of the sections above apply. If that includes the EU, the UK or Canada, you
      have taken advice rather than relying on this document.
- [ ] You have written down a retention period for `state/runs/` and the ledger,
      and automated it.
- [ ] You have a documented lawful basis if you are contacting anyone in the
      EU/UK, and an LIA on file if you are relying on legitimate interests.
- [ ] Every enrichment provider you have enabled has a data-processing agreement
      and appears on your sub-processor list.

### Deliverability

- [ ] SPF, DKIM and DMARC are configured and passing for the sending domain.
- [ ] The sending domain and mailbox are warmed. A new domain does not start at
      20 cold emails a day.
- [ ] `limits` are at or below the shipped defaults for the first month.
- [ ] You are monitoring bounce and complaint rates and know where to look.

### Operational

- [ ] You have run `npm run dry` and **read the drafts**, and would send each one
      under your own name.
- [ ] The person whose account sends these has personally read a sample and
      agreed. Do not volunteer a colleague's identity for this.
- [ ] `state/` is on durable storage with an absolute `STATE_DIR`, and you have
      verified the `report=` path in the run logs points there.
- [ ] The send guard (`.claude/hooks/guard-send.mjs`) and `.claude/settings.json`
      are unmodified. If you changed them, you know exactly what you changed and
      why.
- [ ] CRM write scopes are **not** granted, and `CRM_WRITES_ENABLED` is unset —
      unless you deliberately need logging and understand that HubSpot has no
      scope narrower than full contact write.
- [ ] Someone owns the approval queue daily and knows that bulk-approving without
      reading defeats the entire design.
- [ ] Someone owns replies. A reply that sits unanswered for a week is worse than
      never having sent the message.
- [ ] You know how to stop it: remove the cron schedule, or set `DRY_RUN=1`.



---

**Related:** [Configuration reference](configuration.md) ·
[Security](security.md) · [Deploy on Railway](deploy-railway.md) ·
[Deploy anywhere else](deploy-other.md) · [Upgrading](upgrading.md) ·
[README](../README.md)
