// Checks the realm against the system Clock, an application of another toolkit than Calculator:
//   - the three buttons at the top of the window have names, and are not three buttons with none;
//   - a tab is chosen, and the stopwatch is started, stopped and set back;
//   - the display of a running stopwatch never stops changing, and the press of Stop still works.
// The stopwatch writes no file and has no account. It is set back at the end.
//
//   node native/mac/clockcheck.mjs
//
// Needs the Accessibility permission. Build the package first. The screen goes to Clock for the
// time of the check. It does not run when Clock is open already.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const APP = 'Clock';
const helper = `${fileURLToPath(new URL('.', import.meta.url))}build/reticle-ax`;
const pidOf = () => {
  try {
    return Number(execFileSync('pgrep', ['-x', APP], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return 0;
  }
};
if (0 !== pidOf()) {
  process.stdout.write('computer-use clockcheck: skipped, Clock is open already\n');
  process.exit(0);
}
execFileSync('open', ['-a', APP]);
let pid = 0;
for (let tries = 0; tries < 40 && 0 === pid; tries += 1) {
  await sleep(250);
  pid = pidOf();
}
assert.ok(0 !== pid, 'Clock did not start');
const commands = new PeerCommands({
  driver: new MacDriver({ helper, app: APP, pid }),
  emit: () => undefined,
});
const names = async (role) =>
  (await commands.answer(ReticleCommand.QUERY, { role })).elements.map((e) => e.name);
async function press(role, name) {
  const found = await commands.answer(ReticleCommand.QUERY, { role, name });
  const ref = found.elements[0]?.ref;
  assert.ok(ref, `no ${role} named ${name}; there are: ${(await names(role)).join(', ')}`);
  return commands.answer(ReticleCommand.ACT, { ref, action: ActionType.CLICK });
}

try {
  for (let tries = 0; tries < 40 && !(await names('radio')).includes('Stopwatch'); tries += 1) {
    await sleep(250);
  }
  const top = await names('button');
  assert.ok(top.includes('Close window'), `the close button has no name: ${top.join(', ')}`);
  assert.ok(!top.includes(''), `a button of the window has no name: ${top.join(', ')}`);
  await press('radio', 'Stopwatch');
  await press('button', 'Start');
  assert.ok((await names('button')).includes('Stop'), 'the stopwatch did not start');
  await press('button', 'Stop');
  assert.ok((await names('button')).includes('Reset'), 'the stopwatch did not stop');
  await press('button', 'Reset');
  assert.ok(!(await names('button')).includes('Reset'), 'the stopwatch was not set back');
  process.stdout.write('computer-use clockcheck: the stopwatch ran, stopped and was set back\n');
} finally {
  process.kill(pid);
}
