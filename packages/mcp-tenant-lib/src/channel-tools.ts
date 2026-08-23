import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from './tenant.js';
import { tenants, getOrCreateTenant, isValidChannelName } from './tenant.js';
import { findChannelMatches } from './channel-search.js';

/**
 * Registers `join_channel` and `list_channels` on an MCP server built via
 * buildMcpServer. Shared across every mcp-tenant-lib consumer (mcp-form,
 * js-bridge-mcp, ...) so the tool behavior/wording stays identical rather
 * than reimplemented per package.
 *
 * `tenant`/`setChannel`/`port` are exactly what registerFn (see mcp.ts)
 * receives — pass them straight through from there.
 */
export function registerChannelTools<TSchema, TValues>(
  mcp: McpServer,
  tenant: () => Tenant<TSchema, TValues>,
  port: number,
  setChannel: (id: string) => void,
  initialSchema: TSchema,
  initialValues: TValues
): void {
  mcp.tool(
    'join_channel',
    'Names (or rejoins) a channel: a persistent, agent-chosen identity for this session\'s live state, shared ' +
    'with any other session that joins the same name. DEFAULT TO CALLING THIS as one of your first actions, ' +
    'with a name derived from the topic at hand (e.g. a request about "pets" → join_channel("pets")) — not ' +
    'something reserved for when you happen to think of it. Until called, a session sits on the shared, ' +
    'anonymous "default" channel, visible to every other unnamed session on this server — skip only when the ' +
    'user says it\'s a one-off/throwaway, or nothing suggests a distinct topic worth naming. Reusing an ' +
    'existing name is expected, not an error: it retargets this session onto that channel\'s live state (e.g. ' +
    'to resume, or redefine/refresh it). Names are URL-safe slugs: letters, digits, underscore, hyphen only.',
    { channel: z.string().describe('Agent-chosen channel name, e.g. "pets" or "pet_questions_1_of_2". Letters/digits/underscore/hyphen only.') },
    async ({ channel }: { channel: string }) => {
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
    'Lists every channel currently live on this server, including "default" (the shared, anonymous channel ' +
    'sessions land on before calling join_channel). Use this to discover an existing named channel before ' +
    'calling join_channel on it, e.g. when a human refers to "the pets form" without giving the exact channel ' +
    'name. Each entry includes a `connections` array — one item per live browser tab/page bridged into that ' +
    'channel, with its display `label` and `toolCount` — so you can tell which channels actually have ' +
    'something connected without joining each one to check.',
    {},
    async () => {
      const channels = [...tenants.entries()].map(([channel, t]) => ({
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
}
