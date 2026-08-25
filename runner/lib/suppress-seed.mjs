// Seed the suppressions table from the tenant's configured sources.
//
// WHERE THE TRUTH LIVES. The authoritative exclusion lists live in the
// customer's own systems — FirstTouch's exclusion list, HubSpot/CRM opt-out
// and unsubscribe status, and whatever DNC file they keep. This table is a
// fast local CACHE of that truth, refreshed each run, PLUS the signals only we
// have (the domain backstop for prospects with no CRM record, and — enforced
// elsewhere — dedupe and the re-work cooldown). It is deliberately NOT the
// source of truth, which is why FirstTouch's own exclusion check at enrolment
// (ignoreExclusionCheck left false) stays as the final backstop: a stale cache
// still cannot push an excluded contact through the platform.
//
// Runs at host boot and before every motion. Idempotent: it upserts, so a
// re-run refreshes rather than duplicates. Sources, in order:
//
//   1. do-not-contact file  — one email or domain per line, operator-owned.
//      Loaded as scope='email'/'domain', source='dnc', never expires.
//   2. excluded_domains      — from config, source='config', never expires.
//   3. CRM customers         — every contact whose customer_signal matches is
//      suppressed by email AND company domain, source='crm_customer'.
//   4. CRM suppression signal — every contact whose suppression_signal matches
//      (opt-out / unsubscribed / do-not-contact property IN THE CRM) is
//      suppressed the same way, source='crm_suppressed'. This is how a
//      customer whose DNC lives in HubSpot points us at it, portably.
//   Both CRM sources carry a refresh TTL so a status change eventually ages
//   out of the cache.
//   5. rework cooldown       — handled at query time, not seeded here.
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
export async function seedSuppressions({ ledger, cfg, crmCustomers = null, crmSuppressed = null, now = () => new Date() }) {
  const summary = { dnc_emails: 0, dnc_domains: 0, excluded_domains: 0, crm_customers: 0, crm_suppressed: 0, crm_error: null };
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

  // 4. CRM suppression signal — opt-out / unsubscribed / do-not-contact status
  //    that lives in the customer's CRM (this is where most real DNC lives).
  if (crmSuppressed) {
    try {
      const ttlDays = Number(cfg.suppression_refresh_days ?? 45);
      const until = new Date(now().getTime() + ttlDays * 24 * 3600e3).toISOString();
      const rows = await crmSuppressed();
      for (const row of rows) {
        if (row.email) { ledger.suppress('email', row.email, 'CRM opt-out / do-not-contact', 'crm_suppressed', until); summary.crm_suppressed++; }
        // NB: opt-out is per-PERSON, so we do NOT suppress the whole domain
        // here (unlike a customer account) — one unsubscribe must not silence
        // an entire company.
      }
    } catch (e) {
      summary.crm_error = summary.crm_error
        ? `${summary.crm_error}; suppression signal: ${e.message}`
        : `suppression signal: ${e.message}`;
    }
  }

  ledger.setWatermark('agent', 'suppressions_seeded_at', nowIso);
  return summary;
}
