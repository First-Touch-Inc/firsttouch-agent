// The trusted tool surface: every action the model can take, as an enumerated
// function with a closed schema, with the safety rules enforced INSIDE each
// function. The model holds no credentials and sees no raw provider tool —
// this file is the only door, and each door checks papers.
//
// Three rules shape everything here:
//
//   1. ENUMERATED, NEVER DISPATCHED. There is no call_tool(name, args) and no
//      {kind, args} passthrough — an earlier design round proved a free-string
//      dispatcher inside trusted code just re-creates the hole it was built to
//      close. Every tool is a named function; every enum is closed.
//
//   2. THE MODE IS THE PERMISSION. A session runs as 'motion', 'chat', or
//      'onboarding', set by the host that spawned it — never by the model.
//      Campaign authoring exists only in chat (an injected prospect bio cannot
//      start a campaign because motion sessions do not have the tool at all).
//      Config writing exists only in chat/onboarding from the operator.
//
//   3. REFUSE WITH A REASON. A refused call returns { refused: reason } rather
//      than throwing — the model is expected to report it as a skip line in
//      the digest ("skipped: acme.com suppressed — closed lost 2026-03-01"),
//      which is how refusals become visible instead of silent.
//
// Dependency-injected (`providers`) so every rule below is unit-testable
// without a live platform. The stdio wiring in runner/mcp/agent-server.mjs is
// deliberately dumb: parse, call this, serialise.

import { randomUUID } from 'node:crypto';
import { Ledger, registrableDomain, normalizeEmail } from './ledger.mjs';
import { validateConfig } from './config.mjs';

export const MODES = ['motion', 'chat', 'onboarding'];

// The closed enum of paid enrichment operations. Each maps to an explicit
// provider call — `kind` is never interpolated into a tool name.
export const ENRICHMENT_KINDS = ['person_profile', 'company_profile', 'email_finder'];

export class ToolError extends Error {}

const iso = (d) => d.toISOString();
const hoursFromNow = (h, now) => iso(new Date(now.getTime() + h * 3600e3));

export class ToolCore {
  /**
   * @param cfg       validated config (loadConfig output)
   * @param ledger    an open Ledger
   * @param mode      'motion' | 'chat' | 'onboarding'
   * @param motionId  the running motion's id (motion mode only)
   * @param providers injected side effects:
   *   ft.enrichPerson / ft.enrichCompany / ft.findEmail   (paid reads)
   *   ft.listTeamMembers / ft.listSenderConnections       (free reads)
   *   crm.searchContacts / crm.getList / crm.listDeals    (free reads)
   *   writeConfig(cfgObject)                              (chat/onboarding)
   *   writeWorkspaceFile(relPath, content)                (plays / voice)
   * @param now       clock, injectable for tests
   */
  constructor({ cfg, ledger, mode, motionId = null, providers, isOperator = false, now = () => new Date() }) {
    if (!MODES.includes(mode)) throw new ToolError(`unknown mode "${mode}"`);
    this.cfg = cfg;
    this.ledger = ledger;
    this.mode = mode;
    this.motionId = motionId;
    this.p = providers;
    // Config and play writes are operator-only IN CODE, not by prompt. The
    // host sets this from Slack's authenticated user id; a motion session is
    // never the operator (nobody is driving it), and a non-operator chat user
    // gets the tools refused even though they are exposed.
    this.isOperator = Boolean(isOperator);
    this.now = now;
    this.enrichmentSpent = 0;

    // External tools: built from OPERATOR CONFIG at construction, never from
    // model input — an unlisted tool has no entry here, so absence is the
    // denial, same as everywhere else. Namespaced ext_<server>_<tool>.
    this.externalTools = new Map();
    if (mode !== 'onboarding') {
      for (const ext of cfg.external_tools ?? []) {
        for (const tool of ext.allow ?? []) {
          this.externalTools.set(`ext_${ext.name}_${tool}`, { server: ext.name, tool });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // The tool table. availability is by mode; absence IS the denial — a tool
  // not listed for the session's mode is not exposed to the model at all.
  // -------------------------------------------------------------------------
  static TOOLS = {
    // free reads
    crm_search_contacts:      { modes: ['motion', 'chat'] },
    crm_get_list:             { modes: ['motion', 'chat'] },
    crm_list_deals:           { modes: ['motion', 'chat'] },
    // Platform reads. `needs: 'ft'` means the tool is only MOUNTED when this
    // process holds a platform credential. Where the platform arrives as an MCP
    // connector instead, the model calls it directly and these are absent —
    // absent, not refusing, because a tool that exists only to say "not
    // connected" turns a first run into a list of apparent breakages.
    list_team_members:        { modes: ['motion', 'chat', 'onboarding'], needs: 'ft' },
    list_sender_connections:  { modes: ['motion', 'chat', 'onboarding'], needs: 'ft' },
    list_declared_flows:      { modes: ['motion', 'chat', 'onboarding'] },
    // source sweeps — the warm signals the motions actually work
    list_engagers:            { modes: ['motion', 'chat'], needs: 'ft' },
    preview_list:             { modes: ['motion', 'chat'], needs: 'ft' },
    discover_contacts:        { modes: ['motion', 'chat'], needs: 'ft' },
    // the CS dashboard (or any account-health API a tenant configures)
    dashboard_read:           { modes: ['motion', 'chat'] },
    // paid reads, credit-capped
    start_enrichment:         { modes: ['motion', 'chat'], needs: 'ft' },
    // staging (everything a human then approves)
    propose_outreach:         { modes: ['motion', 'chat'] },
    propose_crm_change:       { modes: ['motion', 'chat'] },
    propose_unsent_draft:     { modes: ['motion', 'chat'] },
    propose_report:           { modes: ['motion', 'chat'] },
    enroll_declared_flow:     { modes: ['motion', 'chat'] },
    // chat-only: one-off campaigns. A motion session cannot author one, so
    // injected text in swept content can never start a campaign.
    propose_campaign:         { modes: ['chat'] },
    // self-configuration
    set_config:               { modes: ['chat', 'onboarding'] },
    write_play:               { modes: ['chat', 'onboarding'] },
    write_voice_pack:         { modes: ['chat', 'onboarding'] },
  };

  /** True when the provider a tool depends on is actually mounted. */
  _hasDependency(def) {
    return !def.needs || Boolean(this.p?.[def.needs]);
  }

  availableTools() {
    return [
      ...Object.entries(ToolCore.TOOLS)
        .filter(([, def]) => def.modes.includes(this.mode) && this._hasDependency(def))
        .map(([name]) => name),
      ...this.externalTools.keys(),
    ];
  }

  call(name, args = {}) {
    // External tools route by the config-built table. The token lives with
    // the provider; the model only ever names a tool that config allowed.
    if (name.startsWith('ext_')) {
      const ext = this.externalTools.get(name);
      if (!ext) throw new ToolError(`unknown tool "${name}" — external tools exist only if config allows them`);
      const server = this.p.external?.[ext.server];
      if (!server) return { refused: `external server "${ext.server}" is not connected — check its token env var` };
      return server.call(ext.tool, args);
    }
    const def = ToolCore.TOOLS[name];
    if (!def) throw new ToolError(`unknown tool "${name}"`);
    if (!def.modes.includes(this.mode)) {
      // Belt and braces: the wiring should never have exposed it, but a second
      // check in the dispatcher costs nothing and fails closed.
      throw new ToolError(`tool "${name}" is not available in ${this.mode} sessions`);
    }
    if (!this._hasDependency(def)) {
      // Same belt-and-braces: availableTools already omits it, so reaching here
      // means the model named a tool it was never offered. Refusing beats
      // dereferencing a provider that is not mounted.
      throw new ToolError(`tool "${name}" is not mounted — its provider is not connected in this deployment`);
    }
    const method = `_${name}`;
    if (typeof this[method] !== 'function') throw new ToolError(`tool "${name}" not implemented`);
    return this[method](args);
  }

  // -------------------------------------------------------------------------
  // Shared enforcement
  // -------------------------------------------------------------------------

  /** Resolve an owner_ref against config. The model may only NAME an owner
   *  that config already defines — it can never introduce one. */
  _resolveOwner(ownerRef) {
    const owners = this.cfg.approval_routing.owners;
    const owner = ownerRef
      ? owners.find((o) => o.id === ownerRef)
      : owners.find((o) => o.match === 'default');
    if (!owner) {
      return { refused: ownerRef
        ? `owner_ref "${ownerRef}" is not in approval_routing.owners — an owner must exist in config before work can be routed to them`
        : 'no default owner configured' };
    }
    return { owner };
  }

  /** Identity + suppression + claim for a subject. Returns { subjectId } or
   *  { refused }. Every staging path goes through this — including flow
   *  enrolment, which is historically where suppression checks got skipped. */
  _admitSubject(subject, { allowClaimed = false } = {}) {
    if (!subject || (!subject.email && !subject.linkedin_url && !subject.crm_contact_id)) {
      return { refused: 'subject needs at least one identifier (email, linkedin_url, or crm_contact_id)' };
    }
    const aliases = {};
    if (subject.email) aliases.normalized_email = normalizeEmail(subject.email);
    if (subject.linkedin_url) aliases.social_profile_url = String(subject.linkedin_url).trim();
    if (subject.crm_contact_id) aliases.crm_contact_id = String(subject.crm_contact_id);
    if (subject.company_domain) {
      const d = registrableDomain(subject.company_domain);
      if (d) aliases.normalized_domain = d;
    }
    const subjectId = this.ledger.resolveSubject('person', aliases);

    const sup = this.ledger.suppressionFor({
      subjectId,
      email: subject.email,
      companyDomain: subject.company_domain,
    }, iso(this.now()));
    if (sup) {
      return { refused: `suppressed: ${sup.scope}=${sup.value} — ${sup.reason} (source: ${sup.source})` };
    }

    const claim = this.ledger.liveClaim(subjectId, iso(this.now()));
    if (claim && !allowClaimed) {
      return { refused: `claimed by ${claim.teammate}: ${claim.reason} (until ${claim.until_at})` };
    }
    return { subjectId };
  }

  // -------------------------------------------------------------------------
  // Free reads (thin passthroughs to injected providers — no enforcement
  // needed beyond mode gating, they cannot change anything)
  // -------------------------------------------------------------------------
  _crm_search_contacts(args)     { return this.p.crm.searchContacts(args); }
  _crm_get_list(args)            { return this.p.crm.getList(args); }
  _crm_list_deals(args)          { return this.p.crm.listDeals(args); }
  _list_team_members()           { return this.p.ft.listTeamMembers(); }
  _list_sender_connections(args) { return this.p.ft.listSenderConnections(args); }
  _list_declared_flows()         { return { flows: this.cfg.flows ?? [] }; }
  _list_engagers(args)           { return this.p.ft.listEngagers(args); }
  _preview_list(args)            { return this.p.ft.previewList(args); }
  _discover_contacts(args)       { return this.p.ft.discoverContacts(args); }

  // -------------------------------------------------------------------------
  // The dashboard read: the cs_postclose data source (or any account API).
  // The model supplies only a PATH — the base URL and the identity string
  // come from config, so injected text can never point this at another host,
  // and a stale service answering ok:true fails the identity assertion in
  // the provider rather than being believed.
  // -------------------------------------------------------------------------
  _dashboard_read({ path }) {
    const motion = this.mode === 'motion'
      ? this.cfg.motions.find((m) => m.id === this.motionId)
      : this.cfg.motions.find((m) => m.kind === 'cs_postclose' && m.enabled);
    const dash = motion?.dashboard;
    if (!dash?.base_url) {
      return { refused: 'no dashboard is configured for this context (motions[].dashboard)' };
    }
    const p = String(path ?? '');
    if (!p.startsWith('/') || p.includes('://') || p.includes('..')) {
      return { refused: 'path must be an absolute path on the configured dashboard ("/api/…") — no full URLs, no traversal' };
    }
    return this.p.dash.read({ baseUrl: dash.base_url, identity: dash.identity, path: p });
  }

  // -------------------------------------------------------------------------
  // Paid reads: the closed enrichment enum
  // -------------------------------------------------------------------------
  _start_enrichment({ kind, subject }) {
    if (!ENRICHMENT_KINDS.includes(kind)) {
      // The refusal message deliberately lists the enum — and nothing is ever
      // dispatched from the string the model sent.
      return { refused: `enrichment kind must be one of: ${ENRICHMENT_KINDS.join(', ')}` };
    }
    const ceiling = this.cfg.limits.enrichment_credits_per_run;
    if (this.enrichmentSpent >= ceiling) {
      return { refused: `enrichment credit ceiling reached (${ceiling} this run) — qualify with free checks instead` };
    }
    this.enrichmentSpent += 1;
    switch (kind) {
      case 'person_profile':  return this.p.ft.enrichPerson(subject);
      case 'company_profile': return this.p.ft.enrichCompany(subject);
      case 'email_finder':    return this.p.ft.findEmail(subject);
    }
  }

  // -------------------------------------------------------------------------
  // Staging: everything lands as a work item a human then decides on.
  // Nothing here touches the platform — the host applies decisions later.
  // -------------------------------------------------------------------------

  _propose_outreach({ subject, why, steps, owner_ref, allow_claimed = false }) {
    if (!why || !String(why).trim()) {
      return { refused: 'a researched reason is required — no reason means no draft; a short day beats a manufactured one' };
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return { refused: 'steps must be a non-empty list of {channel, copy}' };
    }
    for (const s of steps) {
      if (!s?.channel || !s?.copy) return { refused: 'every step needs a channel and copy' };
    }

    const motion = this.motionId
      ? this.cfg.motions.find((m) => m.id === this.motionId) : null;
    const admit = this._admitSubject(subject, {
      allowClaimed: allow_claimed && (motion?.allow_open_deals ?? this.mode === 'chat'),
    });
    if (admit.refused) return admit;

    const o = this._resolveOwner(owner_ref);
    if (o.refused) return o;

    const domain = subject.company_domain ? registrableDomain(subject.company_domain)
      : subject.email ? registrableDomain(subject.email) : null;
    const reserve = this.ledger.reserveTouch({
      subjectId: admit.subjectId,
      teammate: 'agent',
      channel: steps[0].channel,
      domain,
      caps: this.cfg.limits,
    }, iso(this.now()));
    if (!reserve.ok) {
      return { refused: `over the ${reserve.cap} limit (at ${reserve.at}) — this is a hard cap, not advice` };
    }

    const id = this.ledger.createWorkItem({
      teammate: 'agent',
      motion: this.motionId ?? 'chat',
      kind: 'outreach',
      subjectId: admit.subjectId,
      payload: { subject, why, steps, touch_id: reserve.touchId },
      ownerProviderId: o.owner.provider_user_id,
      expiresAt: hoursFromNow(this.cfg.approval.expiry_hours, this.now()),
    });
    return { staged: id, owner: o.owner.id };
  }

  _propose_crm_change({ changes, owner_ref, why }) {
    const motion = this.cfg.motions.find((m) => m.id === this.motionId);
    const allowedFields = this.mode === 'chat'
      ? (this.cfg.motions.find((m) => m.kind === 'deal_followup')?.crm_fields_may_change ?? [])
      : (motion?.crm_fields_may_change ?? []);
    if (allowedFields.length === 0) {
      return { refused: 'no CRM fields are changeable here — crm_fields_may_change is empty for this context' };
    }
    if (!Array.isArray(changes) || changes.length === 0) {
      return { refused: 'changes must be a non-empty list of {object_type, object_id, field, from, to}' };
    }
    for (const c of changes) {
      if (!c?.object_id || !c?.field) return { refused: 'every change needs object_id and field' };
      if (!allowedFields.includes(c.field)) {
        // The allowlist IS the permission: an unlisted field cannot even be
        // proposed, so it can never reach a card, let alone the CRM.
        return { refused: `field "${c.field}" is not in crm_fields_may_change (${allowedFields.join(', ')})` };
      }
      if (c.from === undefined || c.to === undefined) {
        return { refused: `change to "${c.field}" needs explicit from and to — the apply is compare-and-set, so "from" is what makes it safe` };
      }
    }
    const o = this._resolveOwner(owner_ref);
    if (o.refused) return o;

    const id = this.ledger.createWorkItem({
      teammate: 'agent',
      motion: this.motionId ?? 'chat',
      kind: 'crm_change',
      payload: { changes, why: why ?? '' },
      ownerProviderId: o.owner.provider_user_id,
      expiresAt: hoursFromNow(this.cfg.approval.expiry_hours, this.now()),
    });
    return { staged: id, owner: o.owner.id };
  }

  _propose_unsent_draft({ subject, title, body, owner_ref }) {
    if (!title || !body) return { refused: 'an unsent draft needs a title and a body' };
    const o = this._resolveOwner(owner_ref);
    if (o.refused) return o;
    // No touch reservation: nothing sends. Suppression still applies — a
    // recap for a suppressed account is still contact-adjacent work product.
    const admit = subject ? this._admitSubject(subject, { allowClaimed: true }) : {};
    if (admit.refused) return admit;

    const id = this.ledger.createWorkItem({
      teammate: 'agent',
      motion: this.motionId ?? 'chat',
      kind: 'unsent_draft',
      subjectId: admit.subjectId ?? null,
      payload: { subject: subject ?? null, title, body },
      ownerProviderId: o.owner.provider_user_id,
      expiresAt: hoursFromNow(this.cfg.approval.expiry_hours, this.now()),
    });
    return { staged: id, owner: o.owner.id };
  }

  _propose_report({ lines }) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return { refused: 'a report needs at least one line' };
    }
    const id = this.ledger.createWorkItem({
      teammate: 'agent',
      motion: this.motionId ?? 'chat',
      kind: 'report',
      payload: { lines },
      expiresAt: hoursFromNow(this.cfg.approval.expiry_hours, this.now()),
    });
    return { staged: id };
  }

  _enroll_declared_flow({ flow_id, subject, owner_ref }) {
    const declared = (this.cfg.flows ?? []).find((f) => f.id === flow_id);
    if (!declared) {
      // The allowlist is the permission. This is also checked again at apply.
      return { refused: `flow "${flow_id}" is not declared in config — the flows list is the only permission` };
    }
    const admit = this._admitSubject(subject);
    if (admit.refused) return admit;
    const o = this._resolveOwner(owner_ref);
    if (o.refused) return o;

    const domain = subject.company_domain ? registrableDomain(subject.company_domain)
      : subject.email ? registrableDomain(subject.email) : null;
    const reserve = this.ledger.reserveTouch({
      subjectId: admit.subjectId,
      teammate: 'agent',
      channel: 'flow',
      domain,
      caps: this.cfg.limits,
    }, iso(this.now()));
    if (!reserve.ok) {
      return { refused: `over the ${reserve.cap} limit (at ${reserve.at})` };
    }

    const id = this.ledger.createWorkItem({
      teammate: 'agent',
      motion: this.motionId ?? 'chat',
      kind: 'outreach',
      subjectId: admit.subjectId,
      payload: {
        flow_enrolment: { flow_id, flow_name: declared.name },
        subject, touch_id: reserve.touchId,
      },
      ownerProviderId: o.owner.provider_user_id,
      expiresAt: hoursFromNow(this.cfg.approval.expiry_hours, this.now()),
    });
    return { staged: id, owner: o.owner.id, flow: declared.name };
  }

  _propose_campaign({ name, audience, steps, owner_ref, why }) {
    if (this.cfg.chat?.campaigns_enabled === false) {
      return { refused: 'campaigns are disabled in config (chat.campaigns_enabled: false)' };
    }
    if (!name || !why) return { refused: 'a campaign needs a name and a researched why' };
    if (!Array.isArray(steps) || steps.length === 0) {
      return { refused: 'steps must be a non-empty list of {channel, copy}' };
    }
    if (!Array.isArray(audience) || audience.length === 0) {
      return { refused: 'audience must be a non-empty list of subjects' };
    }
    const o = this._resolveOwner(owner_ref);
    if (o.refused) return o;

    // Screen every member NOW so the card can say "212 contacts, 9 excluded"
    // honestly. No touches are reserved at propose time — a campaign drips
    // under the daily caps at apply time, taking reservations per send.
    const admitted = [];
    const excluded = [];
    const seen = new Set();
    for (const subject of audience) {
      const admit = this._admitSubject(subject, { allowClaimed: true });
      if (admit.refused) {
        excluded.push({ subject: subject?.email ?? subject?.linkedin_url ?? '?', reason: admit.refused });
        continue;
      }
      if (seen.has(admit.subjectId)) {
        excluded.push({ subject: subject?.email ?? '?', reason: 'duplicate within audience' });
        continue;
      }
      seen.add(admit.subjectId);
      admitted.push({ subject, subject_id: admit.subjectId });
    }
    if (admitted.length === 0) {
      return { refused: `every member of the audience was excluded (${excluded.length} exclusions) — nothing to run` };
    }

    const id = this.ledger.createWorkItem({
      teammate: 'agent',
      motion: 'chat',
      kind: 'outreach',
      payload: {
        campaign: { name, why, steps, admitted, excluded },
      },
      ownerProviderId: o.owner.provider_user_id,
      expiresAt: hoursFromNow(this.cfg.approval.expiry_hours, this.now()),
    });
    return {
      staged: id,
      owner: o.owner.id,
      audience: admitted.length,
      excluded: excluded.length,
      exclusions: excluded,
    };
  }

  // -------------------------------------------------------------------------
  // Self-configuration
  // -------------------------------------------------------------------------

  // Keys the agent may NEVER write, in any mode, for any reason. The operator
  // binding is set by the claim flow only; overrides and provider targets are
  // how approval rights or data sources would be silently repointed.
  static PROTECTED_CONFIG = [
    'slack.operator',
    'approval_routing.approval_overrides',
    'providers.outreach.kind',
    'providers.crm.kind',
    // external_tools MOUNTS a credentialed tool source: a write here can point
    // a "tool server" at an attacker host with a real token_env and exfiltrate
    // the bearer on the next spawn. It is operator-config-file only, never a
    // tool write — the same class as approval_overrides.
    'external_tools',
    // provider/data-source endpoints and the tenant's identity are repoint
    // targets; a config write must never move where data or sends go.
    'providers.crm.mcp_url',
    'providers.outreach.mcp_url',
  ];

  _set_config({ patch }) {
    if (this.mode === 'motion') return { refused: 'config cannot be written from a scheduled run' };
    if (!this.isOperator) {
      return { refused: 'only the operator may change config — this is enforced in code, not just asked' };
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { refused: 'patch must be an object of config paths to values' };
    }

    // flattenDeep walks ARRAYS too, so external_tools[0].url and any other
    // nested repoint target is actually visited. The array-as-leaf version of
    // this check was a verified token-exfiltration hole.
    for (const path of Object.keys(flattenDeep(patch))) {
      const bare = path.replace(/\.\d+(\.|$)/g, '$1'); // drop array indices for matching
      for (const protectedPath of ToolCore.PROTECTED_CONFIG) {
        if (bare === protectedPath || bare.startsWith(`${protectedPath}.`)) {
          return { refused: `"${protectedPath}" cannot be written by a tool — it is operator-config-file only` };
        }
      }
      // Any endpoint/URL anywhere in the patch repoints a data source or send
      // target. That is a confirmed-button operation, never a config write.
      if (/(^|\.)(base_url|mcp_url|url|token_env|endpoint|host)$/.test(bare)) {
        return { refused: `"${path}" points at an endpoint or a credential source — that needs operator confirmation on a host-posted card, not a config write` };
      }
    }

    const candidate = deepMerge(structuredClone(stripMeta(this.cfg)), patch);
    const problems = validateConfig(candidate);
    if (problems.length) {
      return { refused: `the patched config would be invalid:\n${problems.map((p) => `- ${p}`).join('\n')}` };
    }
    this.p.writeConfig(candidate);
    return { written: true, keys: Object.keys(flattenDeep(patch)) };
  }

  _write_play({ filename, content }) {
    if (!this.isOperator) return { refused: 'only the operator may write plays' };
    const check = workspaceFilename(filename, '.md');
    if (check.refused) return check;
    if (!content || !String(content).trim()) return { refused: 'a play needs content' };
    this.p.writeWorkspaceFile(`plays/${check.name}`, String(content));
    return { written: `plays/${check.name}` };
  }

  _write_voice_pack({ content }) {
    if (!this.isOperator) return { refused: 'only the operator may rewrite the voice pack' };
    if (!content || !String(content).trim()) return { refused: 'the voice pack needs content' };
    this.p.writeWorkspaceFile('voice-pack.md', String(content));
    return { written: 'voice-pack.md' };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A filename for the agent's writable workspace: one path segment, the right
 *  extension, no traversal. "../../.claude/hooks/guard.mjs" is the attack. */
function workspaceFilename(filename, ext) {
  const name = String(filename ?? '').trim();
  if (!name) return { refused: 'filename is required' };
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
    return { refused: 'filename must be a bare name inside the plays workspace — no paths, no traversal' };
  }
  if (!name.endsWith(ext)) return { refused: `filename must end in ${ext}` };
  return { name };
}

function stripMeta(cfg) {
  // __bootstrap must go too. It is a first-run marker on the in-memory config,
  // and the config written here is the one loaded forever after — persisting it
  // would leave every future boot believing it is still un-onboarded, with the
  // tick loop disabled and nothing ever running.
  const { __meta, __bootstrap, ...rest } = cfg;
  return rest;
}

/** Flatten to dotted paths, DESCENDING INTO ARRAYS (index as a segment). The
 *  object-only version let a url nested in an array element slip past the
 *  config guard — a verified token-exfiltration hole. */
function flattenDeep(obj, prefix = '') {
  const out = {};
  const entries = Array.isArray(obj)
    ? obj.map((v, i) => [String(i), v])
    : Object.entries(obj);
  for (const [k, v] of entries) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') Object.assign(out, flattenDeep(v, path));
    else out[path] = v;
  }
  return out;
}

function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}
