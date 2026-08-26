// Load .env, if there is one.
//
// Import this FIRST from every entrypoint — before any module that reads
// process.env. It is a side-effecting import on purpose: there is nothing to
// call and nothing to configure.
//
// In a container (Railway, Fly, Docker) there is no .env file at all — the
// platform injects real environment variables and this is a no-op. Locally the
// file is how you avoid exporting eight variables into your shell every time.
//
// Real environment variables always WIN: process.loadEnvFile does not override
// anything already set. So a stale .env left in a working copy can never
// silently shadow a platform variable — the deployed value is authoritative.
//
// Without this the .env we ship an example for is decorative: the preflight
// reports every credential missing while the file sits there fully populated.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = process.env.ENV_FILE || join(ROOT, '.env');

if (existsSync(file)) {
  try {
    process.loadEnvFile(file);
  } catch (e) {
    // A malformed .env should say so loudly rather than present as "no
    // credentials are set", which sends people hunting in the wrong place.
    console.error(`Could not read ${file}: ${e.message}`);
    process.exit(1);
  }
}

export const envFile = existsSync(file) ? file : null;
