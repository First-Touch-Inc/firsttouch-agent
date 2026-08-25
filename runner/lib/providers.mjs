// Real provider adapters, implementing the interfaces that tools-core.mjs
// (the model's tool surface) and apply.mjs (the deterministic apply path)
// consume. This is the ONLY file that touches provider credentials, and it
// runs in trusted processes only — the tool server and the host. The model's
// environment never contains these tokens.
//
// Every FirstTouch call goes through the platform's MCP over streamable HTTP
// (runner/lib/mcp-client.mjs); HubSpot goes through its REST API directly.
// Each mapped platform tool name is an ACCEPTANCE CRITERION: preflight calls
// the cheap ones and refuses to start if the platform does not answer, so a
// renamed upstream tool fails at boot, loudly, not mid-apply.

import { connect } from './mcp-client.mjs';

const FT_URL = () => process.env.FT_MCP_URL || 'https://mcp.firsttouch.ai';

function parseJsonText(text, context) {
  try {
    return JSON.parse(text);
  } catch {
    // Some tools answer prose. Callers that need structure handle `raw`.
    return { raw: text, __unparsed: context };
  }
}

/** The FirstTouch adapter: reads, enrichment, action staging and completion. */
export async function firsttouchProvider({
  token = process.env.FT_MCP_TOKEN,
  dryRun = process.env.DRY_RUN === '1',
  connectImpl = connect,
} = {}) {
  if (!token) throw new Error('FT_MCP_TOKEN is not set — the FirstTouch adapter cannot start.');
  let client = await connectImpl({ url: FT_URL(), token });

  // One long-lived session is reused for the host's lifetime. A server that
  // idle-kills the session, or a transient network drop, would otherwise fail
  // every call forever. On a transport error, reconnect ONCE and retry — but
  // never on a tool-level isError (that is a real refusal, not a dead session).
  const call = async (name, args) => {
    try {
      const { text, isError } = await client.callTool(name, args);
      if (isError) throw new Error(`${name}: ${text.slice(0, 400)}`);
      return parseJsonText(text, name);
    } catch (e) {
      if (/\b(session|connect|reach|respond|network|socket|ECONN|timed out|initialize)\b/i.test(e.message)) {
        client = await connectImpl({ url: FT_URL(), token });
        const { text, isError } = await client.callTool(name, args);
        if (isError) throw new Error(`${name}: ${text.slice(0, 400)}`);
        return parseJsonText(text, name);
      }
      throw e;
    }
  };

  // In a dry run NOTHING that changes the outside world may happen — not even
  // when a human clicks Approve on a card. The apply path surfaces the thrown
  // error as a conflict, so the card shows "not applied (dry run)" instead of
  // sending. This is the last line: DRY_RUN is also gated upstream, but a
  // provider that refuses is the guarantee.
  const noMutations = (name) => async () => {
    throw new Error(`DRY_RUN is on — refusing to ${name}. Unset DRY_RUN to let approvals actually send.`);
  };

  const api = {
    // --- free reads (tools-core) ---
    listTeamMembers: () => call('list_team_members', {}),
    listSenderConnections: () => call('list_linkedin_team_connections', {}),
    getCurrentUser: () => call('get_current_user', {}),

    // --- source sweeps: the warm signals the motions advertise ---
    // Engagers on a monitored LinkedIn profile/company (likes, comments).
    listEngagers: (args) => call('list_social_engagement_engagers', args ?? {}),
    // A HubSpot list PREVIEW returns hydrated contacts (name, email, title),
    // unlike raw membership which is bare ids — this is what a sweep needs.
    // (The live tool takes only listId.)
    previewList: ({ list_id }) => call('preview_hubspot_list', { listId: list_id }),
    // Prospect discovery from ICP filters (chat campaigns like "VPs of Sales
    // in Nebraska").
    discoverContacts: (filters) => call('discover_contacts', filters ?? {}),

    // --- paid reads (tools-core, behind the enrichment enum) ---
    enrichPerson: (subject) => call('enrich_contact', {
      linkedinUrl: subject.linkedin_url, email: subject.email,
    }),
    enrichCompany: (subject) => call('enrich_company', {
      domain: subject.company_domain,
    }),
    findEmail: (subject) => call('find_contact_data', {
      name: subject.name, companyDomain: subject.company_domain,
    }),

    // --- the apply path (apply.mjs `platform` interface) ---
    // Contracts verified against the live FirstTouch MCP tool schemas.

    // Split a subject "name" into first/last — add_dynamic_action REQUIRES both
    // on every action's effective identity, so we never send a bare name.
    // eslint-disable-next-line no-inner-declarations

    async findAction({ subject, ownerProviderId }) {
      // list_user_tasks: statuses defaults to ['todo']; filter by the same
      // owner and match the prospect by email.
      const res = await call('list_user_tasks', {
        assignedUserId: ownerProviderId, statuses: ['todo'],
        email: subject?.email ?? undefined,
      });
      const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
      if (!tasks.length) return null;
      return { task_ids: tasks.map((t) => t.taskId ?? t.id).filter(Boolean) };
    },

    // Create an approval-gated enrollment for one contact, one action per step,
    // chained by enrollmentId. isHumanApprovalRequired:true materialises a task
    // that does NOT execute until complete_task ("Approve & Run") — that two-
    // phase shape is what lets the apply path verify before it sends.
    async createAction({ subject, steps, ownerProviderId }) {
      const [firstName, ...rest] = String(subject.name ?? '').trim().split(/\s+/);
      const lastName = rest.join(' ');
      const contact = {
        firstName: subject.first_name ?? firstName ?? undefined,
        lastName: subject.last_name ?? (lastName || undefined),
        email: subject.email ?? undefined,
        linkedInUrl: subject.linkedin_url ?? undefined,
        phone: subject.phone ?? undefined,
      };
      const company = subject.company_domain ? { domain: subject.company_domain } : undefined;

      let enrollmentId = null;
      const taskIds = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const type = mapChannel(s.channel);
        const action = {
          type,
          assignedUserId: ownerProviderId,
          isHumanApprovalRequired: true,
          message: type === 'linkedin_inmail' ? undefined : s.copy,
          prompt: type === 'linkedin_inmail' ? s.copy : undefined,
        };
        if (type === 'email') {
          // First email opens a new thread and needs a subject; later ones on
          // the same enrollment reply and inherit it.
          if (i === 0 || !enrollmentId) { action.subjectType = 'new_thread'; action.subject = s.subject ?? '(no subject)'; }
          else { action.subjectType = 'reply'; }
        }
        const res = await call('add_dynamic_action', {
          action,
          contact,
          company,
          ownerId: ownerProviderId,
          ...(enrollmentId ? { enrollmentId } : {}),
        });
        enrollmentId = res?.enrollmentId ?? enrollmentId;
        const ids = res?.taskIds ?? (res?.taskId ? [res.taskId] : []);
        for (const id of ids) if (id) taskIds.push(id);
        // taskIdsPending/taskMaterializationStatus can defer id availability;
        // the apply path re-reads via readTask, and findAction re-locates on a
        // retry, so a briefly-empty taskIds does not lose the work.
      }
      if (!enrollmentId) {
        throw new Error(`add_dynamic_action returned no enrollmentId (${JSON.stringify(steps).slice(0, 120)})`);
      }
      return { task_ids: taskIds, enrollment_id: enrollmentId };
    },

    async readTask(taskId) {
      const res = await call('preview_task', { taskId, includeProperties: true });
      const task = res?.task ?? res;
      const status = String(task?.status ?? '').toLowerCase();
      // Copy lives in task.properties (PropertyValueDto[]); pull the message/
      // body property if present. verifyAndComplete FAILS CLOSED on a copy it
      // cannot confirm, so if we cannot locate it we say so explicitly. An
      // operator who has confirmed via a shadow run that the platform stores
      // exactly what we send may set OUTREACH_TRUST_CREATE_COPY=1 to rely on
      // the create-time guarantee instead — a conscious opt-in, never default.
      const props = Array.isArray(task?.properties) ? task.properties : [];
      const bodyProp = props.find((p) => /message|body|content|copy|text/i.test(p?.name ?? p?.key ?? ''));
      const copy = bodyProp?.value ?? null;
      return {
        status: status === 'done' ? 'completed' : status === 'canceled' || status === 'cancelled' ? 'cancelled' : 'open',
        copy,
        copy_unverifiable: copy == null && process.env.OUTREACH_TRUST_CREATE_COPY === '1',
        owner_provider_id: task?.assignedUserId ?? task?.ownerId ?? null,
        can_execute: res?.readiness?.canExecute ?? task?.readiness?.canExecute ?? true,
      };
    },

    completeTask: (taskId) => call('complete_task', { taskId }),

    async cancelAction(taskIds) {
      // skip_task skips a todo task without cancelling the enrollment — good
      // enough to stop a wrong-owner step from being actioned. (Full enrollment
      // cancellation is cancel_flow_enrollments, used only when we hold an
      // enrollmentId; a skipped un-executed task never sends regardless.)
      for (const taskId of taskIds) {
        await call('skip_task', { taskId }).catch(() => {});
      }
    },

    // Enrol into a DECLARED flow. Real shape: nested manualEnrollment with
    // prospect/company; enrollmentMode omitted lets the flow's own strategy
    // decide (a draft flow parks the contact in Awaiting).
    enrolFlow: ({ flow_id, subject }) => {
      const [firstName, ...rest] = String(subject.name ?? '').trim().split(/\s+/);
      return call('add_manual_flow_enrollment', {
        flowPlanId: flow_id,
        manualEnrollment: {
          prospect: {
            firstName: subject.first_name ?? firstName ?? null,
            lastName: subject.last_name ?? (rest.join(' ') || null),
            linkedinUrl: subject.linkedin_url ?? null,
            email: subject.email ?? null,
            phone: subject.phone ?? null,
          },
          company: {
            domain: subject.company_domain ?? null,
            linkedinUrl: null,
            linkedinId: null,
          },
        },
      });
    },
  };

  // channel → FirstTouch action type.
  function mapChannel(channel) {
    switch (String(channel).toLowerCase()) {
      case 'email': return 'email';
      case 'linkedin':
      case 'linkedin_message': return 'linkedin_message';
      case 'linkedin_connect':
      case 'connect': return 'linkedin_connect';
      case 'linkedin_inmail':
      case 'inmail': return 'linkedin_inmail';
      case 'call': return 'call_task';
      case 'task':
      case 'manual': return 'manual_task';
      default: return 'email';
    }
  }

  if (dryRun) {
    api.createAction = noMutations('create an action');
    api.completeTask = noMutations('complete a task');
    api.cancelAction = noMutations('cancel an action');
    api.enrolFlow = noMutations('enrol a flow');
  }
  return api;
}

/**
 * The dashboard reader: any account-health API a tenant configures for the
 * cs_postclose motion. IDENTITY, NOT LIVENESS: before the first read of a
 * base URL (and again after any failure) the response of the base itself must
 * contain the configured identity string — a stale or wrong host answering
 * 200 ok is refused, which is the exact incident class (a moved service kept
 * answering ok:true and silently swallowed work).
 */
export function dashboardReader({ fetchImpl = fetch } = {}) {
  const verified = new Set();

  async function assertIdentity(baseUrl, identity) {
    if (verified.has(baseUrl)) return;
    if (!identity) throw new Error('dashboard.identity is not configured — refusing to trust liveness alone');
    const res = await fetchImpl(baseUrl, { signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    if (!res.ok || !body.includes(identity)) {
      throw new Error(
        `dashboard at ${baseUrl} did not present the expected identity string — ` +
        `refusing to read from it. A service that merely ANSWERS is not the service ` +
        `you configured.`,
      );
    }
    verified.add(baseUrl);
  }

  return {
    async read({ baseUrl, identity, path }) {
      try {
        await assertIdentity(baseUrl, identity);
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return { refused: `dashboard returned ${res.status} for ${path}` };
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 20_000) }; }
      } catch (e) {
        verified.delete(baseUrl); // re-verify identity after any failure
        return { refused: e.message };
      }
    },
  };
}

/**
 * Private adapter loading — the sanctioned door for deployment-specific
 * integrations (an internal dashboard, a transcript source, another CRM),
 * WITHOUT forking the engine. The overlay image sets EXTRA_ADAPTERS_DIR to a
 * directory it COPYed into the image; that directory's index.mjs exports
 * `register({ providers, cfg })` and may extend or replace providers.
 *
 * The one rule, enforced here: the adapters dir must NOT live on the
 * writable volume. Code under CONFIG_DIR or STATE_DIR would be writable by
 * the agent's own user, and loading it into a credential-holding process
 * would quietly reopen the self-modification hole the image/volume split
 * exists to close. Image-only, or refused.
 */
export function validateAdaptersDir(dir, {
  configDir = process.env.CONFIG_DIR,
  stateDir = process.env.STATE_DIR,
} = {}) {
  if (!dir) return { ok: false, reason: 'no dir given' };
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  const d = norm(dir);
  for (const forbidden of [configDir, stateDir].filter(Boolean)) {
    if (d.startsWith(norm(forbidden))) {
      return {
        ok: false,
        reason: `EXTRA_ADAPTERS_DIR (${dir}) is inside the writable volume (${forbidden}). ` +
          `Adapter code must be baked into the image, where the agent's user cannot ` +
          `write it — refusing to load code the agent could have authored.`,
      };
    }
  }
  return { ok: true };
}

export async function loadExtraAdapters(providers, cfg) {
  const dir = process.env.EXTRA_ADAPTERS_DIR;
  if (!dir) return providers;
  const check = validateAdaptersDir(dir);
  if (!check.ok) throw new Error(check.reason);
  const mod = await import(new URL(`file://${dir.replace(/\\/g, '/')}/index.mjs`).href);
  if (typeof mod.register !== 'function') {
    throw new Error(`${dir}/index.mjs must export register({ providers, cfg })`);
  }
  return (await mod.register({ providers, cfg })) ?? providers;
}

/**
 * External tool servers: the tenant's own MCP endpoints (Clay, Apollo, Gong,
 * an internal API…), declared in config.external_tools and proxied through
 * the agent tool server. The token comes from the environment variable the
 * config NAMES — the model's process never holds it, and this provider
 * re-checks the allowlist on every call (belt and braces on top of the
 * config-built tool table).
 */
export function externalToolProviders(cfg, { connectImpl = connect, env = process.env } = {}) {
  const servers = {};
  for (const ext of cfg.external_tools ?? []) {
    const token = env[ext.token_env];
    const allowed = new Set(ext.allow ?? []);
    let clientPromise = null; // lazy: connect on first call, not at boot
    servers[ext.name] = {
      async call(tool, args) {
        if (!allowed.has(tool)) {
          return { refused: `tool "${tool}" is not in the allow list for external server "${ext.name}"` };
        }
        if (!token) {
          return { refused: `external server "${ext.name}" needs ${ext.token_env} set in the environment` };
        }
        clientPromise ??= connectImpl({ url: ext.url, token });
        try {
          const client = await clientPromise;
          const { text, isError } = await client.callTool(tool, args);
          if (isError) return { refused: `${ext.name}/${tool}: ${text.slice(0, 400)}` };
          try { return JSON.parse(text); } catch { return { raw: text.slice(0, 20_000) }; }
        } catch (e) {
          clientPromise = null; // reconnect on the next call after a failure
          return { refused: `${ext.name} is unreachable: ${e.message}` };
        }
      },
    };
  }
  return servers;
}

/** The HubSpot adapter: reads for the tool surface, compare-and-set for apply. */
export function hubspotProvider({ token = process.env.HUBSPOT_ACCESS_TOKEN, dryRun = process.env.DRY_RUN === '1' } = {}) {
  if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN is not set — the CRM adapter cannot start.');
  const base = process.env.HUBSPOT_API_BASE_URL || 'https://api.hubapi.com';

  async function api(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`HubSpot rejected the token (${res.status}) — check HUBSPOT_ACCESS_TOKEN and its scopes.`);
    }
    if (!res.ok) throw new Error(`HubSpot ${method} ${path} returned ${res.status}.`);
    return res.status === 204 ? {} : res.json();
  }

  const objectPath = (type) => ({
    contact: 'contacts', company: 'companies', deal: 'deals',
  }[type] ?? `${type}s`);

  return {
    // --- reads (tools-core `crm` interface) ---
    searchContacts: ({ query, limit = 20 }) => api('POST', '/crm/v3/objects/contacts/search', {
      query, limit,
      properties: ['firstname', 'lastname', 'email', 'jobtitle', 'company', 'hubspot_owner_id'],
    }),
    getList: ({ list_id, limit = 100 }) =>
      api('GET', `/crm/v3/lists/${encodeURIComponent(list_id)}/memberships?limit=${limit}`),
    listDeals: ({ pipeline_id, limit = 100 }) => api('POST', '/crm/v3/objects/deals/search', {
      limit,
      filterGroups: pipeline_id
        ? [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pipeline_id }] }]
        : [],
      properties: ['dealname', 'dealstage', 'closedate', 'amount', 'hubspot_owner_id', 'hs_lastmodifieddate'],
    }),

    // Contacts matching a property/value signal — used for BOTH customer_signal
    // (recognise customers) and suppression_signal (opt-out / DNC in the CRM),
    // so the customer's own CRM stays the source of truth and this is just the
    // portable query into it.
    // Paginate the FULL result set by default — a truncated customer or
    // suppression list means the truncated remainder gets prospected, which is
    // exactly the failure this query exists to prevent. `maxPages` is a runaway
    // guard (100 pages × 100 = 10k), and hitting it THROWS rather than silently
    // returning a partial list, so the caller (the seed) treats it as a CRM
    // error and the motion skips instead of prospecting the un-fetched tail.
    async listBySignal({ signal, maxPages = 500 }) {
      const filters = (signal ?? [])
        .filter((s) => s?.property)
        .map((s) => ({
          propertyName: s.property,
          operator: s.equals !== undefined ? 'EQ' : (s.operator || 'HAS_PROPERTY').toUpperCase(),
          ...(s.equals !== undefined ? { value: s.equals } : s.value !== undefined ? { value: s.value } : {}),
        }));
      if (filters.length === 0) return [];
      const out = [];
      let after;
      let pages = 0;
      do {
        if (pages++ >= maxPages) {
          throw new Error(`signal query exceeded ${maxPages} pages (${out.length}+ rows) — refusing to return a partial list`);
        }
        const body = {
          limit: 100, after,
          filterGroups: [{ filters }],
          properties: ['email', 'company', 'website', 'hs_email_domain'],
        };
        const res = await api('POST', '/crm/v3/objects/contacts/search', body);
        for (const r of res?.results ?? []) {
          out.push({
            email: r.properties?.email ?? null,
            company_domain: r.properties?.hs_email_domain ?? r.properties?.website ?? null,
          });
        }
        after = res?.paging?.next?.after;
      } while (after);
      return out;
    },
    listCustomers({ customer_signal }) {
      return this.listBySignal({ signal: customer_signal });
    },
    listSuppressed({ suppression_signal }) {
      return this.listBySignal({ signal: suppression_signal });
    },

    // --- apply path (`crm` interface): compare-and-set halves ---
    async readProperty({ object_type, object_id, field }) {
      const res = await api('GET',
        `/crm/v3/objects/${objectPath(object_type)}/${encodeURIComponent(object_id)}?properties=${encodeURIComponent(field)}`);
      return res?.properties?.[field] ?? null;
    },
    updateProperty: ({ object_type, object_id, field, value }) => {
      // A CRM write is a real change to the customer's data — a dry run must
      // not make one, even when an approved card fires. The apply path surfaces
      // the thrown error as a conflict.
      if (dryRun) {
        return Promise.reject(new Error(`DRY_RUN is on — refusing to write ${field} on ${object_type} ${object_id}.`));
      }
      return api('PATCH',
        `/crm/v3/objects/${objectPath(object_type)}/${encodeURIComponent(object_id)}`,
        { properties: { [field]: value } });
    },
  };
}
