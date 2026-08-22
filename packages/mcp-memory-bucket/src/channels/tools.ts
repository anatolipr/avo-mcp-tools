import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getOrCreateChannel, getChannel, listChannels, isValidChannelName } from './store.js';
import { findChannelMatches } from './search.js';

export function registerMemoryChannelTools(mcp: McpServer): void {
  mcp.tool(
    'memory_channel_read',
    'Reads a memory channel: ephemeral, in-memory-only text shared live between agent sessions on this server ' +
    '— distinct from persisted memory_* docs (never on disk, never indexed by search). Empty content if the ' +
    'channel doesn\'t exist yet — reading never creates one (memory_channel_post does). ' +
    'IMPORTANT: empty is ambiguous ("nothing posted yet" vs "wrong name" — matching is EXACT, no fuzz). Before ' +
    'saying a discussion doesn\'t exist, call memory_channel_find or list_memory_channels to check for a ' +
    'similarly-named channel (e.g. "pets" vs "pet_discussion").',
    { channel: z.string().describe('Channel name. Letters/digits/underscore/hyphen only.') },
    async ({ channel }: { channel: string }) => {
      if (!isValidChannelName(channel)) {
        return {
          content: [{ type: 'text', text: `Error: "${channel}" is not a valid channel name — use only letters, digits, underscore, and hyphen.` }],
          isError: true,
        };
      }
      const existing = getChannel(channel);
      return {
        content: [{ type: 'text', text: JSON.stringify({ content: existing?.content ?? '', lastActivityAt: existing?.lastActivityAt ?? null }, null, 2) }],
      };
    }
  );

  mcp.tool(
    'memory_channel_post',
    'Writes to a memory channel, replacing its content (last-write-wins) — auto-creates it if missing. ' +
    'Ephemeral, in-memory only: never on disk, never indexed by search, gone on restart or after a long idle ' +
    'period. This ALWAYS replaces content — "append to a discussion" vs "hand over a fresh summary" is your ' +
    'choice, not a mode: to preserve history, read first then post the old content plus your addition ' +
    'concatenated; to hand over cleanly, just post fresh content. Names must match EXACTLY — if continuing an ' +
    'existing discussion, double-check via memory_channel_find/list_memory_channels first, or a typo silently ' +
    'starts an unrelated empty channel instead of erroring.',
    {
      channel: z.string().describe('Channel name. Letters/digits/underscore/hyphen only.'),
      content: z.string().describe('The full new content of the channel — replaces whatever was there before.'),
    },
    async ({ channel, content }: { channel: string; content: string }) => {
      if (!isValidChannelName(channel)) {
        return {
          content: [{ type: 'text', text: `Error: "${channel}" is not a valid channel name — use only letters, digits, underscore, and hyphen.` }],
          isError: true,
        };
      }
      const ch = getOrCreateChannel(channel);
      ch.content = content;
      ch.lastActivityAt = Date.now();
      return {
        content: [{ type: 'text', text: `Posted ${content.length} character(s) to channel "${channel}".` }],
      };
    }
  );

  mcp.tool(
    'list_memory_channels',
    'Lists every memory channel currently live on this server, with when each was last written or read. Use ' +
    'this to discover an existing channel by name before calling memory_channel_read/post on it.',
    {},
    async () => {
      const channels = listChannels().map((c) => ({ name: c.name, lastActivityAt: c.lastActivityAt }));
      return { content: [{ type: 'text', text: JSON.stringify(channels, null, 2) }] };
    }
  );

  mcp.tool(
    'memory_channel_find',
    'Fuzzy-searches existing memory channel names for a loose query (e.g. "the pets discussion") instead of ' +
    'guessing at memory_channel_read/post or eyeballing list_memory_channels yourself. Matches whole-name ' +
    'similarity (typos) and per-word similarity on underscore/hyphen-split parts (e.g. "pets" matches ' +
    '"pet_food_memory" via "pet"). Returns ranked {name, score} (0..1, higher better), empty if nothing scores ' +
    'above threshold. Read-only — does not read or create anything. Call memory_channel_read yourself on the ' +
    'right result; if scores are close, ask the user to disambiguate rather than guessing.',
    { query: z.string().describe('Loose/partial channel name or topic to search for, e.g. "pets".') },
    async ({ query }: { query: string }) => {
      const matches = findChannelMatches(query, listChannels().map((c) => c.name));
      return { content: [{ type: 'text', text: JSON.stringify(matches, null, 2) }] };
    }
  );
}
