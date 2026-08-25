#!/usr/bin/env node
// The agent's tool server, over stdio. Deliberately dumb wiring: parse the
// JSON-RPC frame, hand it to ToolCore (runner/lib/tools-core.mjs), serialise
// the answer. Every rule lives in the core, where it is unit-tested — nothing
// in this file makes a decision.
//
// The host spawns headless Claude with this as its ONLY MCP server
// (--strict-mcp-config), passing the session mode via environment:
//
//   AGENT_SESSION_MODE   motion | chat | onboarding   (set by the host)
//   AGENT_MOTION_ID      the running motion's id      (motion mode)
//   AGENT_CONFIG         config name                  (defaults to 'agent')
//
// Credentials (FT_MCP_TOKEN, HUBSPOT_ACCESS_TOKEN) are given to THIS process
// by the host — the model's own process never sees them.
//
// Framing follows runner/mcp/hubspot-server.mjs: one JSON-RPC message per
// line on stdout, handshake-era MCP, console noise aliased to stderr so a
// stray log cannot corrupt the protocol stream.

import process from 'node:process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig, configDir, ROOT } from '../lib/config.mjs';
import { openLedger } from '../lib/ledger.mjs';
import { ToolCore, ToolError, ENRICHMENT_KINDS, MODES } from '../lib/tools-core.mjs';
import { firsttouchProvider, hubspotProvider, dashboardReader, externalToolProviders, loadExtraAdapters } from '../lib/providers.mjs';

console.log = console.error;
console.info = console.error;
console.debug = console.error;
const log = (...args) => console.error('[agent-tools]', ...args);

const SERVER_INFO = { name: 'agent-tools', title: 'Pipeline agent tools', version: '0.1.0' };
const PREFERRED_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

// ---------------------------------------------------------------------------
// Tool schemas: what the model sees. Closed objects, no free-form dispatch.
// ---------------------------------------------------------------------------

const SUBJECT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' }, title: { type: 'string' }, company: { type: 'string' },
    email: { type: 'string' }, linkedin_url: { type: 'string' },
    company_domain: { type: 'string' }, crm_contact_id: { type: 'string' },
  },
  additionalProperties: false,
};
const STEPS_SCHEMA = {
  type: 'array', minItems: 1,
  items: {
    type: 'object', required: ['channel', 'copy'],
    properties: { channel: { type: 'string' }, copy: { type: 'string' } },
    additionalProperties: false,
  },
};

const TOOL_SCHEMAS = {
  crm_search_contacts: {
    description: 'Search CRM contacts by free-text query.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
  },
  crm_get_list: {
    description: 'Read the members of a CRM list by id.',
    inputSchema: { type: 'object', required: ['list_id'], properties: { list_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
  },
  crm_list_deals: {
    description: 'List deals, optionally filtered to one pipeline.',
    inputSchema: { type: 'object', properties: { pipeline_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
  },
  list_team_members: {
    description: 'The team members on the outreach platform.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  list_sender_connections: {
    description: 'Which sending accounts each team member has connected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  list_declared_flows: {
    description: 'The flows this agent may enrol contacts into. The list IS the permission.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  dashboard_read: {
    description: 'Read a path from the configured account dashboard (cs_postclose). Absolute path only — the base URL and identity come from config.',
    inputSchema: {
      type: 'object', required: ['path'],
      properties: { path: { type: 'string', description: 'e.g. "/api/at-risk"' } },
      additionalProperties: false,
    },
  },
  start_enrichment: {
    description: `Paid enrichment. kind must be one of: ${ENRICHMENT_KINDS.join(', ')}. Credit-capped per run — qualify with free checks first.`,
    inputSchema: {
      type: 'object', required: ['kind', 'subject'],
      properties: { kind: { type: 'string', enum: ENRICHMENT_KINDS }, subject: SUBJECT_SCHEMA },
      additionalProperties: false,
    },
  },
  propose_outreach: {
    description: 'Stage outreach for approval. Requires a researched why. Refusals (suppression, caps, claims) come back with reasons — report them as skip lines.',
    inputSchema: {
      type: 'object', required: ['subject', 'why', 'steps'],
      properties: {
        subject: SUBJECT_SCHEMA, why: { type: 'string' }, steps: STEPS_SCHEMA,
        owner_ref: { type: 'string', description: 'An owner id from config. Omit for the default owner.' },
        allow_claimed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  propose_crm_change: {
    description: 'Stage CRM changes for approval as a from→to change set. Only fields in crm_fields_may_change can be proposed.',
    inputSchema: {
      type: 'object', required: ['changes'],
      properties: {
        changes: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', required: ['object_type', 'object_id', 'field', 'from', 'to'],
            properties: {
              object_type: { type: 'string' }, object_id: { type: 'string' },
              field: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        why: { type: 'string' }, owner_ref: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  propose_unsent_draft: {
    description: 'Stage an UNSENT draft (e.g. a meeting recap). Approving it saves it; nothing is ever sent.',
    inputSchema: {
      type: 'object', required: ['title', 'body'],
      properties: { subject: SUBJECT_SCHEMA, title: { type: 'string' }, body: { type: 'string' }, owner_ref: { type: 'string' } },
      additionalProperties: false,
    },
  },
  propose_report: {
    description: 'Stage a report-only card (digest lines, no sender, no buttons).',
    inputSchema: {
      type: 'object', required: ['lines'],
      properties: { lines: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      additionalProperties: false,
    },
  },
  enroll_declared_flow: {
    description: 'Stage enrolment into a DECLARED flow for approval. Undeclared flows are refused.',
    inputSchema: {
      type: 'object', required: ['flow_id', 'subject'],
      properties: { flow_id: { type: 'string' }, subject: SUBJECT_SCHEMA, owner_ref: { type: 'string' } },
      additionalProperties: false,
    },
  },
  propose_campaign: {
    description: 'Stage a one-off campaign: an audience plus steps, approved as ONE batch card, dripped under daily caps. Every member is screened now and re-screened at send.',
    inputSchema: {
      type: 'object', required: ['name', 'why', 'audience', 'steps'],
      properties: {
        name: { type: 'string' }, why: { type: 'string' },
        audience: { type: 'array', items: SUBJECT_SCHEMA, minItems: 1 },
        steps: STEPS_SCHEMA, owner_ref: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  set_config: {
    description: 'Patch the agent config. The patch is validated in full before writing; protected keys and provider URLs are refused.',
    inputSchema: { type: 'object', required: ['patch'], properties: { patch: { type: 'object' } }, additionalProperties: false },
  },
  write_play: {
    description: 'Write a play (Markdown) into the plays workspace. Bare filename only.',
    inputSchema: {
      type: 'object', required: ['filename', 'content'],
      properties: { filename: { type: 'string' }, content: { type: 'string' } },
      additionalProperties: false,
    },
  },
  write_voice_pack: {
    description: 'Rewrite the voice pack. Learned lessons still override it where they conflict.',
    inputSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } }, additionalProperties: false },
  },
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const mode = process.env.AGENT_SESSION_MODE;
if (!MODES.includes(mode)) {
  console.error(`AGENT_SESSION_MODE must be one of ${MODES.join('|')}, got "${mode}". ` +
    'This server is spawned by the host — it is not meant to be run by hand.');
  process.exit(2);
}

const cfg = loadConfig();
const ledger = openLedger(cfg.__meta.ledgerPath);

// In a dry run nothing is created, so a missing platform token degrades to
// refusals the model reports as skips — matching checkEnvironment, which
// makes FT_MCP_TOKEN non-fatal for dry runs. Anywhere else it is fatal.
const ftRefusal = { refused: 'outreach platform not connected (dry run without FT_MCP_TOKEN)' };
let providers = {
  ft: process.env.FT_MCP_TOKEN ? await firsttouchProvider()
    : process.env.DRY_RUN === '1'
      ? new Proxy({}, { get: () => () => ftRefusal })
      : (() => { throw new Error('FT_MCP_TOKEN is not set and this is not a dry run.'); })(),
  crm: process.env.HUBSPOT_ACCESS_TOKEN ? hubspotProvider() : {
    searchContacts: () => ({ refused: 'no CRM connected' }),
    getList: () => ({ refused: 'no CRM connected' }),
    listDeals: () => ({ refused: 'no CRM connected' }),
  },
  dash: dashboardReader(),
  external: externalToolProviders(cfg),
  writeConfig(candidate) {
    // Serialise back to YAML via js-yaml (already a dependency of config).
    return import('js-yaml').then(({ dump }) => {
      writeFileSync(cfg.__meta.path, dump(candidate, { lineWidth: 100 }));
    });
  },
  writeWorkspaceFile(relPath, content) {
    // plays/… and voice-pack.md live in the tenant dir — the writable volume
    // in a container, never the read-only engine tree.
    const target = join(configDir(), relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  },
};

// Deployment-specific adapters, baked into the IMAGE by an overlay build —
// never loaded from the writable volume (validateAdaptersDir enforces that).
providers = await loadExtraAdapters(providers, cfg);

const core = new ToolCore({
  cfg, ledger, mode,
  motionId: process.env.AGENT_MOTION_ID || null,
  providers,
});

const exposed = new Set(core.availableTools());
log(`mode=${mode} tools=${[...exposed].join(',')}`);

// ---------------------------------------------------------------------------
// JSON-RPC loop
// ---------------------------------------------------------------------------

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    return reply(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PREFERRED_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized') return; // notification, no reply
  if (method === 'tools/list') {
    return reply(id, {
      tools: [...exposed].map((name) => ({
        name,
        description: TOOL_SCHEMAS[name]?.description ?? name,
        inputSchema: TOOL_SCHEMAS[name]?.inputSchema ?? { type: 'object' },
      })),
    });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    try {
      const result = await core.call(name, params?.arguments ?? {});
      if (result && result.refused) {
        return reply(id, {
          content: [{ type: 'text', text: `REFUSED: ${result.refused}` }],
          isError: true,
        });
      }
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (e) {
      if (e instanceof ToolError) {
        return reply(id, { content: [{ type: 'text', text: `REFUSED: ${e.message}` }], isError: true });
      }
      log(`tool ${name} failed: ${e.message}`);
      return reply(id, { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) return replyError(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => log(`handler crashed: ${e.message}`));
  }
});
process.stdin.on('end', () => process.exit(0));
