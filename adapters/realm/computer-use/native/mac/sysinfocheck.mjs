// Checks the realm against System Information, an application of an outline and tables. It only
// shows facts of the machine, and the check writes none of them out.
//   - a row of the outline has the name a person reads, from the words inside it;
//   - a click on those words chooses the row, as the click of a person does;
//   - the row of the outline is then the one that is chosen.
//
//   node native/mac/sysinfocheck.mjs
//
// Needs the Accessibility permission. Build the package first. The screen goes to System
// Information for the time of the check. It does not run when it is open already.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const APP = 'System Information';
const ROW = 'Memory';
const helper = `${fileURLToPath(new URL('.', import.meta.url))}build/reticle-ax`;
const pidOf = () => {
  try {
    return Number(execFileSync('pgrep', ['-x', APP], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return 0;
  }
};
if (0 !== pidOf()) {
  process.stdout.write('computer-use sysinfocheck: skipped, System Information is open already\n');
  process.exit(0);
}
execFileSync('open', ['-a', APP]);
let pid = 0;
for (let tries = 0; tries < 40 && 0 === pid; tries += 1) {
  await sleep(250);
  pid = pidOf();
}
assert.ok(0 !== pid, 'System Information did not start');
const commands = new PeerCommands({
  driver: new MacDriver({ helper, app: APP, pid }),
  emit: () => undefined,
});
const row = async () =>
  (await commands.answer(ReticleCommand.QUERY, { role: 'row', name: ROW })).elements[0];

try {
  let found;
  for (let tries = 0; tries < 60 && found === undefined; tries += 1) {
    await sleep(250);
    found = await row();
  }
  assert.ok(found, `no row has the name ${ROW}`);
  assert.notEqual(found.value, 'selected', 'the row was chosen before the check began');
  // The words of the row, and not the row: an agent that looks for a text gets this element.
  const words = (await commands.answer(ReticleCommand.QUERY, { role: 'textbox', text: ROW }))
    .elements[0];
  assert.ok(words, `no field holds the words ${ROW}`);
  await commands.answer(ReticleCommand.ACT, { ref: words.ref, action: ActionType.CLICK });
  let chosen;
  for (let tries = 0; tries < 20 && 'selected' !== chosen?.value; tries += 1) {
    await sleep(250);
    chosen = await row();
  }
  assert.equal(chosen?.value, 'selected', 'the click on the words did not choose the row');
  process.stdout.write('computer-use sysinfocheck: a row was named, and a click chose it\n');
} finally {
  process.kill(pid);
}
