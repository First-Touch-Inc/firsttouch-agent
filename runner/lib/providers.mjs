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
export async function firsttouchProvider({ token = process.env.FT_MCP_TOKEN } = {}) {
  if (!token) throw new Error('FT_MCP_TOKEN is not set — the FirstTouch adapter cannot start.');
  const client = await connect({ url: FT_URL(), token });

  const call = async (name, args) => {
    const { text, isError } = await client.callTool(name, args);
    if (isError) throw new Error(`${name}: ${text.slice(0, 400)}`);
    return parseJsonText(text, name);
  };

  return {
    // --- free reads (tools-core) ---
    listTeamMembers: () => call('list_team_members', {}),
    listSenderConnections: () => call('list_linkedin_team_connections', {}),
    getCurrentUser: () => call('get_current_user', {}),

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
    async findAction({ subject, ownerProviderId }) {
      const res = await call('list_user_tasks', {
        assignedUserId: ownerProviderId, status: 'open',
      });
      const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
      const key = (subject?.email || subject?.linkedin_url || '').toLowerCase();
      const match = tasks.filter((t) =>
        String(t.contactEmail || t.contactLinkedinUrl || '').toLowerCase() === key);
      if (!match.length) return null;
      return { task_ids: match.map((t) => t.id) };
    },

    async createAction({ subject, steps, ownerProviderId }) {
      const res = await call('add_dynamic_action', {
        contact: {
          name: subject.name, email: subject.email,
          linkedinUrl: subject.linkedin_url, companyDomain: subject.company_domain,
        },
        // Approval mode plus explicit owner AND assignee: an action created
        // without these lands on whoever the API token authenticates as, and
        // sends one person's outreach from another person's account.
        requiresApproval: true,
        ownerId: ownerProviderId,
        assignedUserId: ownerProviderId,
        steps: steps.map((s) => ({ channel: s.channel, message: s.copy })),
      });
      const ids = res?.taskIds ?? res?.task_ids ??
        (Array.isArray(res?.tasks) ? res.tasks.map((t) => t.id) : null);
      if (!ids?.length) {
        throw new Error(`add_dynamic_action returned no task ids (${JSON.stringify(res).slice(0, 200)})`);
      }
      return { task_ids: ids };
    },

    async readTask(taskId) {
      const res = await call('preview_task', { taskId });
      return {
        status: res?.status === 'completed' || res?.completed ? 'completed'
          : res?.status === 'cancelled' ? 'cancelled' : 'open',
        copy: res?.message ?? res?.copy ?? res?.body ?? null,
        owner_provider_id: res?.ownerId ?? res?.assignedUserId ?? null,
      };
    },

    completeTask: (taskId) => call('complete_task', { taskId }),

    async cancelAction(taskIds) {
      for (const taskId of taskIds) {
        await call('skip_task', { taskId }).catch(() => {}); // best-effort cleanup
      }
    },

    enrolFlow: ({ flow_id, subject, ownerProviderId }) => call('add_manual_flow_enrollment', {
      flowPlanId: flow_id,
      contact: {
        name: subject.name, email: subject.email,
        linkedinUrl: subject.linkedin_url, companyDomain: subject.company_domain,
      },
      ownerId: ownerProviderId,
      assignedUserId: ownerProviderId,
    }),
  };
}

/** The HubSpot adapter: reads for the tool surface, compare-and-set for apply. */
export function hubspotProvider({ token = process.env.HUBSPOT_ACCESS_TOKEN } = {}) {
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

    // --- apply path (`crm` interface): compare-and-set halves ---
    async readProperty({ object_type, object_id, field }) {
      const res = await api('GET',
        `/crm/v3/objects/${objectPath(object_type)}/${encodeURIComponent(object_id)}?properties=${encodeURIComponent(field)}`);
      return res?.properties?.[field] ?? null;
    },
    updateProperty: ({ object_type, object_id, field, value }) => api('PATCH',
      `/crm/v3/objects/${objectPath(object_type)}/${encodeURIComponent(object_id)}`,
      { properties: { [field]: value } }),
  };
}
