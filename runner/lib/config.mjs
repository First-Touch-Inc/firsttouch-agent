// Config loading and validation.
//
// Design rule for this whole file: NO SILENT DEFAULTS for anything tenant-
// specific. A missing owner id or list id must fail loudly here, at load time,
// rather than fall back to something plausible and send outreach from the wrong
// account or to the wrong list. Defaults are only allowed for things that are
// genuinely universal (a cooldown window, a word cap).
//
// This is the lesson from the system this repo was extracted from: every
// `|| '<some literal>'` fallback in that codebase was a place where a
// misconfigured run silently did the wrong thing instead of stopping.
//
// Onboarding writes config through the exact same validator. If a value would
// be rejected here when hand-written, the onboarding conversation cannot
// produce it either.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class ConfigError extends Error {
  constructor(problems) {
    super(`Configuration is not valid:\n\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const PLACEHOLDER = /^<.*>$/;
const isBlank = (v) => v === undefined || v === null || v === '' ||
  (typeof v === 'string' && (PLACEHOLDER.test(v.trim()) || v.trim() === ''));

export const MOTION_KINDS = ['outbound', 'inbound', 'deal_followup', 'cs_postclose'];

// A five-field cron line. This is deliberately shallow — it catches "8am" and
// "" and a pasted timezone, not every invalid cron. The scheduler validates
// fully when it parses; this stops the obviously wrong thing at load time.
const CRON_SHAPE = /^\S+ \S+ \S+ \S+ \S+$/;

/** Where tenant-owned files live. In the container this is /data/config (the
 *  writable volume); the repo's own config/ is the dev default. The split is
 *  load-bearing: the engine ships read-only, the tenant's world is writable —
 *  a read-only config dir would silently break set_config and onboarding. */
export function configDir() {
  const dir = process.env.CONFIG_DIR || join(ROOT, 'config');
  return isAbsolute(dir) ? dir : resolve(ROOT, dir);
}

/** Resolve a config-declared path: absolute stays; a "config/…" prefix means
 *  the tenant dir (wherever that is); anything else is repo-relative. */
export function resolveTenantPath(p) {
  if (isBlank(p)) return null;
  if (isAbsolute(p)) return p;
  if (/^config[\/]/.test(p)) return join(configDir(), p.replace(/^config[\/]/, ''));
  return join(ROOT, p);
}

/**
 * The model every session runs on.
 *
 * Pinned by the engine rather than inherited from whatever `claude` defaults to
 * on the machine, so a run behaves the same for everyone who clones this repo.
 * The work is judgement-heavy — whether a signal is a real reason to reach out,
 * and copy a person would actually reply to — and a weaker model does not fail
 * loudly, it just drafts worse, which shows up in reply rates weeks later.
 */
export const AGENT_MODEL = process.env.AGENT_MODEL || 'claude-opus-5';

export function configPath(name = process.env.AGENT_CONFIG || 'agent') {
  return join(configDir(), `${name}.yaml`);
}

/**
 * Load and validate the agent config. Throws ConfigError listing EVERY problem
 * found, not just the first — a customer fixing their setup should get the
 * whole list in one pass rather than discovering it one run at a time.
 */
export function loadConfig(name = process.env.AGENT_CONFIG || 'agent') {
  const path = configPath(name);

  if (!existsSync(path)) {
    throw new ConfigError([
      `No config at ${path}`,
      `Create one:  cp config/agent.example.yaml config/${name}.yaml`,
      `Or let the agent interview you and write it: DM the bot after bootstrap.`,
    ]);
  }

  let cfg;
  try {
    cfg = load(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError([`${path} is not valid YAML: ${e.message}`]);
  }
  if (!cfg || typeof cfg !== 'object') {
    throw new ConfigError([`${path} is empty or is not a YAML mapping.`]);
  }

  const problems = validateConfig(cfg);
  if (problems.length) throw new ConfigError(problems);

  // Normalise a few derived values so callers never re-derive them.
  cfg.__meta = {
    name,
    path,
    stateDir: resolveStateDir(),
    voicePackPath: resolveTenantPath(cfg.voice_pack),
    plays: resolvePlays(cfg),
    // The ledger MUST land on the writable volume (STATE_DIR), not under the
    // read-only engine tree. A "state/…" prefix is resolved against STATE_DIR
    // so the documented default lands on the volume in a container instead of
    // at /app/state where SQLite cannot create the file.
    ledgerPath: isAbsolute(cfg.state.ledger)
      ? cfg.state.ledger
      : join(resolveStateDir(), String(cfg.state.ledger).replace(/^state[\/]/, '')),
    enabledMotions: (cfg.motions || []).filter((m) => m?.enabled),
  };
  return cfg;
}

/**
 * The config a host runs on when there is NO config file yet.
 *
 * A brand-new install has nothing to load, and the agent's whole answer to that
 * is "DM me and I'll interview you and write it". That answer was unreachable:
 * the host exited on the missing file before Slack ever connected, so the
 * onboarding conversation could not happen. This is the minimum that lets the
 * host connect, bind an operator, and run an onboarding session — nothing more.
 *
 * Deliberately NOT a set of working defaults. There are no motions, no
 * approvals channel and no owners, so nothing can run or send; the tick loop
 * skips entirely while __bootstrap is set. The only useful thing a bootstrap
 * host can do is talk to you, which is exactly the point.
 *
 * A config that exists but is INVALID still fails hard — booting a half-broken
 * tenant on empty defaults would be far worse than refusing to start.
 */
export function bootstrapConfig(name = process.env.AGENT_CONFIG || 'agent') {
  const cfg = {
    motions: [],
    owners: [],
    approval: {},
    chat: {},
    slack: {},
    state: { ledger: 'state/ledger.db' },
    voice_pack: null,
  };
  cfg.__meta = {
    name,
    path: configPath(name),
    stateDir: resolveStateDir(),
    voicePackPath: null,
    plays: [],
    ledgerPath: join(resolveStateDir(), 'ledger.db'),
    enabledMotions: [],
  };
  cfg.__bootstrap = true;
  return cfg;
}

/**
 * Pure validation: returns the list of problems (empty = valid). Split out from
 * loadConfig so onboarding's set_config can validate a candidate BEFORE writing
 * it, against exactly the rules a hand-edit would face.
 */
export function validateConfig(cfg) {
  const problems = [];
  const need = (value, where, hint) => {
    if (isBlank(value)) problems.push(`${where} is required. ${hint}`);
  };

  // --- client ---------------------------------------------------------------
  need(cfg.client?.name, 'client.name', 'The team this agent works for.');
  need(cfg.client?.timezone, 'client.timezone', 'An IANA name like "America/New_York".');
  if (!isBlank(cfg.client?.timezone)) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: cfg.client.timezone });
    } catch {
      problems.push(`client.timezone "${cfg.client.timezone}" is not a valid IANA timezone.`);
    }
  }

  need(cfg.icp, 'icp', 'Describe who you sell to, including who is NOT a fit.');

  if (!['supervised', 'daily'].includes(cfg.run_mode)) {
    problems.push('run_mode must be either "supervised" or "daily".');
  }

  // --- providers ------------------------------------------------------------
  const IMPLEMENTED_OUTREACH = ['firsttouch'];
  const IMPLEMENTED_CRM = ['hubspot'];
  const outreach = cfg.providers?.outreach?.kind;
  const crm = cfg.providers?.crm?.kind;

  if (isBlank(outreach)) {
    problems.push(`providers.outreach.kind is required. Implemented: ${IMPLEMENTED_OUTREACH.join(', ')}.`);
  } else if (!IMPLEMENTED_OUTREACH.includes(outreach)) {
    problems.push(
      `providers.outreach.kind "${outreach}" has no adapter in this repo. ` +
      `Implemented: ${IMPLEMENTED_OUTREACH.join(', ')}. See docs/providers.md to add one.`,
    );
  }
  if (isBlank(crm)) {
    problems.push(`providers.crm.kind is required. Implemented: ${IMPLEMENTED_CRM.join(', ')}.`);
  } else if (!IMPLEMENTED_CRM.includes(crm)) {
    problems.push(
      `providers.crm.kind "${crm}" has no adapter in this repo. ` +
      `Implemented: ${IMPLEMENTED_CRM.join(', ')}. See docs/providers.md to add one.`,
    );
  }

  // The customer-suppression signal has no safe default. Getting this wrong
  // means prospecting your own paying customers, so an unconfigured signal is
  // an error rather than a warning.
  const signals = cfg.providers?.crm?.customer_signal;
  if (!Array.isArray(signals) || signals.length === 0 || signals.every((s) => isBlank(s?.property))) {
    problems.push(
      'providers.crm.customer_signal needs at least one entry with a real CRM property name. ' +
      'This is how the agent recognises an existing customer so it never prospects one. ' +
      'There is no safe default — it must be a property from YOUR CRM.',
    );
  }

  // --- motions --------------------------------------------------------------
  if (!Array.isArray(cfg.motions) || cfg.motions.length === 0) {
    problems.push('motions must be a non-empty list. See config/agent.example.yaml for the four kinds.');
  } else {
    const enabled = cfg.motions.filter((m) => m?.enabled);
    if (enabled.length === 0) {
      problems.push('No motion is enabled, so the agent would have nothing to do. Enable at least one.');
    }
    const seen = new Set();
    for (const m of cfg.motions) {
      const id = m?.id ?? '(unnamed)';
      if (isBlank(m?.id)) problems.push('Every motion needs an id.');
      else if (seen.has(m.id)) problems.push(`Duplicate motion id "${m.id}".`);
      else seen.add(m.id);

      if (!MOTION_KINDS.includes(m?.kind)) {
        problems.push(`motion "${id}": kind must be one of ${MOTION_KINDS.join(' | ')}.`);
      }

      if (!m?.enabled) continue; // only validate what will actually run

      if (isBlank(m.schedule) || !CRON_SHAPE.test(String(m.schedule).trim())) {
        problems.push(`motion "${id}": schedule must be a five-field cron line (e.g. "0 8 * * 1-5").`);
      }
      if (isBlank(m.play)) problems.push(`motion "${id}": play is required.`);

      switch (m.kind) {
        case 'outbound': {
          if (!Number.isInteger(m.daily_cap) || m.daily_cap < 1) {
            problems.push(`motion "${id}": daily_cap must be a positive integer.`);
          }
          if (m.allow_open_deals !== undefined && typeof m.allow_open_deals !== 'boolean') {
            problems.push(`motion "${id}": allow_open_deals must be true or false.`);
          }
          if (!Array.isArray(m.sources) || m.sources.length === 0) {
            problems.push(`motion "${id}": sources must be a non-empty list, warmest first.`);
          }
          break;
        }
        case 'inbound': {
          if (!Array.isArray(m.sources) || m.sources.length === 0) {
            problems.push(`motion "${id}": sources must list the hand-raise source(s).`);
          }
          break;
        }
        case 'deal_followup': {
          need(m.pipeline_id, `motion "${id}": pipeline_id`, 'Which CRM pipeline it works.');
          if (!Number.isInteger(m.stall_days) || m.stall_days < 1) {
            problems.push(`motion "${id}": stall_days must be a positive integer.`);
          }
          // The change allowlist IS the permission: a field not listed cannot
          // even be proposed, let alone applied.
          if (!Array.isArray(m.crm_fields_may_change) || m.crm_fields_may_change.length === 0) {
            problems.push(
              `motion "${id}": crm_fields_may_change must list the CRM properties this motion ` +
              `may propose changing. An empty list means it can propose nothing — disable the ` +
              `motion instead.`,
            );
          }
          if (m.evening_schedule !== undefined &&
              (isBlank(m.evening_schedule) || !CRON_SHAPE.test(String(m.evening_schedule).trim()))) {
            problems.push(`motion "${id}": evening_schedule must be a five-field cron line if set.`);
          }
          break;
        }
        case 'cs_postclose': {
          need(m.owner_match, `motion "${id}": owner_match`, 'How cards route to the CS owner.');
          need(m.dashboard?.base_url, `motion "${id}": dashboard.base_url`, 'The CS data source.');
          // Liveness is not identity: a stale host answering ok:true swallowed
          // work in production. The identity string is asserted on every read.
          need(m.dashboard?.identity, `motion "${id}": dashboard.identity`,
            'The service identity string asserted on every read — a health check that only ' +
            'proves SOMETHING answered is how cards vanished in production.');
          break;
        }
      }

      // Placeholder list ids are the single most likely misconfiguration, and
      // the failure mode is working the wrong list of humans.
      for (const s of m.sources || []) {
        if (s?.type === 'crm.list' && isBlank(s?.list_id)) {
          problems.push(
            `motion "${id}": a crm.list source has a placeholder list_id. ` +
            `Put your real CRM list id there, or remove the source.`,
          );
        }
      }
    }
  }

  // --- approval -------------------------------------------------------------
  // Cards route BY OWNER (each owner's slack_channel below), because only the
  // person a message sends as may approve it. The digest channel is for run
  // digests and report-only cards, which have no sender.
  if (cfg.approval !== undefined) {
    if (isBlank(cfg.approval.digest_channel) || !/^C[A-Z0-9]{6,}$/i.test(String(cfg.approval.digest_channel))) {
      problems.push('approval.digest_channel must be a Slack channel ID (Cxxxxxxxx), not a #name.');
    }
    const undo = cfg.approval.undo_seconds;
    if (!Number.isInteger(undo) || undo < 10 || undo > 300) {
      problems.push('approval.undo_seconds must be an integer between 10 and 300.');
    }
    const exp = cfg.approval.expiry_hours;
    if (!Number.isInteger(exp) || exp < 1) {
      problems.push('approval.expiry_hours must be a positive integer. Expired cards are NEVER applied late.');
    }
  } else {
    problems.push('approval is required: digest_channel, undo_seconds, expiry_hours.');
  }

  // --- ownership ------------------------------------------------------------
  // The highest-consequence section. An action created without an explicit
  // owner is assigned to whoever the API token authenticates as, which means an
  // approved draft sends from the wrong person's account — and that cannot be
  // undone after the fact.
  const owners = cfg.approval_routing?.owners;
  if (!Array.isArray(owners) || owners.length === 0) {
    problems.push('approval_routing.owners must list at least one owner. Every action must have an explicit sender.');
  } else {
    const defaults = owners.filter((o) => o?.match === 'default');
    if (defaults.length === 0) problems.push('Exactly one owner needs `match: default`. None has it.');
    if (defaults.length > 1) {
      problems.push(`Exactly one owner may have \`match: default\`; found ${defaults.length}: ${defaults.map((o) => o.id).join(', ')}.`);
    }
    const ids = new Set();
    for (const o of owners) {
      const id = o?.id ?? '(unnamed)';
      if (isBlank(o?.id)) problems.push('Every owner needs an id.');
      else if (ids.has(o.id)) problems.push(`Duplicate owner id "${o.id}".`);
      else ids.add(o.id);

      need(o?.name, `owner "${id}": name`, 'Used in the digest.');
      if (isBlank(o?.provider_user_id)) {
        problems.push(
          `owner "${id}": provider_user_id is required. This decides WHOSE ACCOUNT the ` +
          `message sends from. Without it the platform assigns the action to the ` +
          `authenticated API user, which sends one person's outreach from another ` +
          `person's account — and that is not reversible.`,
        );
      }
      if (!isBlank(o?.slack_user_id) && !/^U[A-Z0-9]{6,}$/i.test(String(o.slack_user_id))) {
        problems.push(`owner "${id}": slack_user_id "${o.slack_user_id}" is not a Slack user ID (Uxxxxxxxx).`);
      }
      // Each owner's channel is their inbox of pending sends. Without one,
      // their cards have nowhere to land — routing to a shared default would
      // quietly bury one person's approvals in someone else's channel.
      if (isBlank(o?.slack_channel) || !/^C[A-Z0-9]{6,}$/i.test(String(o.slack_channel))) {
        problems.push(
          `owner "${id}": slack_channel must be a Slack channel ID (Cxxxxxxxx) — ` +
          `their approvals channel, where every card that sends as them lands.`,
        );
      }
    }
  }

  // --- limits (enforced against the ledger, so they must be real numbers) ---
  if (!cfg.limits || typeof cfg.limits !== 'object') {
    problems.push('limits is required: per_day, per_week, per_contact_per_quarter, per_company_per_quarter, enrichment_credits_per_run.');
  } else {
    for (const key of ['per_day', 'per_week', 'per_contact_per_quarter',
                       'per_company_per_quarter', 'enrichment_credits_per_run']) {
      const v = cfg.limits[key];
      if (!Number.isInteger(v) || v < 1) {
        problems.push(`limits.${key} must be a positive integer. These are enforced in code — a blank is not "unlimited", it is invalid.`);
      }
    }
    if (Number.isInteger(cfg.limits.per_day) && Number.isInteger(cfg.limits.per_week) &&
        cfg.limits.per_day > cfg.limits.per_week) {
      problems.push(`limits.per_day (${cfg.limits.per_day}) cannot exceed limits.per_week (${cfg.limits.per_week}).`);
    }
  }

  // --- suppression ----------------------------------------------------------
  if (!Array.isArray(cfg.suppression) || cfg.suppression.length === 0) {
    problems.push('suppression must list at least one check. Removing all of them means prospecting your own customers.');
  }

  if (cfg.dedupe && !Number.isInteger(cfg.dedupe.rework_cooldown_days)) {
    problems.push('dedupe.rework_cooldown_days must be an integer number of days.');
  }

  // --- flows ----------------------------------------------------------------
  // The allowlist IS the permission. Empty is valid and means "no flows" —
  // but a listed flow must be a real one, not a placeholder.
  if (cfg.flows !== undefined) {
    if (!Array.isArray(cfg.flows)) {
      problems.push('flows must be a list (empty means the agent may enrol into no flows).');
    } else {
      for (const f of cfg.flows) {
        if (isBlank(f?.id)) problems.push('Every entry in flows needs a real id — the allowlist is the permission.');
        if (isBlank(f?.name)) problems.push(`flow "${f?.id ?? '?'}": name is required; it is shown on enrolment cards.`);
      }
    }
  }

  // --- chat -----------------------------------------------------------------
  // Only validated when enabled. The failure that matters is an enabled chat
  // agent with an empty allowlist, which would answer anyone who finds the
  // channel — so that is an error, never a permissive default.
  if (cfg.chat?.enabled) {
    const users = cfg.chat.allowed_users;
    if (!Array.isArray(users) || users.filter((u) => !isBlank(u)).length === 0) {
      problems.push(
        'chat.enabled is true but chat.allowed_users is empty. An empty allowlist means ' +
        'nobody, and the agent refuses to start rather than answering whoever finds the ' +
        'channel. Add the Slack user IDs (Uxxxxxxxx) who may talk to it.',
      );
    }
    for (const u of users || []) {
      if (!isBlank(u) && !/^U[A-Z0-9]{6,}$/i.test(String(u))) {
        problems.push(`chat.allowed_users entry "${u}" is not a Slack user ID. Use the Uxxxxxxxx form, not a display name.`);
      }
    }
    for (const c of cfg.chat.allowed_channels || []) {
      if (!isBlank(c) && !/^[CGD][A-Z0-9]{6,}$/i.test(String(c))) {
        problems.push(`chat.allowed_channels entry "${c}" is not a Slack channel ID. Use the Cxxxxxxxx form, not #name.`);
      }
    }
    if (cfg.chat.campaigns_enabled !== undefined && typeof cfg.chat.campaigns_enabled !== 'boolean') {
      problems.push('chat.campaigns_enabled must be true or false.');
    }
  }

  // --- external tools ---------------------------------------------------------
  // Any MCP server the tenant wants the agent to use — Clay, Apollo, Gong,
  // an internal API, whatever. Proxied THROUGH the agent tool server, so the
  // model never holds the token and only the explicitly allowed tools exist.
  // The allowlist is the permission, and it is operator-written config: the
  // agent's own set_config refuses URLs, so a chat message (or injected text)
  // can never mount a new tool source.
  if (cfg.external_tools !== undefined) {
    if (!Array.isArray(cfg.external_tools)) {
      problems.push('external_tools must be a list.');
    } else {
      const names = new Set();
      // External tools bypass the approval loop, so v1 allows READ tools only.
      // A denylist of mutating verbs fails OPEN — an unlisted verb like
      // place_order or charge_card slips through. So this is an ALLOWLIST that
      // fails CLOSED: a tool is permitted only if its FIRST word is a known
      // read verb. Anything else — including any ambiguous name — is refused
      // with a message telling the operator to confirm it is read-only.
      const READ_VERBS = new Set([
        'get', 'list', 'search', 'find', 'lookup', 'read', 'fetch', 'query',
        'preview', 'check', 'count', 'show', 'describe', 'enrich', 'resolve',
        'view', 'scan', 'inspect', 'summarize', 'summarise', 'analyze', 'analyse',
        'match', 'discover', 'export', 'download',
      ]);
      const words = (name) => String(name)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const isReadOnly = (name) => {
        const w = words(name);
        return w.length > 0 && READ_VERBS.has(w[0]);
      };
      for (const t of cfg.external_tools) {
        const name = t?.name ?? '(unnamed)';
        if (!/^[a-z][a-z0-9_]{0,30}$/.test(String(t?.name ?? ''))) {
          problems.push(`external_tools "${name}": name must be a short lowercase slug (it namespaces the tools as ext_<name>_*).`);
        } else if (names.has(t.name)) {
          problems.push(`external_tools: duplicate name "${t.name}".`);
        } else names.add(t.name);

        if (isBlank(t?.url) || !/^https:\/\//.test(String(t.url))) {
          problems.push(`external_tools "${name}": url must be an https:// MCP endpoint.`);
        }
        if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(String(t?.token_env ?? ''))) {
          problems.push(
            `external_tools "${name}": token_env must be the NAME of an environment variable ` +
            `(like CLAY_MCP_TOKEN), never the token itself — secrets do not belong in config.`,
          );
        }
        if (!Array.isArray(t?.allow) || t.allow.length === 0 || t.allow.some((a) => isBlank(a))) {
          problems.push(
            `external_tools "${name}": allow must explicitly list the tool names the agent may ` +
            `call. There is no wildcard — the allowlist IS the permission.`,
          );
        } else {
          // v1: external tools are READ-ONLY. They bypass this agent's approval
          // loop, owner routing and suppression/caps entirely, so a mutating
          // external tool is an unreviewed send. A name is allowed only if it
          // begins with a known READ verb — this fails CLOSED, so an unknown or
          // ambiguous name (place_order, charge_card, foo) is refused rather
          // than assumed safe.
          for (const toolName of t.allow) {
            if (!isReadOnly(toolName)) {
              problems.push(
                `external_tools "${name}": tool "${toolName}" is not recognisably a read tool ` +
                `(its name must start with a read verb like get/list/search/find/read/query/` +
                `preview/enrich). External tools bypass this agent's approval loop, so v1 allows ` +
                `READ tools only — rename it if it is a read, or act through a play and the ` +
                `agent's own approval-gated tools instead of a raw external call.`,
              );
            }
          }
        }
      }
    }
  }

  // --- slack operator ---------------------------------------------------------
  // Bound by claim code at first boot; required thereafter. Onboarding and
  // set_config refuse to change it — only the claim flow writes it.
  if (!isBlank(cfg.slack?.operator) && !/^U[A-Z0-9]{6,}$/i.test(String(cfg.slack.operator))) {
    problems.push(`slack.operator "${cfg.slack.operator}" is not a Slack user ID (Uxxxxxxxx).`);
  }

  // --- state ----------------------------------------------------------------
  // One database, not a directory of JSONL files. Lessons live IN the ledger
  // (a table, host-written), so there is deliberately no state.lessons key —
  // a config carrying one is from the old schema and should fail loudly.
  if (isBlank(cfg.state?.ledger)) {
    problems.push('state.ledger is required — the SQLite database holding identity, decisions, caps and lessons. Use "state/ledger.db".');
  }
  if (!isBlank(cfg.state?.lessons)) {
    problems.push(
      'state.lessons is no longer a file — lessons live in the ledger database, written only ' +
      'by the host. Remove the state.lessons key.',
    );
  }

  return problems;
}

/**
 * Resolve the play catalogue: the shipped one, plus any plays the tenant added.
 *
 * `extra_plays` may point at a single Markdown file OR a directory of them. A
 * directory is the interesting case: it is how a customer adds a play we never
 * shipped without touching `.claude/skills/` or `runner/`, which is what keeps
 * their fork mergeable with upstream forever.
 *
 * This used to be documented and then silently ignored — the loader never read
 * the key, so a customer could point it anywhere and get no play and no error.
 * A customization surface that fails silently is worse than not having one.
 */
export function resolvePlays(cfg) {
  const shipped = join(ROOT, '.claude', 'skills', 'firsttouch-agent', 'plays.md');
  const out = { shipped, custom: [], problems: [] };

  const raw = cfg.extra_plays;
  if (isBlank(raw)) return out;

  const p = resolveTenantPath(raw);

  // Pointing at the shipped catalogue is the default and means "no extras".
  if (resolve(p) === resolve(shipped)) return out;

  if (!existsSync(p)) {
    out.problems.push(
      `extra_plays points at "${raw}", which does not exist. ` +
      `Create it, or remove the key to use only the shipped plays.`,
    );
    return out;
  }

  let stat;
  try {
    stat = statSync(p);
  } catch (e) {
    out.problems.push(`extra_plays "${raw}" could not be read: ${e.message}`);
    return out;
  }

  if (stat.isFile()) {
    out.custom.push(p);
    return out;
  }

  const entries = readdirSync(p)
    .filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort()
    .map((f) => join(p, f));

  if (entries.length === 0) {
    // Not an error: an empty overlay directory is a perfectly reasonable
    // starting state, and failing here would block a fresh setup.
    out.problems.push(
      `extra_plays directory "${raw}" contains no .md play files yet — using only the shipped plays.`,
    );
    return out;
  }
  out.custom.push(...entries);
  return out;
}

export function resolveStateDir() {
  const dir = process.env.STATE_DIR || join(ROOT, 'state');
  return isAbsolute(dir) ? dir : resolve(ROOT, dir);
}

/**
 * Which credentials are present. Returns a structured report rather than
 * throwing, so `preflight` can show the whole picture and the runner can decide
 * what is fatal for the mode it is running in.
 */
export function checkEnvironment({ dryRun = false } = {}) {
  const has = (k) => !isBlank(process.env[k]);
  const checks = [];

  // Neither variable being set is NOT an error on a workstation: the `claude`
  // CLI falls back to its own stored login, which is how most people run this
  // locally. A container has no interactive login and does need one of these,
  // which is what the message says. Whether auth actually WORKS is proven by
  // the live round trip in preflight — a token being present never meant it
  // was valid, and an expired one silently overrides a good CLI session.
  const model = has('ANTHROPIC_API_KEY') || has('CLAUDE_CODE_OAUTH_TOKEN');
  checks.push({
    key: 'model access',
    ok: true,
    fatal: false,
    detail: model
      ? (has('ANTHROPIC_API_KEY') ? 'ANTHROPIC_API_KEY is set' : 'CLAUDE_CODE_OAUTH_TOKEN is set')
      : 'no token set — the claude CLI will use its own login. Fine locally; a container needs '
        + 'CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (pay-as-you-go).',
  });

  // Setting both is a real footgun: the API key silently takes precedence, so
  // a customer who thinks they are on their subscription is being billed per
  // token. Refuse to guess which one they meant.
  if (has('ANTHROPIC_API_KEY') && has('CLAUDE_CODE_OAUTH_TOKEN')) {
    checks.push({
      key: 'model access (ambiguous)',
      ok: false,
      fatal: true,
      detail: 'BOTH ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set. The API key wins ' +
        'and bills per token even though the subscription token is present. Unset one.',
    });
  }

  // FirstTouch auth is EITHER a static token OR a stored OAuth grant that the
  // agent refreshes itself. Checked without importing ft-auth (which imports
  // this module) — a token file with a refresh_token is the OAuth signal.
  const ftOauthFile = process.env.FT_OAUTH_FILE
    || join(resolveStateDir(), 'ft-oauth.json');
  let ftOauth = false;
  try {
    if (existsSync(ftOauthFile)) {
      const j = JSON.parse(readFileSync(ftOauthFile, 'utf8'));
      ftOauth = Boolean(j.refresh_token || (j.access_token && Date.now() < (j.expires_at || 0)));
    }
  } catch { ftOauth = false; }
  if (!ftOauth && process.env.FT_OAUTH_SEED) ftOauth = true; // hydrates on first boot

  checks.push({
    key: 'outreach platform',
    ok: has('FT_MCP_TOKEN') || ftOauth,
    // In a dry run nothing is created, so the agent can research and draft
    // without platform credentials. Anywhere else this is fatal.
    fatal: !dryRun,
    detail: has('FT_MCP_TOKEN') ? 'FT_MCP_TOKEN is set (static token)'
      : ftOauth ? `FirstTouch OAuth token present (${ftOauthFile}) — the agent refreshes it itself`
      : 'FirstTouch is not connected. Run `npm run ft-auth` once to authorize, or set FT_MCP_TOKEN.'
        + (dryRun ? ' Not fatal in a dry run — nothing will be created.' : ''),
  });

  checks.push({
    key: 'CRM',
    ok: has('HUBSPOT_ACCESS_TOKEN'),
    fatal: !dryRun,
    detail: has('HUBSPOT_ACCESS_TOKEN')
      ? 'HUBSPOT_ACCESS_TOKEN is set'
      : 'HUBSPOT_ACCESS_TOKEN is not set. Required to read lists, contacts and ownership.',
  });

  checks.push({
    key: 'Slack (Socket Mode)',
    ok: has('SLACK_APP_TOKEN') && has('SLACK_BOT_TOKEN'),
    fatal: false,
    detail: has('SLACK_APP_TOKEN')
      ? (has('SLACK_BOT_TOKEN') ? 'SLACK_APP_TOKEN and SLACK_BOT_TOKEN are set' : 'SLACK_APP_TOKEN is set but SLACK_BOT_TOKEN is not — the host needs both.')
      : 'SLACK_APP_TOKEN not set. The host needs it for approvals and chat.',
  });

  for (const [key, label] of [['SERPER_API_KEY', 'web search'], ['SCRAPECREATORS_API_KEY', 'ad-library signal']]) {
    checks.push({
      key: `optional: ${label}`,
      ok: has(key),
      fatal: false,
      detail: has(key) ? `${key} is set` : `${key} not set — this signal is skipped.`,
    });
  }

  return {
    checks,
    ok: checks.filter((c) => c.fatal).every((c) => c.ok),
  };
}
