#!/usr/bin/env node
// HubSpot CRM adapter, exposed to the agent as an MCP server over stdio.
//
// This is the READ side of the pipeline agent. The agent (headless Claude Code)
// spawns this file as a child process and talks JSON-RPC 2.0 to it on
// stdin/stdout. It reads CRM data to decide who is worth working today; it is
// deliberately almost incapable of changing the CRM (see `crm_update_property`
// and THE WRITE GATE below).
//
// Zero npm dependencies, on purpose. This process runs inside a customer's own
// infrastructure against their own CRM token, and every dependency here is
// supply-chain surface between an outbound agent and a company's entire
// customer database. Node >= 20 gives us global `fetch`, and MCP over stdio is
// small enough to implement directly, so we do.
//
// Protocol: MCP revision 2025-11-25 ("legacy"/handshake era). Verified against
// https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
//
//   NOTE: MCP revision 2026-07-28 removed the `initialize` handshake entirely
//   in favour of per-request `_meta`. This server implements only the
//   handshake era. That is the correct choice for a stdio server today: a
//   dual-era client probes with `server/discover` first and, per the stdio
//   backward-compatibility rules, falls back to `initialize` on any error that
//   is not a recognised modern error. We answer `server/discover` with a plain
//   -32601 "Method not found", which is exactly that signal, so dual-era
//   clients negotiate down to us without any extra code.

import process from 'node:process';

// ---------------------------------------------------------------------------
// Protocol framing
// ---------------------------------------------------------------------------

// STDOUT IS THE PROTOCOL CHANNEL. One JSON-RPC message per line, and nothing
// else, ever. A single stray `console.log` anywhere in this process emits a
// non-JSON line that the client cannot parse, which usually kills the whole
// agent session with an error that points nowhere near the real culprit. We
// alias the noisy console methods onto stderr so that an accidental log — from
// this file or from anything it ever imports — is merely noise in the log
// rather than a corrupted protocol stream.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const log = (...args) => console.error('[hubspot-mcp]', ...args);

const SERVER_INFO = {
  name: 'firsttouch-hubspot',
  title: 'HubSpot CRM (read-mostly)',
  version: '0.1.0',
};

// Newest first. We reply with the client's requested version when we recognise
// it, otherwise with our newest — the negotiation rule from the lifecycle spec.
const PREFERRED_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

/** Write one JSON-RPC frame: compact JSON, newline-delimited. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message, data) =>
  send({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

// ---------------------------------------------------------------------------
// HubSpot HTTP client
// ---------------------------------------------------------------------------

// Test seam. Defaults to the real API; a mock server can be pointed at with
// HUBSPOT_API_BASE_URL so the retry and error-mapping paths can be exercised
// without a live portal. This is not a new way to leak the token: anything able
// to set this variable can already read HUBSPOT_ACCESS_TOKEN out of the same
// environment. Anything other than a base URL is ignored.
const HUBSPOT_BASE = process.env.HUBSPOT_API_BASE_URL?.trim() || 'https://api.hubapi.com';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;          // total attempts, not retries
const BACKOFF_BASE_MS = 500;
const MAX_BACKOFF_MS = 10_000;   // never sleep longer than this, see below

/**
 * A HubSpot API failure that already carries an explanation aimed at the model.
 * The agent can only recover from what it can read, so the message says what to
 * do ("check HUBSPOT_ACCESS_TOKEN"), not merely what happened ("401").
 */
class HubSpotError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'HubSpotError';
    this.status = status;
    this.retryable = retryable;
  }
}

const token = () => process.env.HUBSPOT_ACCESS_TOKEN?.trim() || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Turn a non-OK HubSpot response into an error whose message tells the agent
 * (and, through the transcript, the operator) how to fix it.
 *
 * `scope` is the private-app scope this particular call needs. HubSpot's 403
 * body does not reliably name the missing scope, and "403 Forbidden" sends
 * people hunting through permissions at random, so each call site passes the
 * scope it depends on and we name it here.
 */
async function describeFailure(res, scope) {
  let body = '';
  try {
    body = (await res.text()).slice(0, 600);
  } catch {
    // Body already consumed or the socket died; the status alone still helps.
  }
  const detail = body ? ` HubSpot said: ${body}` : '';

  if (res.status === 401) {
    return new HubSpotError(
      'HubSpot rejected the credentials (401). Check HUBSPOT_ACCESS_TOKEN: it must be a ' +
      'private-app access token (starts with "pat-"), it must not be expired or rotated, ' +
      'and it must belong to the HubSpot account you meant to read.' + detail,
      { status: 401 },
    );
  }

  if (res.status === 403) {
    return new HubSpotError(
      `HubSpot refused this call (403). The private app is missing a required scope: ` +
      `most likely "${scope}". Add it in HubSpot under Settings > Integrations > Private Apps > ` +
      `(your app) > Scopes, then re-issue the token — changing scopes invalidates the old one.` + detail,
      { status: 403 },
    );
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    return new HubSpotError(
      `HubSpot rate-limited this call (429).${retryAfter ? ` Retry-After: ${retryAfter}s.` : ''} ` +
      'Slow down: batch the work, ask for fewer records per call, or wait before retrying.' + detail,
      { status: 429, retryable: true },
    );
  }

  if (res.status === 404) {
    return new HubSpotError(
      'HubSpot has no such record or list (404). Check the id — and note that a HubSpot list id ' +
      'is the ILS list id, which is not the same number shown in some older list URLs.' + detail,
      { status: 404 },
    );
  }

  if (res.status >= 500) {
    return new HubSpotError(
      `HubSpot returned a server error (${res.status}). This is usually transient.` + detail,
      { status: res.status, retryable: true },
    );
  }

  return new HubSpotError(
    `HubSpot rejected this request (${res.status}).` + detail,
    { status: res.status },
  );
}

/**
 * One HubSpot call, with a bounded retry.
 *
 * Retry policy, deliberately narrow:
 *   - retry on 429, on 5xx, and on transport errors (DNS/socket/timeout);
 *   - NEVER retry any other 4xx. A 400/401/403/404 is a deterministic answer;
 *     repeating it just burns rate limit and delays the real error reaching
 *     the agent.
 *   - at most MAX_ATTEMPTS total, and never sleep longer than MAX_BACKOFF_MS.
 *     If HubSpot's Retry-After is longer than that cap we stop and surface the
 *     rate-limit error instead: an agent that is told "rate limited, wait 90s"
 *     can reschedule, whereas a tool call that silently blocks for 90s looks
 *     like a hang and tends to get killed by the client's own timeout.
 */
async function hubspotFetch(path, { method = 'GET', query, body, scope } = {}) {
  if (!token()) {
    // Should be unreachable — callTool checks first — but this keeps the
    // invariant local to the thing that actually needs the token.
    throw new HubSpotError('HUBSPOT_ACCESS_TOKEN is not set.');
  }

  const url = new URL(path, HUBSPOT_BASE);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    // HubSpot repeats the key for multi-valued params (?properties=a&properties=b).
    if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
    else url.searchParams.set(key, String(value));
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      lastError = new HubSpotError(
        `Could not reach HubSpot (${cause.name === 'TimeoutError' ? 'timed out' : cause.message}). ` +
        'Check network egress from this host to api.hubapi.com.',
        { retryable: true },
      );
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffFor(attempt, null));
        continue;
      }
      throw lastError;
    }

    if (res.ok) return res.status === 204 ? null : res.json();

    const failure = await describeFailure(res, scope);
    if (!failure.retryable || attempt === MAX_ATTEMPTS) throw failure;

    const wait = backoffFor(attempt, res.headers.get('retry-after'));
    if (wait === null) throw failure; // Retry-After exceeded our cap; hand it back.
    log(`${failure.status} on ${method} ${path} — attempt ${attempt}/${MAX_ATTEMPTS}, waiting ${wait}ms`);
    await sleep(wait);
    lastError = failure;
  }
  throw lastError;
}

/**
 * Exponential backoff with jitter, but Retry-After wins when HubSpot sends one.
 * Returns null when the server asked us to wait longer than we are willing to
 * block a tool call for.
 */
function backoffFor(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      const ms = seconds * 1000;
      return ms > MAX_BACKOFF_MS ? null : ms;
    }
  }
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(exponential * (0.5 + Math.random() / 2)); // full-ish jitter
}

// ---------------------------------------------------------------------------
// Context budget
// ---------------------------------------------------------------------------
//
// Everything a tool returns is pasted into the agent's context window. A CRM
// has millions of rows and HubSpot contacts routinely carry 300+ properties,
// most of them empty or machine-generated. Without a whitelist and a cap, one
// curious `crm_search_contacts` call can evict the agent's actual instructions
// from its own context. So: a default property whitelist per object, a hard
// ceiling on how many records any call may return, and truncation of long
// free-text values.

const MAX_RECORDS_PER_CALL = 100;
const MAX_PROPERTY_VALUE_CHARS = 500;
const MAX_REQUESTED_PROPERTIES = 40;

const CONTACT_PROPERTIES = [
  'firstname', 'lastname', 'email', 'jobtitle', 'phone',
  'company', 'website', 'city', 'state', 'country',
  'lifecyclestage', 'hs_lead_status', 'hubspot_owner_id',
  'createdate', 'lastmodifieddate',
  'notes_last_contacted', 'notes_last_activity_date', 'hs_sales_email_last_replied',
];

const COMPANY_PROPERTIES = [
  'name', 'domain', 'website', 'industry',
  'numberofemployees', 'annualrevenue',
  'city', 'state', 'country',
  'lifecyclestage', 'hs_lead_status', 'hubspot_owner_id',
  'createdate', 'notes_last_contacted', 'notes_last_activity_date',
];

/** HubSpot's internal object type ids, as returned on a list's `objectTypeId`. */
const OBJECT_TYPE_BY_ID = { '0-1': 'contacts', '0-2': 'companies' };

/** Drop empty values and clip long ones. Returns a plain, compact object. */
function trimProperties(properties) {
  const out = {};
  for (const [key, raw] of Object.entries(properties ?? {})) {
    if (raw === null || raw === undefined || raw === '') continue;
    const value = String(raw);
    out[key] = value.length > MAX_PROPERTY_VALUE_CHARS
      ? `${value.slice(0, MAX_PROPERTY_VALUE_CHARS)}…[truncated]`
      : value;
  }
  return out;
}

/** Clamp an incoming limit into [1, max] without erroring — a clamped call
 *  still makes progress, whereas an error just costs the agent another turn. */
function clampLimit(requested, fallback, max) {
  const n = Number(requested);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.trunc(n), max));
}

/** Merge caller-requested properties with the default whitelist, capped. */
function resolveProperties(requested, defaults) {
  if (!Array.isArray(requested) || requested.length === 0) return defaults;
  const merged = [...new Set([...defaults, ...requested.map(String)])];
  return merged.slice(0, MAX_REQUESTED_PROPERTIES);
}

/** Shape a raw HubSpot CRM object down to what the agent actually reads. */
function shapeRecord(record) {
  const shaped = { id: record.id, properties: trimProperties(record.properties) };
  const companies = record.associations?.companies?.results;
  if (Array.isArray(companies) && companies.length > 0) {
    shaped.associatedCompanyIds = companies.map((c) => c.id).slice(0, 10);
  }
  return shaped;
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

// MCP tool results are `{ content: [...], isError? }`. We always return exactly
// one text block holding compact JSON, so the model gets something it can parse
// rather than prose it has to interpret.
const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
const fail = (message, extra = {}) => ({
  content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }) }],
  isError: true,
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
//
// Descriptions are written for a model deciding whether to spend a call, so
// each one says what it costs and when NOT to use it. The agent has a budget;
// a tool that does not explain its cost gets called in a loop.

const tools = [
  {
    name: 'crm_get_list_members',
    description:
      'Read the records in a HubSpot list (contacts or companies), with their common properties. ' +
      'This is the normal way to load a day\'s working set, because pipeline buckets are defined as list ids. ' +
      'COST: 2-3 HubSpot calls per invocation (list metadata, then a batch read) and up to 100 records of ' +
      'context. Ask for the smallest limit that answers your question and page with `after` only if you must. ' +
      'DO NOT use this to scan an entire large list into context — if you need to find specific records by ' +
      'criteria, use crm_search_contacts or crm_search_companies instead, which filters server-side. ' +
      'Only contact lists and company lists are supported; other object types return an error.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The HubSpot ILS list id (the numeric id from the Lists API, as a string).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RECORDS_PER_CALL,
          default: 25,
          description: `Records to return, 1-${MAX_RECORDS_PER_CALL}. Defaults to 25. Values above the maximum are clamped.`,
        },
        after: {
          type: 'string',
          description: 'Paging cursor from a previous call\'s `nextAfter`. Omit for the first page.',
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Extra property names to fetch on top of the default set. Use only for properties specific to ' +
            'this tenant (custom fields); the common ones are already included.',
        },
      },
      required: ['list_id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const listId = String(args.list_id ?? '').trim();
      if (!listId) return fail('list_id is required.');

      // Ask the list what kind of records it holds rather than guessing. A
      // company list read as contacts returns confidently wrong data.
      const meta = await hubspotFetch(`/crm/v3/lists/${encodeURIComponent(listId)}`, {
        scope: 'crm.lists.read',
      });
      const objectTypeId = meta?.list?.objectTypeId;
      const objectType = OBJECT_TYPE_BY_ID[objectTypeId];
      if (!objectType) {
        return fail(
          `List ${listId} holds object type "${objectTypeId}", which this adapter does not read. ` +
          'Only contact lists (0-1) and company lists (0-2) are supported.',
        );
      }

      const limit = clampLimit(args.limit, 25, MAX_RECORDS_PER_CALL);
      const memberships = await hubspotFetch(
        `/crm/v3/lists/${encodeURIComponent(listId)}/memberships`,
        { query: { limit, after: args.after }, scope: 'crm.lists.read' },
      );

      const ids = (memberships?.results ?? []).map((m) => m.recordId).filter(Boolean);
      const nextAfter = memberships?.paging?.next?.after ?? null;

      if (ids.length === 0) {
        return ok({ listId, listName: meta?.list?.name ?? null, objectType, count: 0, records: [], nextAfter });
      }

      const defaults = objectType === 'contacts' ? CONTACT_PROPERTIES : COMPANY_PROPERTIES;
      const scope = objectType === 'contacts' ? 'crm.objects.contacts.read' : 'crm.objects.companies.read';
      // One batch read for the whole page. `limit` is capped at 100, which is
      // also HubSpot's batch-read ceiling, so this is always a single call.
      const batch = await hubspotFetch(`/crm/v3/objects/${objectType}/batch/read`, {
        method: 'POST',
        body: { inputs: ids.map((id) => ({ id })), properties: resolveProperties(args.properties, defaults) },
        scope,
      });

      return ok({
        listId,
        listName: meta?.list?.name ?? null,
        processingType: meta?.list?.processingType ?? null,
        objectType,
        count: batch?.results?.length ?? 0,
        records: (batch?.results ?? []).map(shapeRecord),
        nextAfter,
      });
    },
  },

  {
    name: 'crm_get_contact',
    description:
      'Read one contact by record id or by email address, including the id of the company it is associated with. ' +
      'COST: one HubSpot call, one record of context — cheap. ' +
      'DO NOT call this in a loop over many ids: use crm_get_list_members for a list, or crm_search_contacts ' +
      'with an IN filter, both of which fetch many records in one call. ' +
      'Exactly one of `contact_id` or `email` must be given.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'HubSpot contact record id.' },
        email: { type: 'string', description: 'Contact email address. Used as the lookup key when contact_id is absent.' },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra property names on top of the default set (tenant-specific custom fields).',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const contactId = String(args.contact_id ?? '').trim();
      const email = String(args.email ?? '').trim();
      if (!contactId && !email) return fail('Provide either contact_id or email.');
      if (contactId && email) return fail('Provide only one of contact_id or email, not both.');

      // HubSpot looks a record up by a non-id property when you pass
      // `idProperty` — the path segment then holds that property's value.
      const key = contactId || email;
      const record = await hubspotFetch(`/crm/v3/objects/contacts/${encodeURIComponent(key)}`, {
        query: {
          properties: resolveProperties(args.properties, CONTACT_PROPERTIES),
          associations: 'companies',
          idProperty: contactId ? undefined : 'email',
        },
        scope: 'crm.objects.contacts.read',
      });
      return ok(shapeRecord(record));
    },
  },

  {
    name: 'crm_get_company',
    description:
      'Read one company by record id or by domain. ' +
      'COST: one HubSpot call (two when looking up by domain, which goes through search), one record of context. ' +
      'DO NOT use this to check many domains — use crm_search_companies with an IN filter on domain, which ' +
      'answers up to 200 domains in a single call. ' +
      'Exactly one of `company_id` or `domain` must be given.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'HubSpot company record id.' },
        domain: { type: 'string', description: 'Company domain, e.g. "acme.com". Bare domain, no scheme or path.' },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra property names on top of the default set (tenant-specific custom fields).',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const companyId = String(args.company_id ?? '').trim();
      const domain = String(args.domain ?? '').trim().toLowerCase();
      if (!companyId && !domain) return fail('Provide either company_id or domain.');
      if (companyId && domain) return fail('Provide only one of company_id or domain, not both.');

      const properties = resolveProperties(args.properties, COMPANY_PROPERTIES);

      if (companyId) {
        const record = await hubspotFetch(`/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, {
          query: { properties },
          scope: 'crm.objects.companies.read',
        });
        return ok(shapeRecord(record));
      }

      // `domain` is not a unique id in HubSpot — duplicates are common in
      // messy portals — so we search and report every match rather than
      // silently picking one and pretending it is "the" company.
      const found = await hubspotFetch('/crm/v3/objects/companies/search', {
        method: 'POST',
        body: {
          filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] }],
          properties,
          limit: 10,
        },
        scope: 'crm.objects.companies.read',
      });
      const records = (found?.results ?? []).map(shapeRecord);
      if (records.length === 0) return ok({ domain, matches: 0, records: [] });
      return ok({ domain, matches: found?.total ?? records.length, records });
    },
  },

  {
    name: 'crm_search_contacts',
    description:
      'Find contacts by property filters, server-side. This is the right tool whenever you know the criteria ' +
      'but not the ids — for example "contacts in this lifecycle stage owned by this rep and not contacted in 30 days". ' +
      'COST: one HubSpot call and up to 100 records of context. HubSpot caps search at 200 results per page and ' +
      '10,000 results total per query, and rate-limits search harder than other endpoints (about 5 requests/second). ' +
      'DO NOT use this to fetch a known list — crm_get_list_members is cheaper and returns list metadata too. ' +
      'Filters within one group are ANDed; separate groups are ORed.',
    inputSchema: {
      type: 'object',
      properties: {
        filter_groups: {
          type: 'array',
          maxItems: 5,
          description:
            'Up to 5 groups, each with up to 6 filters (18 filters total, HubSpot\'s limit). ' +
            'Filters inside a group are ANDed together; the groups are ORed.',
          items: {
            type: 'object',
            properties: {
              filters: {
                type: 'array',
                maxItems: 6,
                items: {
                  type: 'object',
                  properties: {
                    propertyName: { type: 'string', description: 'HubSpot internal property name, e.g. "lifecyclestage".' },
                    operator: {
                      type: 'string',
                      enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN',
                        'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN'],
                      description:
                        'BETWEEN also needs highValue. IN/NOT_IN use `values` and require lowercase strings. ' +
                        'HAS_PROPERTY/NOT_HAS_PROPERTY take no value.',
                    },
                    value: { type: ['string', 'number', 'boolean'], description: 'Single value, for most operators.' },
                    highValue: { type: ['string', 'number'], description: 'Upper bound, BETWEEN only.' },
                    values: { type: 'array', items: { type: 'string' }, description: 'Value list, IN/NOT_IN only.' },
                  },
                  required: ['propertyName', 'operator'],
                  additionalProperties: false,
                },
              },
            },
            required: ['filters'],
            additionalProperties: false,
          },
        },
        query: { type: 'string', description: 'Free-text search across default searchable fields. Combine with filters or use alone.' },
        sorts: {
          type: 'array',
          maxItems: 1,
          description: 'HubSpot honours a single sort.',
          items: {
            type: 'object',
            properties: {
              propertyName: { type: 'string' },
              direction: { type: 'string', enum: ['ASCENDING', 'DESCENDING'] },
            },
            required: ['propertyName', 'direction'],
            additionalProperties: false,
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RECORDS_PER_CALL, default: 25, description: `1-${MAX_RECORDS_PER_CALL}, default 25.` },
        after: { type: 'string', description: 'Paging cursor from a previous call\'s `nextAfter`.' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Extra property names on top of the default set.' },
      },
      additionalProperties: false,
    },
    handler: (args) => runSearch('contacts', args, CONTACT_PROPERTIES, 'crm.objects.contacts.read'),
  },

  {
    name: 'crm_search_companies',
    description:
      'Find companies by property filters, server-side. Use it to qualify accounts against ICP criteria ' +
      '(industry, size, lifecycle stage, owner) or to resolve many domains at once with an IN filter. ' +
      'COST: one HubSpot call and up to 100 records of context. Same HubSpot limits as contact search: ' +
      '200 per page, 10,000 total per query, ~5 requests/second. ' +
      'DO NOT call it once per account in a loop — build one IN filter instead.',
    inputSchema: {
      type: 'object',
      properties: {
        filter_groups: {
          type: 'array',
          maxItems: 5,
          description: 'Up to 5 groups of up to 6 filters. Filters in a group are ANDed; groups are ORed.',
          items: {
            type: 'object',
            properties: {
              filters: {
                type: 'array',
                maxItems: 6,
                items: {
                  type: 'object',
                  properties: {
                    propertyName: { type: 'string', description: 'HubSpot internal property name, e.g. "industry".' },
                    operator: {
                      type: 'string',
                      enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN',
                        'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN'],
                      description: 'BETWEEN needs highValue; IN/NOT_IN use lowercase `values`.',
                    },
                    value: { type: ['string', 'number', 'boolean'] },
                    highValue: { type: ['string', 'number'] },
                    values: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['propertyName', 'operator'],
                  additionalProperties: false,
                },
              },
            },
            required: ['filters'],
            additionalProperties: false,
          },
        },
        query: { type: 'string', description: 'Free-text search across default searchable fields.' },
        sorts: {
          type: 'array',
          maxItems: 1,
          items: {
            type: 'object',
            properties: {
              propertyName: { type: 'string' },
              direction: { type: 'string', enum: ['ASCENDING', 'DESCENDING'] },
            },
            required: ['propertyName', 'direction'],
            additionalProperties: false,
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RECORDS_PER_CALL, default: 25, description: `1-${MAX_RECORDS_PER_CALL}, default 25.` },
        after: { type: 'string', description: 'Paging cursor from a previous call\'s `nextAfter`.' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Extra property names on top of the default set.' },
      },
      additionalProperties: false,
    },
    handler: (args) => runSearch('companies', args, COMPANY_PROPERTIES, 'crm.objects.companies.read'),
  },

  {
    name: 'crm_get_owners',
    description:
      'List the CRM owners (sales reps) in the account: owner id, email, and name. Use it once per run to turn ' +
      'the `hubspot_owner_id` on a record into a human, and to decide who a draft should be routed to for approval. ' +
      'COST: one HubSpot call. Most accounts have few enough owners to return in a single page. ' +
      'DO NOT call this per record — fetch it once and reuse the mapping for the rest of the run. ' +
      'Note: `id` is the owner id used on records; `userId` is a different number and cannot be used to assign ownership.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Filter to the single owner with this email address.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RECORDS_PER_CALL, default: 100, description: `1-${MAX_RECORDS_PER_CALL}, default 100.` },
        after: { type: 'string', description: 'Paging cursor from a previous call\'s `nextAfter`.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const data = await hubspotFetch('/crm/v3/owners', {
        query: {
          email: args.email,
          limit: clampLimit(args.limit, 100, MAX_RECORDS_PER_CALL),
          after: args.after,
          archived: false,
        },
        scope: 'crm.objects.owners.read',
      });
      return ok({
        count: data?.results?.length ?? 0,
        owners: (data?.results ?? []).map((o) => ({
          id: o.id,
          email: o.email ?? null,
          name: [o.firstName, o.lastName].filter(Boolean).join(' ') || null,
          userId: o.userId ?? null,
        })),
        nextAfter: data?.paging?.next?.after ?? null,
      });
    },
  },

  {
    name: 'crm_get_contact_activity',
    description:
      'Read the most recent logged activity on a contact — notes, calls, emails, meetings, tasks — newest first. ' +
      'This is how you tell whether a human has already reached out, which is the single check that stops the agent ' +
      'from talking over a rep who is mid-conversation. Always run it before drafting outreach to a known contact. ' +
      'COST: ONE HubSpot search call PER activity type requested, against the endpoint with the tightest rate limit ' +
      '(~5 requests/second). Requesting all five types is five calls. Ask for the types you actually need. ' +
      'DO NOT use this to reconstruct full history — it returns a recent window, not an archive. ' +
      'Email bodies may be blank unless the private app also has the sales-email-read scope.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'HubSpot contact record id (not an email).' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['notes', 'calls', 'emails', 'meetings', 'tasks'] },
          description: 'Activity types to fetch. Defaults to ["emails","calls","meetings"] — the ones that show human contact.',
        },
        limit_per_type: { type: 'integer', minimum: 1, maximum: 25, default: 5, description: 'Most recent N of each type, 1-25. Default 5.' },
      },
      required: ['contact_id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const contactId = String(args.contact_id ?? '').trim();
      if (!contactId) return fail('contact_id is required.');

      const requested = Array.isArray(args.types) && args.types.length > 0
        ? args.types.filter((t) => ENGAGEMENTS[t])
        : ['emails', 'calls', 'meetings'];
      if (requested.length === 0) {
        return fail(`No valid activity types requested. Valid types: ${Object.keys(ENGAGEMENTS).join(', ')}.`);
      }
      const limit = clampLimit(args.limit_per_type, 5, 25);

      const activities = [];
      const unavailable = [];
      for (const type of requested) {
        const spec = ENGAGEMENTS[type];
        try {
          const found = await hubspotFetch(`/crm/v3/objects/${type}/search`, {
            method: 'POST',
            body: {
              // `associations.contact` is HubSpot's pseudo-property for
              // "engagements associated with this contact".
              filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'EQ', value: contactId }] }],
              properties: spec.properties,
              sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
              limit,
            },
            scope: spec.scope,
          });
          for (const item of found?.results ?? []) {
            activities.push({ type, id: item.id, timestamp: item.properties?.hs_timestamp ?? null, ...trimProperties(item.properties) });
          }
        } catch (error) {
          // One activity type being unreadable (commonly a missing scope) must
          // not blank out the others. Partial history plus an explicit note is
          // far more useful to the agent than a single hard failure, which it
          // would probably read as "no activity" and then act on.
          if (!(error instanceof HubSpotError)) throw error;
          unavailable.push({ type, reason: error.message });
        }
      }

      activities.sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));

      return ok({
        contactId,
        typesRequested: requested,
        count: activities.length,
        mostRecentTimestamp: activities[0]?.timestamp ?? null,
        activities,
        ...(unavailable.length ? { unavailable } : {}),
      });
    },
  },

  {
    name: 'crm_update_property',
    description:
      'Update properties on ONE contact or ONE company. This is the only tool in this adapter that changes anything ' +
      'in the CRM, and it is disabled unless the operator sets CRM_WRITES_ENABLED=1 in the environment. ' +
      'Use it only for agent bookkeeping the operator has explicitly asked for — stamping a "last touched by agent" ' +
      'date, setting a lead status after an approved send. ' +
      'COST: one HubSpot call, but unlike every other tool here the effect is PERMANENT and visible to the whole ' +
      'sales team, and HubSpot keeps no undo. ' +
      'DO NOT use it to fix data you merely believe is wrong, to reassign ownership, or to move a lifecycle stage ' +
      'that a workflow depends on. It cannot create records, cannot delete them, and cannot write to more than one ' +
      `record per call. At most ${10} properties per call.`,
    inputSchema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', enum: ['contacts', 'companies'], description: 'Which object to update.' },
        object_id: { type: 'string', description: 'The record id. Exactly one record per call — there is no bulk form.' },
        properties: {
          type: 'object',
          description:
            'Map of HubSpot internal property name to new value. Values must be strings, numbers or booleans. ' +
            'null is rejected. An empty string CLEARS the property in HubSpot and therefore requires allow_clear.',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
          minProperties: 1,
          maxProperties: 10,
        },
        allow_clear: {
          type: 'boolean',
          default: false,
          description: 'Must be true to write an empty string, because an empty string erases the existing value.',
        },
      },
      required: ['object_type', 'object_id', 'properties'],
      additionalProperties: false,
    },
    handler: async (args) => {
      // ------------------------------------------------------------------
      // THE WRITE GATE
      // ------------------------------------------------------------------
      // An outbound agent with a CRM write credential is one bad inference
      // away from rewriting a company's pipeline, and CRM writes fan out:
      // they fire workflows, they move deal stages, they notify reps. So the
      // capability is off unless a human turned it on out-of-band, in the
      // environment, where the model cannot reach.
      //
      // The check is `=== '1'` and nothing else. No truthiness, no "true",
      // no "yes" — because a gate that accepts several spellings is a gate
      // that opens by accident when some deploy script sets the variable to
      // the wrong thing. Unset means closed. Anything unexpected means closed.
      if (process.env.CRM_WRITES_ENABLED !== '1') {
        return fail(
          'CRM writes are disabled. This agent is running read-only because CRM_WRITES_ENABLED is not set to "1" ' +
          `(current value: ${process.env.CRM_WRITES_ENABLED === undefined ? 'unset' : JSON.stringify(process.env.CRM_WRITES_ENABLED)}). ` +
          'This is a deliberate safety gate, not a bug, and you cannot turn it on yourself. ' +
          'Continue without the write and tell the operator what you would have changed — they can set ' +
          'CRM_WRITES_ENABLED=1 in the environment and re-run if they want it applied.',
          { gate: 'CRM_WRITES_ENABLED', writesEnabled: false },
        );
      }

      const objectType = String(args.object_type ?? '');
      if (!['contacts', 'companies'].includes(objectType)) {
        return fail('object_type must be "contacts" or "companies". No other object type is writable here.');
      }
      const objectId = String(args.object_id ?? '').trim();
      if (!objectId) return fail('object_id is required. This tool updates exactly one record per call.');

      const properties = args.properties;
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
        return fail('properties must be an object mapping property names to values.');
      }
      const entries = Object.entries(properties);
      if (entries.length === 0) return fail('properties is empty — nothing to update.');
      if (entries.length > 10) {
        return fail(`Too many properties (${entries.length}). At most 10 per call, so a single mistaken call cannot rewrite a whole record.`);
      }

      const payload = {};
      for (const [name, value] of entries) {
        // HubSpot treats null and "" as "erase this property". Erasing data is
        // the closest thing to a delete this adapter could ever do, so it is
        // never the default reading of a value the model produced.
        if (value === null || value === undefined) {
          return fail(`Property "${name}" is null, which HubSpot treats as clearing the value. Pass an empty string with allow_clear: true if you really mean to erase it.`);
        }
        if (typeof value === 'object') {
          return fail(`Property "${name}" must be a string, number or boolean.`);
        }
        if (value === '' && args.allow_clear !== true) {
          return fail(`Property "${name}" is an empty string, which erases its current value in HubSpot. Set allow_clear: true if that is intended.`);
        }
        if (READ_ONLY_PROPERTIES.has(name)) {
          return fail(`Property "${name}" is managed by HubSpot and cannot be written.`);
        }
        payload[name] = String(value);
      }

      const scope = objectType === 'contacts' ? 'crm.objects.contacts.write' : 'crm.objects.companies.write';
      const updated = await hubspotFetch(`/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}`, {
        method: 'PATCH',
        body: { properties: payload },
        scope,
      });

      log(`WRITE ${objectType}/${objectId}: ${Object.keys(payload).join(', ')}`);
      return ok({
        updated: true,
        objectType,
        id: updated?.id ?? objectId,
        propertiesWritten: Object.keys(payload),
        updatedAt: updated?.updatedAt ?? null,
      });
    },
  },
];

/** Properties HubSpot computes itself. Rejecting them here gives a better
 *  message than the 400 HubSpot would return. */
const READ_ONLY_PROPERTIES = new Set([
  'hs_object_id', 'createdate', 'lastmodifieddate', 'hs_lastmodifieddate', 'hs_createdate',
]);

/** Per engagement type: the properties worth reading, and the scope it needs. */
const ENGAGEMENTS = {
  notes: {
    properties: ['hs_timestamp', 'hs_note_body', 'hubspot_owner_id'],
    scope: 'crm.objects.contacts.read',
  },
  calls: {
    properties: ['hs_timestamp', 'hs_call_title', 'hs_call_body', 'hs_call_direction', 'hs_call_duration', 'hs_call_disposition', 'hubspot_owner_id'],
    scope: 'crm.objects.contacts.read',
  },
  emails: {
    properties: ['hs_timestamp', 'hs_email_subject', 'hs_email_text', 'hs_email_direction', 'hs_email_status', 'hubspot_owner_id'],
    scope: 'sales-email-read',
  },
  meetings: {
    properties: ['hs_timestamp', 'hs_meeting_title', 'hs_meeting_outcome', 'hs_meeting_start_time', 'hubspot_owner_id'],
    scope: 'crm.objects.contacts.read',
  },
  tasks: {
    properties: ['hs_timestamp', 'hs_task_subject', 'hs_task_status', 'hs_task_priority', 'hubspot_owner_id'],
    scope: 'crm.objects.contacts.read',
  },
};

/** Shared body for the two search tools — they differ only in object type. */
async function runSearch(objectType, args, defaults, scope) {
  const filterGroups = Array.isArray(args.filter_groups) ? args.filter_groups : [];
  if (filterGroups.length === 0 && !args.query) {
    return fail(
      'Give at least one filter group or a `query`. An unfiltered search would page through the whole ' +
      'object type, which is slow, rate-limited, and floods your context with records you did not ask for.',
    );
  }

  const body = {
    properties: resolveProperties(args.properties, defaults),
    limit: clampLimit(args.limit, 25, MAX_RECORDS_PER_CALL),
  };
  if (filterGroups.length > 0) body.filterGroups = filterGroups;
  if (args.query) body.query = String(args.query);
  if (Array.isArray(args.sorts) && args.sorts.length > 0) body.sorts = args.sorts.slice(0, 1);
  if (args.after) body.after = String(args.after);

  const found = await hubspotFetch(`/crm/v3/objects/${objectType}/search`, { method: 'POST', body, scope });

  return ok({
    objectType,
    // HubSpot caps `total` reporting and the whole query at 10,000 results;
    // say so rather than letting the agent believe it has seen everything.
    total: found?.total ?? null,
    count: found?.results?.length ?? 0,
    records: (found?.results ?? []).map(shapeRecord),
    nextAfter: found?.paging?.next?.after ?? null,
  });
}

const TOOLS_BY_NAME = new Map(tools.map((t) => [t.name, t]));

/** The wire form of a tool: everything except our `handler`. */
const toolDescriptors = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function callTool(params) {
  const name = params?.name;
  const tool = TOOLS_BY_NAME.get(name);
  // An unknown tool name is a protocol-level error, not a tool result.
  if (!tool) throw { code: -32602, message: `Unknown tool: ${name}` };

  // Missing credentials are reported per-call, never at startup. If this
  // process exited when HUBSPOT_ACCESS_TOKEN was absent, the client would see
  // only "MCP server failed to start" and the operator would go looking for a
  // broken server instead of an unset variable. Staying up and answering
  // `tools/list` also lets the agent explain precisely what is missing.
  if (!token()) {
    return fail(
      'HUBSPOT_ACCESS_TOKEN is not set in this process\'s environment, so no CRM data can be read. ' +
      'The operator needs to add a HubSpot private-app token to the .env file (or the container environment) ' +
      'and restart. Nothing this tool does will work until then — do not retry.',
      { missingCredential: 'HUBSPOT_ACCESS_TOKEN' },
    );
  }

  try {
    return await tool.handler(params?.arguments ?? {});
  } catch (error) {
    // HubSpot problems come back as tool results with isError, not as JSON-RPC
    // errors: the spec's guidance is that the model should see failures it
    // might recover from (wrong id, missing scope, rate limit) as tool output.
    if (error instanceof HubSpotError) return fail(error.message, { status: error.status });
    log(`unexpected failure in ${name}:`, error?.stack || error);
    return fail(`The ${name} tool failed unexpectedly: ${error?.message ?? String(error)}`);
  }
}

async function handleRequest(id, method, params) {
  switch (method) {
    case 'initialize': {
      // Version negotiation: echo the client's version when we speak it,
      // otherwise answer with our newest and let the client decide whether it
      // can live with that (it disconnects if it cannot).
      const requested = params?.protocolVersion;
      const agreed = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PREFERRED_PROTOCOL_VERSION;
      log(`initialize from ${params?.clientInfo?.name ?? 'unknown client'} ` +
        `(requested ${requested ?? 'nothing'}, answering ${agreed})`);
      return reply(id, {
        protocolVersion: agreed,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Read-mostly HubSpot adapter. Prefer crm_get_list_members for a known list and the search tools ' +
          'when you know criteria but not ids. Always check crm_get_contact_activity before drafting outreach ' +
          'to a contact, so you do not talk over a rep who is already in the conversation. ' +
          'crm_update_property is the only write and stays disabled unless the operator enabled it.',
      });
    }

    case 'ping':
      // Ping's result is an empty object. Clients use it as a liveness check.
      return reply(id, {});

    case 'tools/list':
      return reply(id, { tools: toolDescriptors });

    case 'tools/call':
      return reply(id, await callTool(params));

    default:
      // Includes `server/discover`: answering -32601 is what tells a dual-era
      // client to fall back to the `initialize` handshake. See the header note.
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    // We have no id to answer with, so JSON-RPC says use null.
    return replyError(null, -32700, 'Parse error: message was not valid JSON.');
  }

  const { id, method, params } = message ?? {};

  // A response has no method — that would be an answer to something we sent,
  // and this server never sends requests, so there is nothing to do with it.
  if (typeof method !== 'string') return;

  // Notifications carry no id and MUST NOT be answered, not even on error.
  // `notifications/initialized` is the handshake's third leg; everything else
  // (cancelled, progress, roots/list_changed…) is safe for us to ignore.
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('client reported initialized');
    else log(`ignoring notification: ${method}`);
    return;
  }

  try {
    await handleRequest(id, method, params);
  } catch (error) {
    // Thrown objects with a numeric `code` are deliberate protocol errors.
    if (error && typeof error.code === 'number') return replyError(id, error.code, error.message);
    log('internal error:', error?.stack || error);
    replyError(id, -32603, `Internal error: ${error?.message ?? String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

// Messages are newline-delimited JSON, but a read can deliver half a message or
// several at once, so we buffer until we actually have a newline. Messages are
// handled in order: each one awaits the previous, so a slow HubSpot call cannot
// let a later response overtake an earlier one on the wire.
let buffer = '';
let queue = Promise.resolve();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue; // tolerate blank lines and \r\n
    queue = queue.then(() => handleMessage(line)).catch((e) => log('handler crashed:', e?.stack || e));
  }
});

// The client shuts us down by closing our stdin (that is the spec's shutdown
// sequence for stdio). Drain whatever is still in flight, then let the event
// loop empty on its own.
//
// Deliberately NOT `process.exit()`. When stdout is a pipe — which it always is
// here — writes can still be queued in the kernel, and process.exit() discards
// them, so the last tool result of a session can be silently truncated. It also
// races handle teardown on Windows, which surfaces as an intermittent libuv
// assertion ("UV_HANDLE_CLOSING") and a crash instead of a clean exit. Setting
// exitCode and returning lets Node flush and exit on its own terms.
process.stdin.on('end', () => {
  queue.finally(() => {
    process.exitCode = 0;
  });
});

// A crash must not take the transport down silently mid-session; log loudly to
// stderr so the failure is visible in the agent's own logs.
process.on('uncaughtException', (e) => log('uncaught exception:', e?.stack || e));
process.on('unhandledRejection', (e) => log('unhandled rejection:', e?.stack || e));

log(`ready — ${tools.length} tools, protocol ${PREFERRED_PROTOCOL_VERSION}, ` +
  `token ${token() ? 'present' : 'MISSING (tools/list works, every tools/call will error)'}, ` +
  `writes ${process.env.CRM_WRITES_ENABLED === '1' ? 'ENABLED' : 'disabled'}`);
