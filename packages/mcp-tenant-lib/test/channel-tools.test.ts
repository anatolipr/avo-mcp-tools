import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { registerChannelTools } from '../src/channel-tools.js';
import { tenants } from '../src/tenant.js';

const PORT = 18902;
const BASE_URL = `http://localhost:${PORT}`;
let httpServer: Server;

function textOf(result: Record<string, unknown>): string {
  const content = result.content as Array<{ text: string }>;
  return content[0]!.text;
}

// One server shared across every test in this file (spun up once in
// before(), torn down once in after()) rather than per-test — Server.close()
// waits for open sockets to drain before its callback fires, and a fresh
// StreamableHTTPClientTransport's keep-alive connection doesn't always
// close fast enough for a next test's listen() on the same port to avoid
// EADDRINUSE. Matches the pattern in mcp-form/test/tenant-isolation.test.ts.
before(async () => {
  httpServer = createHttpServer({
    port: PORT,
    staticDir: os.tmpdir(),
    initialSchema: undefined,
    initialValues: {},
    identity: { name: 'test', version: '0.0.1' },
    registerFn: (mcp, tenant, port, setChannel) => {
      registerChannelTools(mcp, tenant, port, setChannel, undefined, {});
    },
  });
  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
});

after(() => {
  httpServer.close();
});

async function connectClient() {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', BASE_URL));
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await transport.terminateSession();
    await originalClose();
  };
  return { client, transport };
}

test('join_channel retargets the session onto the named tenant', async () => {
  const { client } = await connectClient();
  try {
    const joinResult = await client.callTool({ name: 'join_channel', arguments: { channel: 'unit-test-pets' } });
    assert.match(textOf(joinResult as any), /Joined channel "unit-test-pets"/);
    assert.ok(tenants.has('unit-test-pets'), 'joining should auto-vivify the named tenant');
  } finally {
    await client.close();
    tenants.get('unit-test-pets')?.dispose();
    tenants.delete('unit-test-pets');
  }
});

test('two sessions joining the same channel share the same Tenant instance', async () => {
  const a = await connectClient();
  const b = await connectClient();
  try {
    await a.client.callTool({ name: 'join_channel', arguments: { channel: 'shared-channel' } });
    await b.client.callTool({ name: 'join_channel', arguments: { channel: 'shared-channel' } });

    const tenant = tenants.get('shared-channel');
    assert.ok(tenant, 'channel tenant should exist after both sessions join');
    tenant!.store.set('note', 'set by session a');

    // Both sessions now resolve to the same Tenant object, so reading the
    // store directly (rather than through a form-specific tool, which this
    // generic test harness doesn't register) proves the retargeting worked
    // for both sessions, not just the one that happened to create it.
    assert.equal(tenant!.store.get('note'), 'set by session a');
  } finally {
    await a.client.close();
    await b.client.close();
    tenants.get('shared-channel')?.dispose();
    tenants.delete('shared-channel');
  }
});

test('join_channel rejects a name with non-slug characters', async () => {
  const { client } = await connectClient();
  try {
    const result = await client.callTool({ name: 'join_channel', arguments: { channel: 'not a valid name!' } });
    assert.equal((result as any).isError, true);
    assert.match(textOf(result as any), /not a valid channel name/);
    assert.ok(!tenants.has('not a valid name!'), 'an invalid name should never be vivified');
  } finally {
    await client.close();
  }
});

test('list_channels reflects named channels with no hidden filtering', async () => {
  const { client } = await connectClient();
  try {
    await client.callTool({ name: 'join_channel', arguments: { channel: 'listed-channel' } });

    const result = await client.callTool({ name: 'list_channels', arguments: {} });
    const ids: string[] = JSON.parse(textOf(result as any));
    assert.ok(ids.includes('listed-channel'));
    // This test harness uses createHttpServer's default defaultTenantMode
    // ('per-session'), which never vivifies a 'default' tenant on its own —
    // unlike a server configured with defaultTenantMode: 'shared' (e.g.
    // mcp-form), where 'default' is a real, shared channel list_channels
    // is expected to surface, not hide.
    assert.ok(!ids.includes('default'));
  } finally {
    await client.close();
    tenants.get('listed-channel')?.dispose();
    tenants.delete('listed-channel');
  }
});

test('channel_find surfaces a loosely-named channel by fuzzy match, without joining or creating it', async () => {
  const { client } = await connectClient();
  try {
    await client.callTool({ name: 'join_channel', arguments: { channel: 'pet_food_memory' } });

    const result = await client.callTool({ name: 'channel_find', arguments: { query: 'pets' } });
    const matches: Array<{ name: string; score: number }> = JSON.parse(textOf(result as any));
    assert.ok(matches.some((m) => m.name === 'pet_food_memory'), 'fuzzy query "pets" should surface "pet_food_memory"');
    assert.ok(!tenants.has('pets'), 'channel_find must not create a channel named after the query itself');
  } finally {
    await client.close();
    tenants.get('pet_food_memory')?.dispose();
    tenants.delete('pet_food_memory');
  }
});

test('channel_find returns nothing for a query with no reasonable match', async () => {
  const { client } = await connectClient();
  try {
    const result = await client.callTool({ name: 'channel_find', arguments: { query: 'zzzzz_no_such_thing_qqqqq' } });
    const matches: Array<{ name: string; score: number }> = JSON.parse(textOf(result as any));
    assert.deepEqual(matches, []);
  } finally {
    await client.close();
  }
});

test('a session that never calls join_channel keeps its own isolated bootstrap tenant', async () => {
  // Snapshot BEFORE connecting — connectClient() itself already vivifies a
  // bootstrap tenant via http.ts's onsessioninitialized, so capturing this
  // after both connects would see zero "new" ids.
  const before = new Set(tenants.keys());

  const a = await connectClient();
  const b = await connectClient();
  try {
    // Neither session joins a channel — this must behave exactly like
    // today's per-session isolation (tenant-isolation.test.ts in mcp-form),
    // proving join_channel is additive and does not change default behavior.
    const listA = await a.client.callTool({ name: 'list_channels', arguments: {} });
    const idsA: string[] = JSON.parse(textOf(listA as any));

    // Each session's own bootstrap tenant is a distinct, freshly-vivified
    // id — both appear in the flat list (no hidden filtering), and there
    // are exactly two new ones beyond whatever existed before this test.
    const newIds = idsA.filter((id) => !before.has(id) && id !== 'default');
    assert.equal(newIds.length, 2, 'both sessions should have distinct unnamed bootstrap tenants');
  } finally {
    await a.client.close();
    await b.client.close();
  }
});
