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

export function configPath(tenant = process.env.TENANT || 'tenant') {
  return join(ROOT, 'config', `${tenant}.yaml`);
}

/**
 * Load and validate a tenant config. Throws ConfigError listing EVERY problem
 * found, not just the first — a customer fixing their setup should get the
 * whole list in one pass rather than discovering it one run at a time.
 */
export function loadConfig(tenant = process.env.TENANT || 'tenant') {
  const path = configPath(tenant);

  if (!existsSync(path)) {
    throw new ConfigError([
      `No config at ${path}`,
      `Create one:  cp config/tenant.example.yaml config/${tenant}.yaml`,
      `Or let the setup agent interview you and write it:  claude /setup`,
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

  // --- caps -----------------------------------------------------------------
  const min = cfg.caps?.min_per_day;
  const max = cfg.caps?.max_per_day;
  if (!Number.isInteger(min) || min < 0) problems.push('caps.min_per_day must be a non-negative integer.');
  if (!Number.isInteger(max) || max < 1) problems.push('caps.max_per_day must be a positive integer.');
  if (Number.isInteger(min) && Number.isInteger(max) && min > max) {
    problems.push(`caps.min_per_day (${min}) cannot exceed caps.max_per_day (${max}).`);
  }
  if (!['supervised', 'daily'].includes(cfg.run_mode)) {
    problems.push('run_mode must be either "supervised" or "daily".');
  }

  need(cfg.icp, 'icp', 'Describe who you sell to, including who is NOT a fit.');

  // --- buckets --------------------------------------------------------------
  if (!Array.isArray(cfg.buckets) || cfg.buckets.length === 0) {
    problems.push('buckets must be a non-empty list.');
  } else {
    const enabled = cfg.buckets.filter((b) => b?.enabled);
    if (enabled.length === 0) {
      problems.push('No bucket is enabled, so the agent would have nothing to work. Enable at least one.');
    }
    const seen = new Set();
    for (const b of cfg.buckets) {
      const id = b?.id ?? '(unnamed)';
      if (isBlank(b?.id)) problems.push('Every bucket needs an id.');
      else if (seen.has(b.id)) problems.push(`Duplicate bucket id "${b.id}".`);
      else seen.add(b.id);

      if (!b?.enabled) continue; // only validate what will actually run

      if (!Number.isInteger(b.priority)) problems.push(`bucket "${id}": priority must be an integer (1 runs first).`);
      if (!Number.isInteger(b.daily_cap) || b.daily_cap < 1) problems.push(`bucket "${id}": daily_cap must be a positive integer.`);
      if (isBlank(b.play)) problems.push(`bucket "${id}": play is required.`);
      if (isBlank(b.source?.type)) problems.push(`bucket "${id}": source.type is required.`);

      // A placeholder list id is the single most likely misconfiguration, and
      // the failure mode is working the wrong list of humans.
      if (b.allow_open_deals !== undefined && typeof b.allow_open_deals !== 'boolean') {
        problems.push(`bucket "${id}": allow_open_deals must be true or false.`);
      }
      if (b.source?.type === 'crm.list' && isBlank(b.source?.list_id)) {
        problems.push(
          `bucket "${id}": source.list_id is still a placeholder. ` +
          `Put your real CRM list id here, or set enabled: false.`,
        );
      }
    }
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
  }

  // --- suppression ----------------------------------------------------------
  if (!Array.isArray(cfg.suppression) || cfg.suppression.length === 0) {
    problems.push('suppression must list at least one check. Removing all of them means prospecting your own customers.');
  }
  if (cfg.dedupe && !Number.isInteger(cfg.dedupe.rework_cooldown_days)) {
    problems.push('dedupe.rework_cooldown_days must be an integer number of days.');
  }

  if (problems.length) throw new ConfigError(problems);

  // Normalise a few derived values so callers never re-derive them.
  cfg.__meta = {
    tenant,
    path,
    stateDir: resolveStateDir(),
    voicePackPath: cfg.voice_pack
      ? (isAbsolute(cfg.voice_pack) ? cfg.voice_pack : join(ROOT, cfg.voice_pack))
      : null,
    plays: resolvePlays(cfg),
    effectiveCap: cfg.run_mode === 'supervised'
      ? (cfg.caps?.supervised_run_cap ?? 3)
      : cfg.caps.max_per_day,
  };
  return cfg;
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
  const shipped = join(ROOT, '.claude', 'skills', 'pipeline-agent', 'plays.md');
  const out = { shipped, custom: [], problems: [] };

  const raw = cfg.extra_plays;
  if (isBlank(raw)) return out;

  const p = isAbsolute(raw) ? raw : join(ROOT, raw);

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

  const model = has('ANTHROPIC_API_KEY') || has('CLAUDE_CODE_OAUTH_TOKEN');
  checks.push({
    key: 'model access',
    ok: model,
    fatal: true,
    detail: model
      ? (has('ANTHROPIC_API_KEY') ? 'ANTHROPIC_API_KEY is set' : 'CLAUDE_CODE_OAUTH_TOKEN is set')
      : 'Set ANTHROPIC_API_KEY (pay-as-you-go) or CLAUDE_CODE_OAUTH_TOKEN (existing Claude subscription). See .env.example.',
  });

  checks.push({
    key: 'outreach platform',
    ok: has('FT_MCP_TOKEN'),
    // In a dry run nothing is created, so the agent can research and draft
    // without platform credentials. Anywhere else this is fatal.
    fatal: !dryRun,
    detail: has('FT_MCP_TOKEN')
      ? 'FT_MCP_TOKEN is set'
      : 'FT_MCP_TOKEN is not set. Required to create approval-gated actions.'
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
    key: 'Slack chat (Socket Mode)',
    ok: has('SLACK_APP_TOKEN') && has('SLACK_BOT_TOKEN'),
    fatal: false,
    detail: has('SLACK_APP_TOKEN')
      ? (has('SLACK_BOT_TOKEN') ? 'SLACK_APP_TOKEN and SLACK_BOT_TOKEN are set' : 'SLACK_APP_TOKEN is set but SLACK_BOT_TOKEN is not — chat needs both.')
      : 'SLACK_APP_TOKEN not set. Only needed for `npm run chat`; the scheduled run does not use it.',
  });

  checks.push({
    key: 'Slack digest',
    ok: has('SLACK_BOT_TOKEN'),
    fatal: false,
    detail: has('SLACK_BOT_TOKEN')
      ? 'SLACK_BOT_TOKEN is set'
      : 'Not set. The digest is skipped; approvals still land in the platform queue.',
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
