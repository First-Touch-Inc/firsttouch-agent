// The auto-learning pass: study the diffs between what the agent drafted and
// what humans actually approved, and distill PATTERNS into dated rules.
//
// The founder's requirement, verbatim: "go through actual approvals and check
// the differences of what users change so it auto learns."
//
// Why this is safe to run automatically:
//   - The inputs are exclusively HUMAN-TYPED text: edits made in the approval
//     modal and reasons typed into the deny modal, by allowlisted users.
//     Prospect-authored text (bios, notes, form fills) never enters this
//     pass, so injected content has no path to a rule.
//   - The model only PROPOSES rules, as structured JSON. Deterministic host
//     code decides what gets inserted (schema check, count caps), and the
//     ledger's lessons table is written by the host alone — the model has no
//     record_lesson tool in any mode.
//   - Every accepted rule is announced in Slack with its evidence, and
//     supersession (never deletion) is the undo.
//
// Patterns, not incidents: a one-off factual fix must not become a rule.
// That judgment lives in the prompt, and the minimum-sample gate below keeps
// the model from being asked to generalise from a single edit.

const MIN_SAMPLES = 3;      // fewer data points than this: wait for more
const MAX_RULES_PER_PASS = 5;
const VALID_SCOPES = ['voice', 'qualification', 'research', 'deal_judgment', 'cs'];

/** Collect the human-decision evidence newer than the watermark. */
export function collectEvidence(ledger, sinceRowid = 0) {
  const rows = ledger.db.prepare(`
    SELECT d.rowid AS rid, d.decision, d.edits, d.reason, w.kind, w.motion, w.payload
    FROM decisions d JOIN work_items w ON w.id = d.work_item_id
    WHERE d.rowid > ? AND (d.edits IS NOT NULL OR d.reason IS NOT NULL)
    ORDER BY d.rowid`).all(sinceRowid);

  const evidence = [];
  let maxRowid = sinceRowid;
  for (const row of rows) {
    maxRowid = Math.max(maxRowid, row.rid);
    const payload = JSON.parse(row.payload);
    if (row.edits) {
      const edits = JSON.parse(row.edits);
      const steps = payload.campaign?.steps ?? payload.steps ?? [];
      for (const [idx, edited] of Object.entries(edits)) {
        const original = steps[Number(idx)]?.copy ?? payload.body ?? '';
        if (original && edited && original !== edited) {
          evidence.push({ kind: 'edit', motion: row.motion, original, edited });
        }
      }
    }
    if (row.reason) {
      evidence.push({ kind: 'deny', motion: row.motion, reason: row.reason });
    }
  }
  return { evidence, maxRowid };
}

function buildPrompt(evidence) {
  return [
    `You are studying how a human team corrected an outbound agent's drafts, to distill durable rules.`,
    ``,
    `Below are ${evidence.length} corrections: "edit" entries show the agent's original copy and what`,
    `the human actually sent; "deny" entries are the reasons humans gave for refusing a draft.`,
    ``,
    `Extract PATTERNS ONLY — a rule must be something that would change the NEXT draft too:`,
    `- "in most edits the opener got shorter" is a rule; "they fixed Acme's employee count" is not.`,
    `- A situational or factual correction must NOT become a rule.`,
    `- Prefer few strong rules over many weak ones. At most ${MAX_RULES_PER_PASS}. Zero is a fine answer.`,
    ``,
    `Reply with ONLY a JSON array (no prose, no fences):`,
    `[{"scope": "voice|qualification|research|deal_judgment|cs",`,
    `  "rule": "<one imperative sentence>",`,
    `  "evidence": "<one sentence citing how many corrections show this>"}]`,
    ``,
    `The corrections:`,
    JSON.stringify(evidence, null, 1).slice(0, 30_000),
  ].join('\n');
}

function parseRules(text) {
  const match = String(text ?? '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((r) => r && typeof r.rule === 'string' && r.rule.trim()
      && VALID_SCOPES.includes(r.scope)
      && typeof r.evidence === 'string')
    .slice(0, MAX_RULES_PER_PASS);
}

/**
 * The full pass: collect → distill → insert → announce → advance watermark.
 * `queueSpawn` runs a model turn ({prompt, mode:'distill'} — no tools, no
 * credentials); `announce` posts one Slack line per accepted rule.
 */
export async function distillLessons({ ledger, cfg, queueSpawn, announce }) {
  const since = Number(ledger.getWatermark('agent', 'lessons_distilled_rowid') ?? 0);
  const { evidence, maxRowid } = collectEvidence(ledger, since);
  if (evidence.length < MIN_SAMPLES) return { distilled: 0, waiting: evidence.length };

  const res = await queueSpawn({ prompt: buildPrompt(evidence), mode: 'distill', timeoutMs: 5 * 60 * 1000 });
  if (res.error) throw new Error(res.error);

  const rules = parseRules(res.result);
  const inserted = [];
  for (const r of rules) {
    // Dedupe against active rules: an identical rule is not news.
    const active = ledger.activeLessons('agent');
    if (active.some((l) => l.rule.trim().toLowerCase() === r.rule.trim().toLowerCase())) continue;
    const id = ledger.addLesson({
      teammate: 'agent', scope: r.scope, rule: r.rule.trim(), evidence: r.evidence.trim(),
    });
    inserted.push({ id, ...r });
  }

  // The watermark advances even when nothing was distilled from this batch —
  // the same corrections must not be re-litigated every pass.
  ledger.setWatermark('agent', 'lessons_distilled_rowid', String(maxRowid));

  for (const r of inserted) {
    await announce(`📚 Learned [${r.scope}]: ${r.rule}\n> ${r.evidence} — say "drop that rule" to supersede it.`);
  }
  return { distilled: inserted.length, from: evidence.length };
}
