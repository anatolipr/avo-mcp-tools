// Protocol for relaying tool calls through a human copy/paste loop, used
// when an agent has no direct MCP/socket connection to window.__mcpTools
// (see js-bridge-mcp) but the human has both a chat session and this tab open.
//
// The block is delimited by plain all-caps sentinel lines (not a markdown
// code fence) so it survives being pasted into arbitrary chat UIs without
// colliding with how that UI/model mangles nested backticks - but the body
// between the sentinels is a single strict JSON object, not hand-rolled
// "key: value" lines. Earlier prototype used "tool: x" / "args: {...}" lines,
// but several tools (e.g. set_nodes' "nodesJson") take a JSON-encoded STRING
// param, which requires the agent to hand-escape nested quotes inside a
// bespoke line format - exactly the kind of manual, non-standard escaping
// LLMs are unreliable at. A single JSON object is a format models handle far
// more reliably (it's what they're trained on constantly), and the human-app
// side can validate strictly with one JSON.parse instead of fragile regex
// line-scraping.
//
// Call block (agent -> app):
//   HUMAN-MCP CALL
//   {"tool":"get_nodes","args":{}}
//   HUMAN-MCP END
//
// Result block (app -> agent):
//   HUMAN-MCP RESULT
//   {"tool":"get_nodes","ok":true,"data":[...]}
//   HUMAN-MCP END
//
// Multi-app session tagging: when a human has more than one relay popup open
// (one per bridged app/tab) in the same agent conversation, each app can be
// given a session name (see relay.js's "Session name" field) that gets baked
// into the sentinel line itself as a bracketed suffix, so a block meant for
// one app is visibly distinguishable from another's and a mis-pasted block
// is rejected instead of silently run against the wrong app:
//   HUMAN-MCP CALL[htmlpaint]
//   {"tool":"get_nodes","args":{}}
//   HUMAN-MCP END
// A relay with no session name set still emits/expects the plain
// (untagged) sentinel exactly as before - this is fully backward compatible
// with a single-app relay session.

const CALL_START = 'HUMAN-MCP CALL';
const RESULT_START = 'HUMAN-MCP RESULT';
const END = 'HUMAN-MCP END';

/**
 * Finds the start of a (possibly session-tagged) sentinel line, e.g. searches
 * for "HUMAN-MCP CALL" and matches both "HUMAN-MCP CALL" and
 * "HUMAN-MCP CALL[name]", returning the index and the tag (or '' if untagged).
 * @param {string} body
 * @param {string} sentinel
 * @returns {{index: number, tag: string, matchLength: number} | null}
 */
function findSentinel(body, sentinel) {
  let re = new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\[([^\\]\\n]*)\\])?');
  let m = body.match(re);
  if (!m) return null;
  return {index: m.index, tag: m[1] || '', matchLength: m[0].length};
}

/** Strips a wrapping ``` fence if the agent added one anyway despite the primer. */
function stripFence(text) {
  let t = text.trim();
  let fenced = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1] : t;
}

// Even with a strict single-JSON-object envelope, the most common agent
// mistake in practice (seen repeatedly) is leaving the inner quotes
// unescaped on a param that's meant to be a JSON-encoded STRING (e.g.
// set_nodes'/normalize_nodes' "nodesJson"), e.g.
//   {"nodesJson":"[{"t":"div","x":0}]"}
// instead of
//   {"nodesJson":"[{\"t\":\"div\",\"x\":0}]"}
// which breaks JSON.parse at the first inner quote. Rather than keep relying
// on agents to transcribe backslash-escapes correctly by hand, repair this
// specific, recognizable shape before giving up: for every "key":" that is
// immediately followed by an unescaped [ or {, find the matching bracket by
// depth-counting (ignoring quotes entirely, since they're exactly what's
// broken) and escape every unescaped double-quote strictly inside that span.
function repairUnescapedNestedJson(raw) {
  let out = '';
  let i = 0;

  while (i < raw.length) {
    let match = raw.slice(i).match(/"[^"\\]+"\s*:\s*"(?=[[{])/);
    if (!match) {
      out += raw.slice(i);
      break;
    }
    let valueStart = i + match.index + match[0].length; // position at the [ or { right after the opening quote
    out += raw.slice(i, valueStart);

    let openChar = raw[valueStart];
    let closeChar = openChar === '[' ? ']' : '}';
    let depth = 0;
    let j = valueStart;
    let inner = '';
    for (; j < raw.length; j++) {
      let ch = raw[j];
      if (ch === openChar) depth++;
      else if (ch === closeChar) depth--;
      inner += ch;
      if (depth === 0) { j++; break; }
    }
    // inner now holds the full bracketed span; escape any unescaped " inside it.
    let escaped = inner.replace(/\\?"/g, seg => (seg === '\\"' ? seg : '\\"'));
    out += escaped;
    i = j;
  }

  return out;
}

/**
 * Parses the first HUMAN-MCP CALL (optionally session-tagged, e.g.
 * HUMAN-MCP CALL[htmlpaint]) block found in pasted text. The block body must
 * be exactly one JSON object: {"tool": string, "args": object}.
 *
 * @param {string} text
 * @param {string} [expectedSession] - if this relay has a session name set,
 *   the pasted block's tag must match it (case-insensitive) or an untagged
 *   block is rejected too, since it's ambiguous which app it was meant for
 *   once more than one relay is in play. Leave unset/empty to accept any tag
 *   (single-app usage, unchanged from before session tagging existed).
 * @returns {{tool: string, args: any}}
 */
export function parseCall(text, expectedSession) {
  let body = stripFence(text);
  let found = findSentinel(body, CALL_START);
  if (!found) {
    throw new Error(`No "${CALL_START}" block found in pasted text.`);
  }
  let {index: startIdx, tag, matchLength} = found;

  if (expectedSession) {
    if (!tag) {
      throw new Error(
        `This relay is named "${expectedSession}", but the pasted call has no session tag ` +
        `(expected a sentinel like "${CALL_START}[${expectedSession}]"). If the agent is bridging ` +
        'multiple apps, make sure it tags every call for the app it means and that you paste each ' +
        'block into the matching app\'s popup.'
      );
    }
    if (tag.toLowerCase() !== expectedSession.toLowerCase()) {
      throw new Error(
        `This call is tagged "${tag}", but this relay is named "${expectedSession}" - it looks like ` +
        `this block was meant for a different app's popup. Paste it into the "${tag}" relay instead.`
      );
    }
  }

  let endIdx = body.indexOf(END, startIdx);
  if (endIdx === -1) {
    throw new Error(`Found "${CALL_START}" but no matching "${END}".`);
  }
  let jsonText = body.slice(startIdx + matchLength, endIdx).trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (firstErr) {
    // Common failure: an inner param meant to hold JSON-as-a-string (e.g.
    // nodesJson) has its nested quotes left unescaped. Try to repair that
    // specific shape before giving up.
    try {
      parsed = JSON.parse(repairUnescapedNestedJson(jsonText));
    } catch {
      throw new Error(
        `The call block body is not valid JSON (${firstErr.message}). It must be a single JSON object ` +
        `shaped {"tool":"...","args":{...}} - got: ${jsonText.slice(0, 300)}`
      );
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Call block must be a JSON object, e.g. {"tool":"get_nodes","args":{}}.');
  }
  if (typeof parsed.tool !== 'string' || !parsed.tool) {
    throw new Error('Call block JSON is missing a string "tool" field.');
  }
  if (parsed.args !== undefined && (typeof parsed.args !== 'object' || parsed.args === null || Array.isArray(parsed.args))) {
    throw new Error('Call block JSON\'s "args" field must be an object (use {} for no args).');
  }

  return {tool: parsed.tool, args: parsed.args || {}};
}

/**
 * Formats a tool result (or error) as a pasteable HUMAN-MCP RESULT block.
 * The body is a single JSON object, same strictness as the call block.
 * @param {{tool: string, ok: boolean, data?: any, error?: string}} result
 * @param {string} [sessionName] - if set, tags the sentinel as
 *   HUMAN-MCP RESULT[sessionName] so the agent can tell which bridged app a
 *   result came from when relaying to more than one at once.
 */
export function formatResult({tool, ok, data, error}, sessionName) {
  let payload = ok ? {tool, ok, data} : {tool, ok, error};
  let start = sessionName ? `${RESULT_START}[${sessionName}]` : RESULT_START;
  return [start, JSON.stringify(payload, null, 2), END].join('\n');
}
