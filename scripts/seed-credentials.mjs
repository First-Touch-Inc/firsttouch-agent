#!/usr/bin/env node
// Prints the CLAUDE_CREDENTIALS_SEED value for a container deployment.
//
// A container has no browser, so MCP OAuth (FirstTouch, and HubSpot if you use
// its MCP) happens on YOUR machine: open this repo, run `claude`, type /mcp,
// authorize. Claude Code stores the grant in ~/.claude/.credentials.json. This
// script prints that file base64-encoded; set the output as
// CLAUDE_CREDENTIALS_SEED on the service and the host hydrates it into the
// container's home on first boot (and never again — refreshed tokens win).
//
// The value contains live OAuth tokens. Treat it like a password: paste it
// into the platform's variable store and nowhere else.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const file = join(homedir(), '.claude', '.credentials.json');
let raw;
try {
  raw = readFileSync(file);
} catch {
  console.error(`No ${file} found.`);
  console.error('Authorize first: run `claude` in this repo, type /mcp, and complete the FirstTouch authorization.');
  console.error('(On macOS the credentials may live in the Keychain instead of this file — run this on the Linux or Windows machine you authorized on.)');
  process.exit(1);
}
try {
  JSON.parse(raw.toString('utf8'));
} catch {
  console.error(`${file} exists but is not valid JSON — refusing to seed garbage.`);
  process.exit(1);
}
console.error(`CLAUDE_CREDENTIALS_SEED (from ${file}) — set it on the service:\n`);
console.log(raw.toString('base64'));
