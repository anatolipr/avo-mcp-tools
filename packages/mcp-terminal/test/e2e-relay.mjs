// End-to-end check of the human-relay flow using a real browser: loads
// relay-server.ts's page, confirms the WS-backed window.__mcpTools connects,
// confirms the imported human-mcp-relay.js popup renders, then drives an
// actual HUMAN-MCP CALL/RESULT round trip through the popup's own textareas
// and buttons - not just curling the HTTP endpoints.
import { chromium } from 'playwright';

const BASE = 'http://localhost:8799';

async function main() {
  let browser = await chromium.launch();
  // grantPermissions needs a page/context origin already set - use the http origin.
  let context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  let page = await context.newPage();

  page.on('console', (msg) => console.log(`[browser:${msg.type()}]`, msg.text()));
  page.on('pageerror', (err) => console.log('[browser:pageerror]', err.message));

  console.log('--- loading', BASE, '---');
  await page.goto(BASE);

  console.log('--- waiting for WS connection status ---');
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent?.includes('connected to mcp-terminal'),
    { timeout: 10_000 },
  );
  console.log('OK: status shows connected -', await page.textContent('#status'));

  console.log('--- waiting for window.__mcpTools to populate ---');
  await page.waitForFunction(() => Array.isArray(window.__mcpTools) && window.__mcpTools.length > 0, { timeout: 10_000 });
  let toolNames = await page.evaluate(() => window.__mcpTools.map((t) => t.name));
  console.log('OK: tools registered:', toolNames.join(', '));

  console.log('--- waiting for <human-mcp-relay> custom element to register ---');
  await page.waitForFunction(() => customElements.get('human-mcp-relay') !== undefined, { timeout: 10_000 });
  console.log('OK: <human-mcp-relay> defined (relay.js imported successfully from htmlpaint.com)');

  console.log('--- opening the popup via Cmd+Shift+A ---');
  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('A');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');

  let relay = page.locator('human-mcp-relay');
  await relay.waitFor({ state: 'attached', timeout: 5000 });

  // Popup content lives in a shadow root - Playwright pierces shadow DOM
  // automatically via locators scoped to the host element.
  let primerBox = relay.locator('textarea').first();
  await primerBox.waitFor({ state: 'visible', timeout: 5000 });
  let primerText = await primerBox.inputValue();
  console.log('OK: primer populated, length', primerText.length, 'chars, mentions read_file:', primerText.includes('read_file'));

  console.log('--- pasting a HUMAN-MCP CALL for read_file into the paste box ---');
  let callBlock = [
    'HUMAN-MCP CALL',
    JSON.stringify({ tool: 'read_file', args: { path: 'greeting.txt' } }),
    'HUMAN-MCP END',
  ].join('\n');

  let pasteBox = relay.locator('textarea').nth(1);
  await pasteBox.fill(callBlock);

  let runButton = relay.locator('button', { hasText: 'Run' }).last();
  await runButton.click();

  let resultBox = relay.locator('textarea').nth(2);
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.shadowRoot?.querySelectorAll('textarea')[2]?.value?.length > 0,
    'human-mcp-relay',
    { timeout: 5000 },
  );
  let resultText = await resultBox.inputValue();
  console.log('--- HUMAN-MCP RESULT block ---');
  console.log(resultText);

  let resultJson = JSON.parse(resultText.split('\n').slice(1, -1).join('\n'));
  if (resultJson.ok !== true) throw new Error('expected ok:true, got: ' + resultText);
  if (!resultJson.data?.content?.includes('hello from mcp-terminal e2e test')) {
    throw new Error('read_file result did not contain expected file content: ' + JSON.stringify(resultJson));
  }
  console.log('OK: read_file round-trip returned correct file content via the real popup UI');

  console.log('--- now testing a run_command call (npm-run-command style scaffolding step) ---');
  let callBlock2 = [
    'HUMAN-MCP CALL',
    JSON.stringify({ tool: 'run_command', args: { command: 'echo scaffolding-step-ok && ls' } }),
    'HUMAN-MCP END',
  ].join('\n');
  await pasteBox.fill(callBlock2);
  await runButton.click();
  await page.waitForTimeout(500);
  let resultText2 = await resultBox.inputValue();
  console.log('--- HUMAN-MCP RESULT block (run_command) ---');
  console.log(resultText2);
  let resultJson2 = JSON.parse(resultText2.split('\n').slice(1, -1).join('\n'));
  if (resultJson2.ok !== true || !resultJson2.data?.output?.includes('scaffolding-step-ok')) {
    throw new Error('run_command result unexpected: ' + resultText2);
  }
  console.log('OK: run_command round-trip works through the popup too');

  console.log('--- testing an unknown-tool error path ---');
  let callBlock3 = [
    'HUMAN-MCP CALL',
    JSON.stringify({ tool: 'delete_the_universe', args: {} }),
    'HUMAN-MCP END',
  ].join('\n');
  await pasteBox.fill(callBlock3);
  await runButton.click();
  await page.waitForTimeout(300);
  let resultText3 = await resultBox.inputValue();
  let resultJson3 = JSON.parse(resultText3.split('\n').slice(1, -1).join('\n'));
  if (resultJson3.ok !== false) throw new Error('expected unknown tool to fail, got: ' + resultText3);
  console.log('OK: unknown tool correctly reported as error:', resultJson3.error);

  await browser.close();
  console.log('\nALL E2E CHECKS PASSED');
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
