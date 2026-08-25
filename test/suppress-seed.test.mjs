// Tests for the suppression seeder — the pass that makes "never prospects
// your customers" real instead of a table nothing fills (the top QA finding).
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLedger } from '../runner/lib/ledger.mjs';
import { parseDnc, seedSuppressions } from '../runner/lib/suppress-seed.mjs';

const NOW = () => new Date('2030-06-01T12:00:00Z');

function baseCfg(over = {}) {
  return {
    excluded_domains: [],
    providers: { crm: { customer_signal: [{ property: 'lifecyclestage', equals: 'customer' }] } },
    ...over,
  };
}

test('parseDnc reads emails, bare domains and @domains, skipping comments', () => {
  const { emails, domains } = parseDnc(`
    # our do-not-contact list
    Jane@Acme.com
    competitor.com
    @evil.io
    not a line without at
  `);
  assert.deepEqual(emails.sort(), ['jane@acme.com']);
  assert.deepEqual(domains.sort(), ['competitor.com', 'evil.io']);
});

test('a DNC file suppresses its emails and domains', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dnc-'));
  const file = join(dir, 'do-not-contact.txt');
  writeFileSync(file, 'jane@acme.com\nbadco.com\n');
  process.env.DNC_FILE = file;
  try {
    const ledger = openLedger(':memory:');
    const summary = await seedSuppressions({ ledger, cfg: baseCfg(), now: NOW });
    assert.equal(summary.dnc_emails, 1);
    assert.equal(summary.dnc_domains, 1);
    assert.ok(ledger.suppressionFor({ email: 'jane@acme.com' }), 'the DNC email is suppressed');
    assert.ok(ledger.suppressionFor({ email: 'someone@badco.com' }), 'the DNC domain is suppressed');
  } finally {
    delete process.env.DNC_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('excluded_domains from config are suppressed', async () => {
  const ledger = openLedger(':memory:');
  await seedSuppressions({ ledger, cfg: baseCfg({ excluded_domains: ['competitor.com'] }), now: NOW });
  assert.ok(ledger.suppressionFor({ email: 'ceo@competitor.com' }));
});

test('CRM customers suppress by email AND company domain, with a refresh TTL', async () => {
  const ledger = openLedger(':memory:');
  const crmCustomers = async () => [
    { email: 'paying@customer.com', company_domain: 'customer.com' },
    { email: 'sam@bigco.com', company_domain: 'https://bigco.com' },
  ];
  const summary = await seedSuppressions({ ledger, cfg: baseCfg(), crmCustomers, now: NOW });
  assert.equal(summary.crm_customers, 2);
  assert.ok(ledger.suppressionFor({ email: 'paying@customer.com' }), 'customer email suppressed');
  assert.ok(ledger.suppressionFor({ email: 'anyone.else@customer.com' }), 'customer DOMAIN suppressed too');
  assert.ok(ledger.suppressionFor({ email: 'new@bigco.com' }), 'domain normalised from a url');
});

test('an unreachable CRM is reported, never treated as "no customers"', async () => {
  const ledger = openLedger(':memory:');
  // Seed once so there is a prior list.
  await seedSuppressions({ ledger, cfg: baseCfg(), crmCustomers: async () => [{ email: 'a@cust.com', company_domain: 'cust.com' }], now: NOW });
  // Now the CRM is down.
  const summary = await seedSuppressions({
    ledger, cfg: baseCfg(), now: NOW,
    crmCustomers: async () => { throw new Error('HubSpot 503'); },
  });
  assert.match(summary.crm_error, /503/);
  assert.ok(ledger.suppressionFor({ email: 'a@cust.com' }),
    'the previous customer list must survive an outage — never wiped to empty');
});

test('the seed is idempotent — re-running refreshes rather than duplicating', async () => {
  const ledger = openLedger(':memory:');
  const cfg = baseCfg({ excluded_domains: ['x.com'] });
  await seedSuppressions({ ledger, cfg, now: NOW });
  await seedSuppressions({ ledger, cfg, now: NOW });
  const n = ledger.db.prepare("SELECT COUNT(*) c FROM suppressions WHERE scope='domain' AND value='x.com'").get().c;
  assert.equal(n, 1, 'one row, upserted');
});

// --- CRM suppression signal: DNC that lives in the CRM (the usual place) ------

test('a CRM suppression signal suppresses opted-out contacts by email, not domain', async () => {
  const ledger = openLedger(':memory:');
  const crmSuppressed = async () => [
    { email: 'optout@bigco.com', company_domain: 'bigco.com' },
  ];
  const summary = await seedSuppressions({ ledger, cfg: baseCfg(), crmSuppressed, now: NOW });
  assert.equal(summary.crm_suppressed, 1);
  assert.ok(ledger.suppressionFor({ email: 'optout@bigco.com' }), 'the opted-out person is suppressed');
  assert.equal(ledger.suppressionFor({ email: 'colleague@bigco.com' }), null,
    'one person opting out must NOT silence their whole company');
});

test('a suppression-signal CRM error is reported, prior rows kept', async () => {
  const ledger = openLedger(':memory:');
  await seedSuppressions({ ledger, cfg: baseCfg(), crmSuppressed: async () => [{ email: 'a@x.com' }], now: NOW });
  const summary = await seedSuppressions({
    ledger, cfg: baseCfg(), now: NOW,
    crmSuppressed: async () => { throw new Error('CRM 500'); },
  });
  assert.match(summary.crm_error, /suppression signal/);
  assert.ok(ledger.suppressionFor({ email: 'a@x.com' }), 'prior suppression survives an outage');
});
