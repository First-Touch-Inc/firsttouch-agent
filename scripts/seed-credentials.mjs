#!/usr/bin/env node
// Prints the CLAUDE_CREDENTIALS_SEED value for a container deployment.
//
// A container has no browser, so MCP OAuth (FirstTouch, and HubSpot if you use
// its MCP) happens on YOUR machine: open this repo, run `claude`, type /mcp,
// authorize. Claude Code stores the grants in ~/.claude/.credentials.json.
//
// This script prints ONLY the grants for the servers this repo registers
// (.mcp.json), base64-encoded. Everything else is deliberately left out:
//  - your claude.ai login tokens — seeding those would let the container and
//    your desktop rotate the same refresh token and log each other out (the
//    container authenticates with CLAUDE_CODE_OAUTH_TOKEN instead);
//  - grants for unrelated MCP servers, which the agent has no business holding.
//
// Set the output as CLAUDE_CREDENTIALS_SEED on the service; the host hydrates
// it into the container's home on first boot (and never again — refreshed
// tokens win). The value contains live OAuth tokens: treat it like a password,
// paste it into the platform's variable store and nowhere else.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let wanted;
try {
  wanted = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')).mcpServers || {}));
} catch {
  console.error('Could not read .mcp.json at the repo root — run this from a checkout of the repo.');
  process.exit(1);
}

const file = join(homedir(), '.claude', '.credentials.json');
let creds;
try {
  creds = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  console.error(`No readable ${file} found.`);
  console.error('Authorize first: run `claude` in this repo, type /mcp, and complete the FirstTouch authorization.');
  console.error('(On macOS the credentials may live in the Keychain instead of this file — run this on the Linux or Windows machine you authorized on.)');
  process.exit(1);
}

const kept = {};
const skipped = [];
for (const [key, entry] of Object.entries(creds.mcpOAuth || {})) {
  if (wanted.has(String(entry?.serverName))) kept[key] = entry;
  else skipped.push(entry?.serverName || key);
}

if (Object.keys(kept).length === 0) {
  console.error(`No grants found for ${[...wanted].join(' / ')} in ${file}.`);
  console.error('Run `claude` IN THIS REPO folder, type /mcp, authorize, then run this again.');
  if (skipped.length) console.error(`(Grants that were found but don't belong to this repo's servers: ${[...new Set(skipped)].join(', ')})`);
  process.exit(1);
}

console.error(`Including: ${Object.values(kept).map((e) => e.serverName).join(', ')}`);
if (skipped.length) console.error(`Leaving out: ${[...new Set(skipped)].join(', ')} (not this repo's servers)`);
if (creds.claudeAiOauth) console.error('Leaving out: your claude.ai login (the container uses CLAUDE_CODE_OAUTH_TOKEN).');
console.error('\nSet this as CLAUDE_CREDENTIALS_SEED on the service:\n');
console.log(Buffer.from(JSON.stringify({ mcpOAuth: kept })).toString('base64'));
