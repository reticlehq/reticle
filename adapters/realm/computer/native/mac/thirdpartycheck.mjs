// Checks the realm against an application that Reticle did not write: the system Calculator.
// The realm presses 7 × 6 = with no pointer, and the display must say 42.
// Calculator writes no file and has no account, so a wrong press cannot harm the machine.
//
//   node native/mac/thirdpartycheck.mjs
//
// Needs the Accessibility permission. Build the package first.
// Does not run if Calculator is open already: that window belongs to the person.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const APP = 'Calculator';
const helper = `${fileURLToPath(new URL('.', import.meta.url))}build/reticle-ax`;
const pidOf = () => {
  try {
    return Number(execFileSync('pgrep', ['-x', APP], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return 0;
  }
};

if (0 !== pidOf()) {
  process.stdout.write('computer thirdpartycheck: skipped, Calculator is open already\n');
  process.exit(0);
}
// -g starts the application and leaves the front application where it is. macOS does not give
// the tree of a window on another Space, so a person who works in a full-screen Space passes
// --front: the screen goes to Calculator for the time of the check.
const front = process.argv.includes('--front');
execFileSync('open', front ? ['-a', APP] : ['-g', '-a', APP]);
await sleep(2500);
const pid = pidOf();
assert.ok(0 !== pid, 'Calculator did not start');

const commands = new PeerCommands({
  driver: new MacDriver({ helper, app: APP, pid }),
  emit: () => undefined,
});
const names = async (role) =>
  (await commands.answer(ReticleCommand.QUERY, { role })).elements.map((e) => e.name);
async function press(name) {
  const found = await commands.answer(ReticleCommand.QUERY, { role: 'button', name });
  const ref = found.elements[0]?.ref;
  assert.ok(ref, `no button named ${name}; the buttons are: ${(await names('button')).join(', ')}`);
  return commands.answer(ReticleCommand.ACT, { ref, action: ActionType.CLICK });
}

try {
  // A cold start shows the window some time after the process is there. Wait for the buttons,
  // not for a fixed time: the first run of this check pressed before the window had them.
  for (let tries = 0; tries < 40 && 0 === (await names('button')).length; tries += 1) {
    await sleep(250);
  }
  if (process.argv.includes('--dump')) {
    process.stdout.write(
      `${JSON.stringify({ buttons: await names('button'), text: await names('text') })}\n`,
    );
  } else {
    for (const name of ['7', 'Multiply', '6']) {
      await press(name);
    }
    const last = await press('Equals');
    assert.ok(last.effect.domMutatedWithin > 0, 'the press of Equals reported no effect');
    const shown = (await names('text')).join(' ').replace(/[^\d]/g, '');
    assert.equal(shown.endsWith('42'), true, `the display did not say 42: ${shown}`);
    // The display is a text that takes no click, and the system gives the area that holds it
    // as the answer of a hit test. The realm said that the text was covered, and a check for
    // "42 is visible" failed on a display that showed 42.
    const visible = await commands.answer(ReticleCommand.MATCH, {
      query: { text: '42' },
      state: 'visible',
    });
    assert.equal(
      visible.matched,
      true,
      'the display shows 42, and the realm said it is not visible',
    );
    process.stdout.write('computer thirdpartycheck: Calculator gave 42\n');
  }
} finally {
  process.kill(pid);
}
