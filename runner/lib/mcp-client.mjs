// A minimal MCP client for host code.
//
// This exists for one job: when a human clicks Approve in Slack, complete that
// task in the outreach platform. Deterministically.
//
// WHY NOT JUST SPAWN THE AGENT
// A click is not a judgement call. The human already made the decision; the only
// remaining question is "call complete_task with this id", and routing that
// through a model adds latency, cost, and a chance of it doing something
// adjacent instead. Host code runs the decision the human actually made.
//
// It is deliberately small: initialize, then tools/call. No session resumption,
// no notifications, no streaming. Zero dependencies — fetch is enough.

const PROTOCOL_VERSION = '2025-06-18';

export class McpError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'McpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Open a session against a streamable-HTTP MCP server and return a caller.
 * The server may hand back a session id; if it does, later calls must carry it.
 */
export async function connect({ url, token, timeoutMs = 20_000 }) {
  let sessionId = null;
  let nextId = 1;

  async function rpc(method, params) {
    const headers = {
      'content-type': 'application/json',
      // Streamable HTTP servers may answer with either, so accept both.
      accept: 'application/json, text/event-stream',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers['mcp-session-id'] = sessionId;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new McpError(
        e.name === 'TimeoutError'
          ? `The outreach platform did not respond within ${Math.round(timeoutMs / 1000)}s.`
          : `Could not reach the outreach platform: ${e.message}`,
      );
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;

    if (res.status === 401 || res.status === 403) {
      throw new McpError('The outreach platform rejected the token — check FT_MCP_TOKEN.', { status: res.status });
    }
    if (!res.ok) {
      throw new McpError(`The outreach platform returned ${res.status}.`, { status: res.status });
    }

    // A streamable-HTTP server may reply as SSE even to a single request.
    const raw = await res.text();
    const body = raw.includes('event:') || raw.startsWith('data:')
      ? raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
      : raw;

    let json;
    try { json = JSON.parse(body); } catch {
      throw new McpError('The outreach platform returned something that was not JSON.');
    }
    if (json.error) {
      throw new McpError(json.error.message || 'The outreach platform returned an error.', { code: json.error.code });
    }
    return json.result;
  }

  await rpc('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'firsttouch-agent', version: '0.1.0' },
  });

  return {
    /**
     * Call one tool. Returns { text, isError } — the text is whatever the
     * server put in its content blocks, which is what we surface to the human.
     */
    async callTool(name, args) {
      const result = await rpc('tools/call', { name, arguments: args });
      const text = (result?.content || [])
        .filter((c) => c?.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim();
      return { text, isError: Boolean(result?.isError) };
    },
  };
}
