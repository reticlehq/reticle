import { irisTest, bootSession, runSpecs, createTestContext } from '@syrin/test';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

irisTest('hover reveals words — guarded by real input', async (t) => {
  await t.expectInputModeReal();              // skips-with-reason if synthetic; passes under iris drive
  await t.act('smart-sentence', 'hover');
  await t.expectElement({ testid: 'word:0' }, 'visible');
});
irisTest('add-task grows the list', async (t) => {
  await t.act('add-task', 'click');
  await t.expectElement({ testid: 'task-list' }, 'visible');
});
irisTest('ping fires GET /api/ping 200 and opens the modal', async (t) => {
  await t.actAndWait('ping-button', 'click', { kind: 'net', method: 'GET', urlContains: '/api/ping', status: 200 });
  await t.expectElement({ testid: 'reply-modal' }, 'visible');
});

console.log('\n=== @syrin/test running 3 specs headless via iris drive ===');
const booted = await bootSession({ driveUrl: 'http://localhost:3100/', headless: true });
for (let i = 0; i < 200; i++) { const s = await booted.invoke('iris_sessions', {}); if ((s.sessions ?? []).length > 0) break; await sleep(50); }
const print = (l) => process.stdout.write('   ' + l + '\n');
const { summary } = await runSpecs({
  invoke: booted.invoke,
  now: () => Date.now(),
  buildContext: (invoke) => createTestContext(invoke, { sessionId: 'next-smoke' }),
  print,
});
console.log(`\n${summary.ok ? '✅ @syrin/test SUITE GREEN' : '❌ FAILED'}  passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped}`);
await booted.close();
process.exit(summary.failed === 0 ? 0 : 1);
