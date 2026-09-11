// Generates the pasteable markdown primer from window.__mcpTools - the same
// tool array js-bridge-mcp's socket client reads (see
// js-bridge-mcp/src/client/main.ts), a contract any host app can implement
// (htmlpaint.com and mindfoo both do). No backticks/code-fences anywhere in
// the output: this text gets pasted verbatim into a chat session, and fences
// risk colliding with how that chat UI renders/re-escapes nested markdown.
//
// Nothing in this file is specific to one host app - the app name and any
// domain-specific context come from document.title / window.__mcpSummary
// (the same optional global js-bridge-mcp reads), not from a hardcoded string.

/**
 * @param {Array<{name:string, description:string, params:Record<string,any>, example?:any}>} tools
 * @param {{appName?: string, summary?: string, sessionName?: string, closingNote?: string}} [context]
 *   closingNote overrides the primer's final instruction to the LLM (default:
 *   "start by calling a read-only tool"). Host apps whose tool list spans
 *   several unrelated things (e.g. a hub merging multiple proxied MCP
 *   servers) should pass one telling the LLM to ask the human what they
 *   actually want BEFORE calling anything — the default's "just start
 *   exploring" advice assumes a single coherent app/document, which doesn't
 *   hold when the tool list is really N different tools from N different
 *   sources with no shared context.
 */
export function buildPrimer(tools, context = {}) {
  let appName = context.appName || document.title || 'this app';
  let sessionName = context.sessionName || '';
  let callSentinel = sessionName ? `HUMAN-MCP CALL[${sessionName}]` : 'HUMAN-MCP CALL';
  let resultSentinel = sessionName ? `HUMAN-MCP RESULT[${sessionName}]` : 'HUMAN-MCP RESULT';
  let lines = [];

  lines.push(`## ${appName} human relay${sessionName ? ` (session: ${sessionName})` : ''}`);
  lines.push('');
  lines.push(
    `You are connected to a live "${appName}" session through a human acting as a manual relay ` +
    'instead of a direct MCP connection. You cannot call tools yourself. Instead, ask the human to ' +
    'paste a block in the exact format below into the relay popup running on that page; they will ' +
    'run it and paste the result back here. Only ask for ONE call at a time, then wait for the ' +
    'result before deciding the next step.'
  );
  lines.push('');

  if (sessionName) {
    lines.push('### Multiple bridged apps in this conversation');
    lines.push('');
    lines.push(
      `This app's relay is named "${sessionName}". The human may have MORE THAN ONE relay popup open ` +
      'at once (one per bridged app/tab), each pasted into this same conversation with its own session ' +
      `name. Every call block you send for THIS app must be tagged with "${sessionName}" in the ` +
      `sentinel line, exactly as ${callSentinel} below - never the plain untagged HUMAN-MCP CALL, and ` +
      'never another app\'s session name. The result block the human pastes back will be tagged the ' +
      'same way, so you can always tell which app a result came from.'
    );
    lines.push('');
    lines.push(
      'If you need to act on a DIFFERENT bridged app, ask the human explicitly: tell them which app/' +
      'session name you need next (e.g. "please switch to the [other-session-name] relay popup and ' +
      'paste this there") before sending that call - do not assume which popup is currently focused. ' +
      'If a result comes back tagged with a session name you were not expecting, or the human reports ' +
      'a "wrong relay" error, stop and ask which app that block was actually meant for rather than ' +
      'guessing.'
    );
    lines.push('');
    lines.push(
      `If the human later mentions another session name and says (or implies) it's also "${appName}" ` +
      '(e.g. another tab/window of the same app), do NOT ask them to paste a second primer - reuse the ' +
      'exact tool list, params, and call format already given below, just tag calls with that new ' +
      'session name instead. This is safe because every instance of the same app exposes the identical ' +
      'tool manifest; only the document/state open in each tab differs. Only ask for a fresh primer if ' +
      'the human names a DIFFERENT app (a different name, not just a different session/instance of ' +
      `"${appName}").`
    );
    lines.push('');
  }

  if (context.summary) {
    lines.push('### App context');
    lines.push('');
    lines.push(context.summary);
    lines.push('');
  }
  lines.push('### Call format');
  lines.push('');
  lines.push(
    `Send the human EXACTLY this shape: the sentinel line ${callSentinel}, then ONE single-line or ` +
    'pretty-printed JSON object with exactly two top-level fields "tool" (string) and "args" (object), ' +
    'then the sentinel line HUMAN-MCP END - and wrap the WHOLE THING (both sentinel lines and the JSON ' +
    'between them) in a single triple-backtick code block (plain, no language tag needed). This is ' +
    'important even though the payload itself never needs backticks: most chat UIs only render a ' +
    'one-click "Copy" button on fenced code blocks, not on plain paragraph text, and the human needs to ' +
    'copy this exactly - do not send it as plain inline text.'
  );
  lines.push('');
  lines.push(callSentinel);
  lines.push('{"tool": "TOOL_NAME_HERE", "args": {}}');
  lines.push('HUMAN-MCP END');
  lines.push('');
  lines.push('(the two lines above should themselves be inside a triple-backtick fence when you actually send them)');
  lines.push('');
  lines.push(
    `The human will paste back a block starting with ${resultSentinel}, whose body is JSON shaped ` +
    '{"tool":..., "ok":true, "data":...} or {"tool":..., "ok":false, "error":...}. Read that block, ' +
    'then decide your next call. If ok is false - including when "tool" comes back as "unknown", which ' +
    'means the popup could not even parse your call block\'s JSON - read the error message, fix the ' +
    `mistake it describes (often the escaping issue below, or a session-tag mismatch), and send a ` +
    'corrected call block. Do not repeat the same broken block unchanged.'
  );
  lines.push('');
  lines.push(
    'IMPORTANT - the single most common mistake: some tools take an "args" field that is itself a ' +
    'JSON-encoded STRING (e.g. set_nodes\' and normalize_nodes\' "nodesJson"), not a nested JSON ' +
    'object/array. Check each tool\'s params below - if a param\'s type is "string" but its description ' +
    'says it holds JSON, its value in args must be a STRING containing that JSON text, which your JSON ' +
    'writer/serializer will automatically escape correctly (backslash-escaped inner quotes) as long as ' +
    'you actually construct it as a nested value and let normal JSON encoding handle it, rather than ' +
    'typing the escaped backslashes yourself by hand character-by-character - that is where mistakes ' +
    'creep in on large/nested node trees.'
  );
  lines.push('');
  lines.push('Correct example - note nodesJson is a STRING whose escaped quotes are produced by JSON encoding, not typed by hand:');
  lines.push(callSentinel);
  lines.push('{"tool": "set_nodes", "args": {"nodesJson": "[{\\"t\\":\\"div\\",\\"x\\":0,\\"y\\":0}]"}}');
  lines.push('HUMAN-MCP END');
  lines.push('');
  lines.push('### Available tools');
  lines.push('');

  for (let tool of tools) {
    lines.push(`#### ${tool.name}`);
    lines.push('');
    lines.push(tool.description || '(no description)');
    lines.push('');
    let paramNames = Object.keys(tool.params || {});
    if (paramNames.length === 0) {
      lines.push('Params: none. Use args: {}');
    } else {
      lines.push('Params:');
      for (let p of paramNames) {
        let spec = tool.params[p];
        lines.push(`- ${p} (${spec.type}): ${spec.description || ''}`);
      }
    }
    if (tool.example !== undefined) {
      lines.push('');
      lines.push('Example args: ' + JSON.stringify(tool.example));
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(
    'End of primer. ' +
    (context.closingNote ||
      'Start by asking the human to run a read-only call (like get_nodes or get_selection) so you can see ' +
      'the current state before proposing changes.')
  );

  return lines.join('\n');
}
