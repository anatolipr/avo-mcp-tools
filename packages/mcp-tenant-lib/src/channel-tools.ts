import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from './tenant.js';
import { tenants, getOrCreateTenant, isValidChannelName, getRootTenant } from './tenant.js';
import { findChannelMatches } from './channel-search.js';
import { buildDescribePayload } from './manifest-tools.js';

/**
 * Registers `join_channel`, `list_channels`, `channel_find`,
 * `describe_channel`, and `describe_connection` on an MCP server built via
 * buildMcpServer. Shared across every mcp-tenant-lib consumer (mcp-form,
 * js-bridge-mcp, ...) so the tool behavior/wording stays identical rather
 * than reimplemented per package.
 *
 * `tenant`/`setChannel`/`resetChannel`/`port` are exactly what registerFn
 * (see mcp.ts) receives — pass them straight through from there.
 */
export function registerChannelTools<TSchema, TValues>(
  mcp: McpServer,
  tenant: () => Tenant<TSchema, TValues>,
  port: number,
  setChannel: (id: string) => void,
  resetChannel: () => void,
  initialSchema: TSchema,
  initialValues: TValues
): void {
  mcp.tool(
    'join_channel',
    'Names (or rejoins) a channel: a persistent, agent-chosen identity for this session\'s live state, shared ' +
    'with any other session that joins the same name. DEFAULT TO CALLING THIS as one of your first actions, ' +
    'with a name derived from the topic at hand (e.g. a request about "pets" → join_channel("pets")) — not ' +
    'something reserved for when you happen to think of it. Skip only when the user says it\'s a ' +
    'one-off/throwaway, or nothing suggests a distinct topic worth naming — root connections (e.g. a specific ' +
    'bridged app or MCP proxy) are already visible with no channel needed, see describe_connection. Reusing ' +
    'an existing name is expected, not an error: it retargets this session onto that channel\'s live state ' +
    '(e.g. to resume, or redefine/refresh it). Names are URL-safe slugs: letters, digits, underscore, hyphen ' +
    'only. Pass "" to return this session to where it started (its root connection, if any) instead of a ' +
    'named channel. To only inspect a channel\'s tools without retargeting this session onto it, use ' +
    'describe_channel instead.',
    { channel: z.string().describe('Agent-chosen channel name, e.g. "pets" — or "" to return to this session\'s original (root) state.') },
    async ({ channel }: { channel: string }) => {
      if (channel === '') {
        resetChannel();
        return { content: [{ type: 'text', text: 'Returned to this session\'s original (root) state.' }] };
      }
      if (!isValidChannelName(channel)) {
        return {
          content: [{ type: 'text', text: `Error: "${channel}" is not a valid channel name — use only letters, digits, underscore, and hyphen.` }],
          isError: true,
        };
      }
      getOrCreateTenant(channel, initialSchema, initialValues);
      setChannel(channel);
      return {
        content: [{ type: 'text', text: `Joined channel "${channel}" — http://localhost:${port}/t/${channel}` }],
      };
    }
  );

  mcp.tool(
    'list_channels',
    'Lists every real, named channel currently live on this server — NOT root connections (unnamed/' +
    'directly-addressed ones like a specific bridged app or MCP proxy; see describe_connection for those). ' +
    'Use this to discover an existing named channel, e.g. when a human refers to "the pets form" without ' +
    'giving the exact channel name. Each entry includes a `connections` array — one item per live browser ' +
    'tab/page joined into that channel, with its display `label` and `toolCount` — so you can tell which ' +
    'channels actually have something connected. To see the actual tools on one, call describe_channel ' +
    'rather than joining just to look.',
    {},
    async () => {
      const channels = [...tenants.entries()]
        .filter(([, t]) => !t.isRoot)
        .map(([channel, t]) => ({
          channel,
          connections: [...t.connections.values()].map((c) => ({
            label: c.label ?? null,
            toolCount: c.manifest.length,
          })),
        }));
      return { content: [{ type: 'text', text: JSON.stringify(channels, null, 2) }] };
    }
  );

  mcp.tool(
    'channel_find',
    'Fuzzy-searches existing channel names for ones matching a loose query — use this when a human refers to ' +
    'a channel by topic or partial name (e.g. "the pets channel") rather than its exact name, instead of ' +
    'guessing at join_channel or falling back to eyeballing the full list_channels output yourself. Matches on ' +
    'both whole-name similarity (catches typos) and per-word similarity against underscore/hyphen-split parts ' +
    'of each name (catches "pets" matching "pet_food_memory" via the shared word "pet"). Returns a ranked list ' +
    'of {name, score} (score 0..1, higher is better) — empty if nothing scores above the threshold. Read-only: ' +
    'does NOT join or create anything, even on an exact match. Given the result(s), call join_channel yourself ' +
    'on whichever one is actually right — if there\'s one clear best match, use it directly; if several score ' +
    'closely, ask the user to disambiguate rather than guessing.',
    { query: z.string().describe('Loose/partial channel name or topic to search for, e.g. "pets".') },
    async ({ query }: { query: string }) => {
      const matches = findChannelMatches(query, [...tenants.keys()]);
      return { content: [{ type: 'text', text: JSON.stringify(matches, null, 2) }] };
    }
  );

  mcp.tool(
    'describe_channel',
    'Returns the tool manifest for a named channel — same payload as describe_tools, but for ANY channel, ' +
    'not just the one this session is currently on. Use this to go straight from a channel name (e.g. from ' +
    'list_channels or channel_find) to what tools it has, without join_channel first retargeting this ' +
    'session\'s own state onto it. Read-only: does not join, create, or affect this session\'s current ' +
    'channel. Errors if the channel does not exist yet — check list_channels/channel_find first. If a tool ' +
    'listed here fails to invoke with "No such tool available" (typically right after the MCP server ' +
    'process was restarted), your MCP client\'s own connection is stale, not this manifest — tell the user ' +
    'to reconnect the MCP client (e.g. /mcp in Claude Code) rather than retrying the call.',
    { channel: z.string().describe('Exact channel name, e.g. from list_channels or channel_find.') },
    async ({ channel }: { channel: string }) => {
      const t = tenants.get(channel);
      if (!t) {
        return {
          content: [{ type: 'text', text: `Error: no channel named "${channel}" — use list_channels or channel_find to find the right name.` }],
          isError: true,
        };
      }
      const payload = buildDescribePayload(t);
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    }
  );

  mcp.tool(
    'describe_connection',
    'Returns the tool manifest for one ROOT connection by name (a specific bridged app, browser extension, ' +
    'or MCP proxy addressed directly rather than through a channel) — root connections do not appear in ' +
    'list_channels/channel_find, so this is the direct way to inspect one. Its tools are already visible ' +
    '(prefixed by this same name) in your own tools/list without calling this first; use it when you want ' +
    'the connection\'s summary or full tool list before calling one. Read-only: does not join or retarget ' +
    'this session. Errors if no root connection has that name.',
    { name: z.string().describe('Root connection name, e.g. "extension" or an MCP proxy\'s slug.') },
    async ({ name }: { name: string }) => {
      const t = getRootTenant(name);
      if (!t) {
        return {
          content: [{ type: 'text', text: `Error: no root connection named "${name}".` }],
          isError: true,
        };
      }
      const payload = buildDescribePayload(t);
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    }
  );
}
