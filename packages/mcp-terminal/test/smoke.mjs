import { ToolRegistry } from '../src/tools/registry.ts';

async function main() {
  let reg = new ToolRegistry({ sandboxRoot: '/tmp/mcp-terminal-smoketest', allowExec: true });
  console.log('=== summary ===');
  console.log(reg.summary);
  console.log();

  let r1 = await reg.call('list_dir', { path: '.' });
  console.log('list_dir:', JSON.stringify(r1));

  let r2 = await reg.call('read_file', { path: 'a.txt' });
  console.log('read_file:', JSON.stringify(r2));

  let r3 = await reg.call('write_file', { path: 'sub/b.txt', content: 'written by tool' });
  console.log('write_file:', r3);

  try {
    await reg.call('read_file', { path: '../../etc/passwd' });
    console.log('SANDBOX FAILURE: relative escape succeeded!');
  } catch (e) {
    console.log('sandbox blocked relative escape (expected):', e.message.slice(0, 70));
  }

  try {
    await reg.call('read_file', { path: '/etc/passwd' });
    console.log('SANDBOX FAILURE: absolute escape succeeded!');
  } catch (e) {
    console.log('sandbox blocked absolute escape (expected):', e.message.slice(0, 70));
  }

  let r4 = await reg.call('find_files', { pattern: '*.txt' });
  console.log('find_files:', JSON.stringify(r4));

  let r5 = await reg.call('run_command', { command: 'echo hi from shell && pwd' });
  console.log('run_command:', JSON.stringify(r5));

  let reg2 = new ToolRegistry({ sandboxRoot: '/tmp/mcp-terminal-smoketest', allowExec: false });
  try {
    await reg2.call('run_command', { command: 'echo should not run' });
    console.log('EXEC-GATE FAILURE: ran despite allowExec:false');
  } catch (e) {
    console.log('run_command correctly disabled by default:', e.message.slice(0, 70));
  }

  console.log('\nALL SMOKE CHECKS DONE');
}

main().catch((e) => { console.error(e); process.exit(1); });
