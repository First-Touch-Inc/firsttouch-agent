#!/usr/bin/env node
// One tenant, one daily run.
//
// This is the single command a scheduler invokes. It owns the run LIFECYCLE —
// config load, credential check, run id, MCP wiring, start/finish records — and
// delegates the actual thinking (sweep, research, draft, route, report) to the
// `pipeline-agent` skill running inside a headless Claude Code session.
//
//   node runner/run-daily.mjs                 # uses config/tenant.yaml
//   node runner/run-daily.mjs --tenant acme   # uses config/acme.yaml
//   node runner/run-daily.mjs --dry           # research and draft, create nothing
//
// The agent is spawned as a subprocess rather than embedded so that the run is
// observable (streamed events) and killable (hard timeout).
//
// HEADLESS CLAUDE CODE IS THE ONLY SUPPORTED HARNESS, and that is a safety
// decision rather than a limit of ambition. The approval gate is a Claude Code
// PreToolUse hook (.claude/hooks/guard-send.mjs), which inspects every outreach
// and CRM tool call BEFORE it executes and can refuse it. Swap this out for a
// plain model loop and that hook stops running — the gate silently becomes a
// sentence in a prompt asking the model nicely, which is not a control.
//
// If you replace `spawnAgent`, you are taking ownership of the gate. Whatever
// you put here must be able to block a tool call before it happens, and you
// should port test/guard-send.test.mjs to prove it still does. See
// docs/security.md.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig, checkEnvironment, ConfigError, ROOT, resolveStateDir } from './lib/config.mjs';

// --- arguments ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const tenant = opt('tenant', process.env.TENANT || 'tenant');
const dryRun = flag('dry') || process.env.DRY_RUN === '1';
const timeoutMs = Number(process.env.RUN_TIMEOUT_MS || 45 * 60 * 1000);

const log = (...a) => console.log('[run]', ...a);

// --- 1. config + credentials -------------------------------------------------
let cfg;
try {
  cfg = loadConfig(tenant);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`\n${e.message}`);
    console.error('Run `npm run preflight` for the full picture.\n');
    process.exit(2);
  }
  throw e;
}

const env = checkEnvironment({ dryRun });
if (!env.ok) {
  console.error('\nMissing required credentials:\n');
  for (const c of env.checks.filter((c) => c.fatal && !c.ok)) console.error(`  - ${c.key}: ${c.detail}`);
  console.error('\nRun `npm run preflight` for the full picture.\n');
  process.exit(2);
}

// --- 2. run identity + lifecycle records ------------------------------------
const stateDir = resolveStateDir();
const runsDir = join(stateDir, 'runs');
mkdirSync(runsDir, { recursive: true });

const startedAt = new Date();
const runId = `${tenant}-${startedAt.toISOString().replace(/[:.]/g, '-')}`;
const reportPath = join(runsDir, `${runId}.json`);

const writeReport = (patch) => {
  const prev = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
  writeFileSync(reportPath, JSON.stringify({ ...prev, ...patch }, null, 2));
};

writeReport({
  runId,
  tenant,
  client: cfg.client.name,
  status: 'started',
  dryRun,
  runMode: cfg.run_mode,
  cap: cfg.__meta.effectiveCap,
  startedAt: startedAt.toISOString(),
});

log(`tenant=${tenant} client=${JSON.stringify(cfg.client.name)} runId=${runId}`);
log(`mode=${cfg.run_mode} cap=${cfg.__meta.effectiveCap} dryRun=${dryRun}`);
log(`buckets=${cfg.buckets.filter((b) => b.enabled).map((b) => b.id).join(', ')}`);
log(`report=${reportPath}`);
if (dryRun) log('DRY RUN — the agent will research and draft but create nothing.');

// --- 3. MCP wiring -----------------------------------------------------------
// Written to a temp file rather than committed, because it carries bearer
// tokens. Deleted in the finally block below.
function buildMcpConfig() {
  const servers = {};

  const outreachUrl = cfg.providers?.outreach?.mcp_url || process.env.FT_MCP_URL || 'https://mcp.firsttouch.ai';
  if (process.env.FT_MCP_TOKEN) {
    servers.outreach = {
      type: 'http',
      url: outreachUrl,
      headers: { Authorization: `Bearer ${process.env.FT_MCP_TOKEN}` },
    };
  }

  // The CRM adapter is a local stdio server in this repo, so it works with a
  // plain private-app token and needs no OAuth dance or public callback URL.
  if (process.env.HUBSPOT_ACCESS_TOKEN && cfg.providers?.crm?.kind === 'hubspot') {
    servers.crm = {
      type: 'stdio',
      command: process.execPath,
      args: [join(ROOT, 'runner', 'mcp', 'hubspot-server.mjs')],
      // An explicit env block REPLACES the inherited environment, so every
      // variable the adapter reads has to be listed here. Omitting
      // CRM_WRITES_ENABLED would leave writes silently disabled no matter what
      // the operator set, which looks like a broken adapter rather than a
      // configuration mistake.
      env: {
        HUBSPOT_ACCESS_TOKEN: process.env.HUBSPOT_ACCESS_TOKEN,
        // A dry run must never write, whatever the operator enabled.
        CRM_WRITES_ENABLED: dryRun ? '0' : (process.env.CRM_WRITES_ENABLED || '0'),
      },
    };
  }

  const path = join(tmpdir(), `pipeline-agent-mcp-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
  return { path, names: Object.keys(servers) };
}

// --- 4. the prompt -----------------------------------------------------------
// Deliberately short. The behaviour lives in the skill, which is version
// controlled and reviewable; a long prompt here would be a second, invisible
// source of truth that drifts from the skill. (That drift is a real failure
// mode: it is exactly what happened to the system this was extracted from.)
function buildPrompt() {
  return [
    `Run ONE daily cycle of the \`pipeline-agent\` skill for tenant "${tenant}".`,
    ``,
    `Config: config/${tenant}.yaml — read it first and follow it exactly.`,
    `Run id: ${runId}`,
    `Write the final run report as JSON to: ${reportPath}`,
    ``,
    dryRun
      ? `DRY RUN. Research, qualify and draft normally, but create NOTHING in the ` +
        `outreach platform or the CRM, and post no digest. Write the drafts you ` +
        `would have created into the run report so a human can read them.`
      : `Anything YOU compose is draft-and-approve: every action you create must be ` +
        `approval-gated and assigned to an explicit owner from approval_routing.owners. ` +
        `You may enrol a qualified person into a flow listed under \`flows:\` without ` +
        `a further approval — that copy was written and published by a human — but you ` +
        `may never author or publish a flow, and suppression must pass first, because ` +
        `on that path nobody reads the message before it sends.`,
    ``,
    `Stop at ${cfg.__meta.effectiveCap} drafts. If the enabled buckets run dry before that, ` +
    `stop and report the shortfall with the per-bucket reason. Do not pad the run.`,
  ].join('\n');
}

// --- 5. spawn the agent ------------------------------------------------------
function spawnAgent(mcpPath) {
  return new Promise((resolveRun) => {
    // Three different flags, three different jobs — conflating them is how you
    // end up believing you have a restriction when you have a convenience.
    //
    //   --allowedTools     AUTO-APPROVES these. It does NOT make unlisted tools
    //                      disappear. Needed because a headless `-p` session
    //                      starts in manual permission mode, so without it the
    //                      run stalls on the first CRM call and looks like a hang.
    //   --tools            The actual restriction: which BUILT-IN tools exist at
    //                      all. This is what removes Bash from the session.
    //   --disallowedTools  Explicit deny, belt and braces on top of --tools.
    //
    // Sending is gated by the platform's approval queue and the send guard;
    // none of these flags are the primary control for that.
    const allowedTools = [
      'mcp__outreach__*',
      'mcp__crm__*',
      'Read', 'Glob', 'Grep', 'Write', 'Edit',
      'WebSearch', 'WebFetch',
      'TodoWrite', 'Task',
    ].join(',');

    // The built-in tools this run legitimately needs. Bash is absent by
    // construction, not merely denied.
    const builtins = 'Read,Glob,Grep,Write,Edit,WebSearch,WebFetch,TodoWrite,Task';

    const args = [
      '-p', buildPrompt(),
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--tools', builtins,
      '--allowedTools', allowedTools,
      '--disallowedTools', 'Bash',
      '--mcp-config', mcpPath,
      '--strict-mcp-config',
    ];

    // Windows needs a shell to resolve the `claude` shim; POSIX spawns directly.
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'claude', ...args], { cwd: ROOT, windowsHide: true })
      : spawn('claude', args, { cwd: ROOT });

    let buf = '';
    let finalText = '';
    let toolCalls = 0;
    let killedForTimeout = false;
    let mcpErrors = [];

    const timer = setTimeout(() => {
      killedForTimeout = true;
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }

        // A broken MCP entry is skipped SILENTLY and the session still exits 0,
        // so a run with no CRM access looks exactly like a quiet day. The init
        // event is the only place this is visible — surface it loudly.
        if (ev.type === 'system' && ev.subtype === 'init') {
          const errs = [
            ...(ev.mcp_server_errors || []),
            ...(ev.mcp_servers || []).filter((s) => s.status && !['connected', 'pending'].includes(s.status)),
          ];
          if (errs.length) {
            mcpErrors = errs.map((e) => (typeof e === 'string' ? e : `${e.name}: ${e.status}`));
            log(`WARNING: MCP server problems — ${mcpErrors.join('; ')}`);
          }
          const connected = (ev.mcp_servers || []).map((s) => s.name).join(', ');
          if (connected) log(`  connected: ${connected}`);
        }

        if (ev.type === 'result' && typeof ev.result === 'string') finalText = ev.result;
        if (ev.type === 'assistant') {
          for (const block of ev.message?.content || []) {
            if (block.type === 'tool_use') {
              toolCalls++;
              if (toolCalls % 10 === 0) log(`  … ${toolCalls} tool calls`);
            }
          }
        }
      }
    });

    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b; });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolveRun({
        ok: false,
        error: err.code === 'ENOENT'
          ? 'The `claude` CLI was not found on PATH. Install it with `npm install` in this repo, '
            + 'or globally with `npm install -g @anthropic-ai/claude-code`.'
          : err.message,
        toolCalls,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedForTimeout) {
        return resolveRun({ ok: false, error: `Run exceeded RUN_TIMEOUT_MS (${timeoutMs}ms) and was terminated.`, toolCalls });
      }
      resolveRun({
        ok: code === 0,
        error: code === 0 ? null : `claude exited ${code}${stderr ? `: ${stderr.slice(-800)}` : ''}`,
        summary: finalText,
        toolCalls,
        mcpErrors,
      });
    });
  });
}

// --- 6. go -------------------------------------------------------------------
const mcp = buildMcpConfig();
log(`mcp servers: ${mcp.names.length ? mcp.names.join(', ') : 'none (dry run without credentials)'}`);

let result;
try {
  result = await spawnAgent(mcp.path);
} finally {
  try { rmSync(mcp.path, { force: true }); } catch {}
}

const finishedAt = new Date();
const durationMs = finishedAt - startedAt;

// The agent is instructed to overwrite the report with its own results. If it
// did not, the run is marked incomplete so a monitor can catch a dead run
// rather than a silent no-op that looks like "a quiet day".
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
const agentWroteResults = report.status && report.status !== 'started';

writeReport({
  status: agentWroteResults ? report.status : (result.ok ? 'completed-no-report' : 'failed'),
  ok: result.ok,
  error: result.error || null,
  toolCalls: result.toolCalls,
  mcpErrors: result.mcpErrors?.length ? result.mcpErrors : undefined,
  agentSummary: result.summary || null,
  finishedAt: finishedAt.toISOString(),
  durationMs,
});

// An MCP server that failed to connect means the agent ran without its CRM or
// its outreach platform. That is not a successful run, whatever the exit code
// says, so fail the job and let the scheduler surface it.
if (result.ok && result.mcpErrors?.length) {
  console.error(`\n[run] Completed, but these MCP servers did not connect: ${result.mcpErrors.join('; ')}`);
  console.error('[run] Treating this as a failed run — the agent was working without them.\n');
  process.exit(1);
}

if (!result.ok) {
  console.error(`\n[run] FAILED after ${Math.round(durationMs / 1000)}s: ${result.error}\n`);
  process.exit(1);
}

log(`done in ${Math.round(durationMs / 1000)}s · ${result.toolCalls} tool calls`);
if (!agentWroteResults) {
  log('WARNING: the agent finished without writing a run report. Treat this run as unverified.');
}
if (result.summary) console.log(`\n${result.summary}\n`);
