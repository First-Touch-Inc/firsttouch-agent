// Reading the result envelope out of `claude -p --output-format json`.
//
// A plain JSON.parse of the whole stream is too brittle to rely on. The CLI and
// any MCP server attached to the session may print human-readable lines to
// stdout ahead of the envelope — a deprecated permission rule, a stdin notice,
// "Client.listTools() called but server does not advertise tools capability".
// None of that is an error, and none of it is ours to suppress.
//
// Both callers learned this the hard way and separately: the host reported
// "unparseable output" and delivered the diagnostic text to the operator in
// Slack as though the agent had said it; the preflight reported a working model
// as unverifiable. One parser, used by both.

/**
 * The result envelope, or null when the stream genuinely contains none.
 *
 * Takes the whole stream when it parses, otherwise the last balanced JSON
 * object in it — last, because the envelope is emitted after any preamble.
 */
export function parseModelOutput(out) {
  const text = String(out ?? '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through to scan */ }

  // The envelope runs to the end of the stream, so try each '{' from the right
  // and take the first that parses whole.
  for (let start = text.lastIndexOf('{'); start !== -1; start = text.lastIndexOf('{', start - 1)) {
    try {
      const candidate = JSON.parse(text.slice(start));
      if (candidate && typeof candidate === 'object' && 'result' in candidate) return candidate;
    } catch { /* this brace was inside the preamble; keep walking left */ }
  }
  return null;
}
