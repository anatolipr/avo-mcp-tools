// Manual TS port of the sentinel-extraction logic in
// packages/human-mcp-relay/src/protocol.js - kept as a duplicate, NOT an npm
// dependency (see relay-engine.ts's header comment for why: this only needs
// the read side - finding a HUMAN-MCP CALL/RESULT block in raw chat-reply
// text - never protocol.js's parseCall JSON-parsing/tool-dispatch or
// formatResult, which stay app-tab-only via window.__humanMcpRelay).
//
// IMPORTANT: if protocol.js's sentinel format or the unescaped-nested-JSON
// repair heuristic ever changes, this file must be updated to match by hand
// - there is no build-time link between the two packages.

export interface SentinelMatch {
  tag: string;
  body: string;
}

// Mirrors protocol.js's findSentinel: matches both "SENTINEL" and
// "SENTINEL[tag]", returning the index/tag/matchLength of the match.
function findSentinel(text: string, sentinel: string): { index: number; tag: string; matchLength: number } | undefined {
  let re = new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\[([^\\]\\n]*)\\])?');
  let m = text.match(re);
  if (!m) return undefined;
  return { index: m.index ?? 0, tag: m[1] || '', matchLength: m[0].length };
}

// Mirrors protocol.js's stripFence: strips a wrapping ``` fence if present.
function stripFence(text: string): string {
  let t = text.trim();
  let fenced = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return fenced?.[1] ?? t;
}

// Finds the first startSentinel...endSentinel block in text (optionally
// session-tagged, e.g. "HUMAN-MCP CALL[htmlpaint]"), returning the tag (''
// if untagged) and the raw body text between the sentinels, or undefined if
// no complete block is found.
export function extractSentinelBlock(text: string, startSentinel: string, endSentinel: string): SentinelMatch | undefined {
  let body = stripFence(text);
  let found = findSentinel(body, startSentinel);
  if (!found) return undefined;
  let endIdx = body.indexOf(endSentinel, found.index);
  if (endIdx === -1) return undefined;
  return {
    tag: found.tag,
    body: body.slice(found.index + found.matchLength, endIdx).trim(),
  };
}

// Mirrors protocol.js's repairUnescapedNestedJson: the most common
// hand-authored-JSON mistake is leaving inner quotes unescaped on a param
// meant to hold a JSON-encoded STRING, e.g. {"nodesJson":"[{"t":"div"}]"}
// instead of {"nodesJson":"[{\"t\":\"div\"}]"}. Repairs that specific shape
// by depth-counting brackets (ignoring quotes, since they're exactly what's
// broken) and escaping every unescaped double-quote strictly inside the span.
export function repairUnescapedNestedJson(raw: string): string {
  let out = '';
  let i = 0;

  while (i < raw.length) {
    let match = raw.slice(i).match(/"[^"\\]+"\s*:\s*"(?=[[{])/);
    if (!match || match.index === undefined) {
      out += raw.slice(i);
      break;
    }
    let valueStart = i + match.index + match[0].length;
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
      if (depth === 0) {
        j++;
        break;
      }
    }
    let escaped = inner.replace(/\\?"/g, (seg) => (seg === '\\"' ? seg : '\\"'));
    out += escaped;
    i = j;
  }

  return out;
}
