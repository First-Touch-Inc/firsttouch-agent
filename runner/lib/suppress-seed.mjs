// Seed the suppressions table from the tenant's configured sources, so the
// checks in tools-core/apply have something to find. Without this pass the
// suppressions table is empty and "never prospects your customers" is a
// promise nothing keeps — the single biggest QA finding.
//
// Runs at host boot and before every motion. Idempotent: it upserts, so a
// re-run refreshes rather than duplicates. Sources, in order:
//
//   1. do-not-contact file  — one email or domain per line, operator-owned.
//      Loaded as scope='email'/'domain', source='dnc', never expires.
//   2. excluded_domains      — from config, source='config', never expires.
//   3. CRM customers         — every contact whose customer_signal matches is
//      suppressed by email AND company domain, source='crm_customer', with a
//      refresh TTL so a churned customer eventually ages out.
//   4. rework cooldown       — handled at query time in reserveTouch/dedupe,
//      not seeded here (it is relative to the last touch, per subject).
//
// The DNC file lives OUTSIDE the writable config so the agent cannot read or
// edit it (it is a list of people who objected — privacy-sensitive, and an
// integrity control). Default path: <configDir>/do-not-contact.txt, but the
// host may point DNC_FILE elsewhere (e.g. a read-only mount).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, resolveTenantPath } from './config.mjs';
import { registrableDomain, normalizeEmail } from './ledger.mjs';

export function dncPath(cfg) {
  if (process.env.DNC_FILE) return process.env.DNC_FILE;
  const configured = cfg?.suppression_files?.do_not_contact;
  if (configured) return resolveTenantPath(configured);
  return join(configDir(), 'do-not-contact.txt');
}

/** Parse a DNC file into {emails, domains}. Lines may be emails, bare domains,
 *  or "@domain.com". Comments (#) and blanks ignored. */
export function parseDnc(text) {
  const emails = new Set();
  const domains = new Set();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.includes('@') && !line.startsWith('@')) {
      emails.add(normalizeEmail(line));
    } else {
      const d = registrableDomain(line.replace(/^@/, ''));
      if (d) domains.add(d);
    }
  }
  return { emails: [...emails], domains: [...domains] };
}

/**
 * Seed the suppressions table. Returns a summary for the digest/log.
 *
 * @param crmCustomers  async () => [{ email, company_domain }] — the CRM
 *   adapter's list of records matching customer_signal. Optional; when the
 *   CRM cannot be reached this source is skipped (and reported), never
 *   silently treated as "no customers".
 */
export async function seedSuppressions({ ledger, cfg, crmCustomers = null, now = () => new Date() }) {
  const summary = { dnc_emails: 0, dnc_domains: 0, excluded_domains: 0, crm_customers: 0, crm_error: null };
  const nowIso = now().toISOString();

  // 1. DNC file.
  const path = dncPath(cfg);
  if (existsSync(path)) {
    const { emails, domains } = parseDnc(readFileSync(path, 'utf8'));
    for (const e of emails) { ledger.suppress('email', e, 'do-not-contact list', 'dnc', null); summary.dnc_emails++; }
    for (const d of domains) { ledger.suppress('domain', d, 'do-not-contact list', 'dnc', null); summary.dnc_domains++; }
  }

  // 2. excluded_domains from config.
  for (const raw of cfg.excluded_domains ?? []) {
    const d = registrableDomain(raw);
    if (d) { ledger.suppress('domain', d, 'excluded_domains in config', 'config', null); summary.excluded_domains++; }
  }

  // 3. CRM customers. A churned customer should eventually age out, so these
  //    carry a refresh TTL (default 45 days) — the next seed re-adds current
  //    customers, and anyone no longer matching simply stops being refreshed.
  if (crmCustomers) {
    try {
      const ttlDays = Number(cfg.suppression_refresh_days ?? 45);
      const until = new Date(now().getTime() + ttlDays * 24 * 3600e3).toISOString();
      const rows = await crmCustomers();
      for (const row of rows) {
        if (row.email) { ledger.suppress('email', row.email, 'existing customer', 'crm_customer', until); summary.crm_customers++; }
        const d = row.company_domain ? registrableDomain(row.company_domain)
          : row.email ? registrableDomain(row.email) : null;
        if (d) ledger.suppress('domain', d, 'existing customer', 'crm_customer', until);
      }
    } catch (e) {
      // Never treat an unreachable CRM as "no customers" — that would let the
      // agent prospect the whole customer base. Report and leave prior rows.
      summary.crm_error = e.message;
    }
  }

  ledger.setWatermark('agent', 'suppressions_seeded_at', nowIso);
  return summary;
}
