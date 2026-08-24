#!/usr/bin/env node
// Preflight — check the setup before it touches a real person.
//
//   npm run preflight
//
// Validates the config, reports which credentials are present, and (unless
// --offline) makes one cheap read-only call to each connected service to prove
// the token actually works. It creates nothing and sends nothing.
//
// Run this after `/setup`, after any config edit, and as the first thing you do
// when a scheduled run misbehaves.

import { loadConfig, checkEnvironment, ConfigError, configPath, resolveStateDir } from './lib/config.mjs';
import { existsSync, accessSync, constants, mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const offline = argv.includes('--offline');
const tenant = (() => {
  const i = argv.indexOf('--tenant');
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : (process.env.TENANT || 'tenant');
})();

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const pass = (m, d) => console.log(`  ${GREEN}PASS${RESET}  ${m}${d ? `  ${DIM}${d}${RESET}` : ''}`);
const warn = (m, d) => console.log(`  ${YELLOW}WARN${RESET}  ${m}${d ? `  ${DIM}${d}${RESET}` : ''}`);
const fail = (m, d) => console.log(`  ${RED}FAIL${RESET}  ${m}${d ? `  ${DIM}${d}${RESET}` : ''}`);

let fatals = 0;
let warnings = 0;

console.log(`\nPreflight — tenant "${tenant}"\n`);

// --- 1. config ---------------------------------------------------------------
console.log('Configuration');
let cfg = null;
try {
  cfg = loadConfig(tenant);
  pass(`config/${tenant}.yaml is valid`, cfg.client.name);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  fail(`config/${tenant}.yaml`, configPath(tenant));
  for (const p of e.problems) console.log(`        ${RED}·${RESET} ${p}`);
  fatals++;
}

if (cfg) {
  const enabled = cfg.buckets.filter((b) => b.enabled);
  pass(`${enabled.length} bucket(s) enabled`, enabled.map((b) => `${b.id}(p${b.priority}/cap${b.daily_cap})`).join(' '));

  if (cfg.run_mode === 'daily') {
    warn('run_mode is "daily"', `cap ${cfg.caps.max_per_day}/day. Start on "supervised" until you trust the drafts.`);
    warnings++;
  } else {
    pass('run_mode is "supervised"', `cap ${cfg.__meta.effectiveCap}/run`);
  }

  const cold = enabled.filter((b) => b.play === 'cold-outbound');
  const warm = enabled.filter((b) => b.play !== 'cold-outbound');
  if (cold.length && !warm.length) {
    warn('only cold buckets are enabled', 'Warm signals convert far better. Enable a warm bucket first.');
    warnings++;
  }
  if (cold.some((b) => warm.some((w) => w.priority >= b.priority))) {
    warn('a cold bucket outranks a warm one', 'Cold outbound should have the highest priority number, so it runs last.');
    warnings++;
  }

  // The voice pack is the single biggest lever on draft quality.
  const vp = cfg.__meta.voicePackPath;
  if (!vp) { warn('no voice_pack configured', 'Drafts will be generic.'); warnings++; }
  else if (!existsSync(vp)) {
    fail('voice pack not found', `${vp} — copy voice-pack.example.md to ${cfg.voice_pack} and fill it in.`);
    fatals++;
  } else pass('voice pack found', cfg.voice_pack);

  // State must be writable, or dedupe silently stops working.
  const stateDir = resolveStateDir();
  try {
    mkdirSync(stateDir, { recursive: true });
    accessSync(stateDir, constants.W_OK);
    pass('state directory is writable', stateDir);
    if (!/^([A-Za-z]:)?[\\/]/.test(process.env.STATE_DIR || '') && process.env.RAILWAY_ENVIRONMENT) {
      warn('STATE_DIR is not an absolute path on an ephemeral host',
        'Point it at a mounted volume or dedupe resets on every deploy and people get contacted twice.');
      warnings++;
    }
  } catch (e) {
    fail('state directory is not writable', `${stateDir}: ${e.message}`);
    fatals++;
  }
}

// --- 2. credentials ----------------------------------------------------------
console.log('\nCredentials');
const env = checkEnvironment({ dryRun: false });
for (const c of env.checks) {
  if (c.ok) pass(c.key, c.detail);
  else if (c.fatal) { fail(c.key, c.detail); fatals++; }
  else { warn(c.key, c.detail); warnings++; }
}

// --- 3. live connectivity ----------------------------------------------------
// One cheap read per service. A token that is present but revoked, scoped
// wrong, or pasted with a trailing newline fails here rather than halfway
// through a run.
if (!offline) {
  console.log('\nConnectivity  ' + DIM + '(read-only; --offline to skip)' + RESET);

  const timeout = (ms) => AbortSignal.timeout(ms);

  if (process.env.HUBSPOT_ACCESS_TOKEN) {
    try {
      const r = await fetch('https://api.hubapi.com/crm/v3/owners?limit=1', {
        headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}` },
        signal: timeout(15000),
      });
      if (r.ok) pass('CRM reachable and token valid');
      else if (r.status === 401) { fail('CRM rejected the token (401)', 'HUBSPOT_ACCESS_TOKEN is wrong, expired, or revoked.'); fatals++; }
      else if (r.status === 403) { fail('CRM token is missing a scope (403)', 'Grant crm.objects.owners.read and the list/contact read scopes.'); fatals++; }
      else { warn(`CRM returned ${r.status}`, 'Unexpected, but not necessarily fatal.'); warnings++; }
    } catch (e) {
      warn('could not reach the CRM', e.message);
      warnings++;
    }
  }

  if (process.env.FT_MCP_TOKEN) {
    const url = cfg?.providers?.outreach?.mcp_url || process.env.FT_MCP_URL || 'https://mcp.firsttouch.ai';
    try {
      // MCP initialize is the cheapest call that proves both reachability and auth.
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.FT_MCP_TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'pipeline-agent-preflight', version: '0.1.0' },
          },
        }),
        signal: timeout(15000),
      });
      if (r.ok) pass('outreach platform reachable and token valid', url);
      else if (r.status === 401 || r.status === 403) { fail(`outreach platform rejected the token (${r.status})`, 'Check FT_MCP_TOKEN.'); fatals++; }
      else { warn(`outreach platform returned ${r.status}`, url); warnings++; }
    } catch (e) {
      warn('could not reach the outreach platform', e.message);
      warnings++;
    }
  }

  if (process.env.SLACK_BOT_TOKEN) {
    try {
      const r = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        signal: timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) pass('Slack token valid', `${j.team} as ${j.user}`);
      else { warn('Slack rejected the token', `${j.error || r.status} — the digest will be skipped.`); warnings++; }
    } catch (e) {
      warn('could not reach Slack', e.message);
      warnings++;
    }
  }

  // The `claude` CLI is what actually runs the agent.
  try {
    const { spawnSync } = await import('node:child_process');
    const r = process.platform === 'win32'
      ? spawnSync('cmd', ['/c', 'claude', '--version'], { encoding: 'utf8', windowsHide: true })
      : spawnSync('claude', ['--version'], { encoding: 'utf8' });
    if (r.status === 0) pass('claude CLI available', (r.stdout || '').trim());
    else { fail('claude CLI not runnable', 'Run `npm install`, or `npm install -g @anthropic-ai/claude-code`.'); fatals++; }
  } catch {
    fail('claude CLI not found on PATH', 'Run `npm install` in this repo.');
    fatals++;
  }
}

// --- verdict -----------------------------------------------------------------
console.log('');
if (fatals) {
  console.log(`${RED}${fatals} blocking problem(s)${RESET}${warnings ? `, ${warnings} warning(s)` : ''}. Fix the failures above before running.\n`);
  process.exit(1);
}
if (warnings) {
  console.log(`${GREEN}Ready${RESET}, with ${YELLOW}${warnings} warning(s)${RESET}.`);
} else {
  console.log(`${GREEN}Ready.${RESET}`);
}
console.log(`\nNext:  npm run dry      ${DIM}# a full run that creates nothing${RESET}\n`);
