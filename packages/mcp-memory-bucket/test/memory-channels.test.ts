import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerMemoryChannelTools } from '../src/channels/tools.js';
import { channels, isValidChannelName, getOrCreateChannel } from '../src/channels/store.js';

function textOf(result: Record<string, unknown>): string {
  const content = result.content as Array<{ text: string }>;
  return content[0]!.text;
}

// InMemoryTransport avoids the HTTP/keep-alive complexity of a real
// StreamableHTTPServerTransport (which the mcp-tenant-lib channel tests
// hit — see channel-tools.test.ts) since these tools have no HTTP-level
// concerns of their own; connecting two linked in-process transports is
// enough to exercise the real registered tool handlers end-to-end.
async function makeClient(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerMemoryChannelTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

test('memory_channel_post creates a channel; memory_channel_read round-trips its content', async () => {
  const client = await makeClient();
  await client.callTool({ name: 'memory_channel_post', arguments: { channel: 'unit-test-standup', content: 'agent 1 here' } });
  const result = await client.callTool({ name: 'memory_channel_read', arguments: { channel: 'unit-test-standup' } });
  const parsed = JSON.parse(textOf(result as any));
  assert.equal(parsed.content, 'agent 1 here');
  assert.ok(typeof parsed.lastActivityAt === 'number');
  channels.delete('unit-test-standup');
});

test('memory_channel_read on a channel that was never posted to returns empty content without creating it', async () => {
  const client = await makeClient();
  const result = await client.callTool({ name: 'memory_channel_read', arguments: { channel: 'unit-test-never-posted' } });
  const parsed = JSON.parse(textOf(result as any));
  assert.equal(parsed.content, '');
  assert.equal(parsed.lastActivityAt, null);
  assert.ok(!channels.has('unit-test-never-posted'), 'reading must not auto-vivify a channel');
});

test('memory_channel_post is last-write-wins — a second post replaces, does not append', async () => {
  const client = await makeClient();
  await client.callTool({ name: 'memory_channel_post', arguments: { channel: 'unit-test-refresh', content: 'first' } });
  await client.callTool({ name: 'memory_channel_post', arguments: { channel: 'unit-test-refresh', content: 'second' } });
  const result = await client.callTool({ name: 'memory_channel_read', arguments: { channel: 'unit-test-refresh' } });
  assert.equal(JSON.parse(textOf(result as any)).content, 'second');
  channels.delete('unit-test-refresh');
});

test('agent-preserved history: read-then-concatenate keeps prior contributions across posts', async () => {
  const client = await makeClient();
  await client.callTool({ name: 'memory_channel_post', arguments: { channel: 'unit-test-discussion', content: 'agent A: hello' } });
  const first = await client.callTool({ name: 'memory_channel_read', arguments: { channel: 'unit-test-discussion' } });
  const priorContent = JSON.parse(textOf(first as any)).content;
  await client.callTool({
    name: 'memory_channel_post',
    arguments: { channel: 'unit-test-discussion', content: `${priorContent}\nagent B: hi back` },
  });
  const second = await client.callTool({ name: 'memory_channel_read', arguments: { channel: 'unit-test-discussion' } });
  assert.equal(JSON.parse(textOf(second as any)).content, 'agent A: hello\nagent B: hi back');
  channels.delete('unit-test-discussion');
});

test('list_memory_channels reflects channels created via post', async () => {
  const client = await makeClient();
  await client.callTool({ name: 'memory_channel_post', arguments: { channel: 'unit-test-listed', content: 'x' } });
  const result = await client.callTool({ name: 'list_memory_channels', arguments: {} });
  const names = (JSON.parse(textOf(result as any)) as Array<{ name: string }>).map((c) => c.name);
  assert.ok(names.includes('unit-test-listed'));
  channels.delete('unit-test-listed');
});

test('invalid channel names are rejected by both post and read', async () => {
  const client = await makeClient();
  const postResult = await client.callTool({ name: 'memory_channel_post', arguments: { channel: 'not valid!', content: 'x' } });
  assert.equal((postResult as any).isError, true);
  assert.ok(!channels.has('not valid!'));

  const readResult = await client.callTool({ name: 'memory_channel_read', arguments: { channel: 'not valid!' } });
  assert.equal((readResult as any).isError, true);
});

test('isValidChannelName accepts letters/digits/underscore/hyphen only', () => {
  assert.ok(isValidChannelName('pets'));
  assert.ok(isValidChannelName('pet_questions_1_of_2'));
  assert.ok(isValidChannelName('pet-questions-1'));
  assert.ok(!isValidChannelName('not a valid name'));
  assert.ok(!isValidChannelName('has/slash'));
  assert.ok(!isValidChannelName(''));
});

test('getOrCreateChannel returns the same instance on repeated calls with the same name', () => {
  const a = getOrCreateChannel('unit-test-same-instance');
  const b = getOrCreateChannel('unit-test-same-instance');
  assert.equal(a, b);
  channels.delete('unit-test-same-instance');
});

test('memory_channel_find surfaces a loosely-named channel by fuzzy match, without reading or creating it', async () => {
  const client = await makeClient();
  await client.callTool({ name: 'memory_channel_post', arguments: { channel: 'pet_food_memory', content: 'x' } });
  try {
    const result = await client.callTool({ name: 'memory_channel_find', arguments: { query: 'pets' } });
    const matches: Array<{ name: string; score: number }> = JSON.parse(textOf(result as any));
    assert.ok(matches.some((m) => m.name === 'pet_food_memory'), 'fuzzy query "pets" should surface "pet_food_memory"');
    assert.ok(!channels.has('pets'), 'memory_channel_find must not create a channel named after the query itself');
  } finally {
    channels.delete('pet_food_memory');
  }
});

test('memory_channel_find returns nothing for a query with no reasonable match', async () => {
  const client = await makeClient();
  const result = await client.callTool({ name: 'memory_channel_find', arguments: { query: 'zzzzz_no_such_thing_qqqqq' } });
  const matches: Array<{ name: string; score: number }> = JSON.parse(textOf(result as any));
  assert.deepEqual(matches, []);
});
