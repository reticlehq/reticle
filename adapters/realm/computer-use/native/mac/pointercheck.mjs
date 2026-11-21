// Checks the real pointer against the fixture application, through the peer: a click, a
// double-click, a right-click, a drag and a hover, each asked for with `foreground: true`.
//
//   node native/mac/pointercheck.mjs
//
// IT TAKES THE POINTER for a few seconds, and puts it back. Needs the Accessibility permission.
// Build the package first. Do not move the pointer while it runs.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
for (const name of ['reticle-ax', 'fixture']) {
  execFileSync('swiftc', ['-O', `${here}${name}.swift`, '-o', `${build}/${name}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

const fixture = spawn(`${build}/fixture`, [tmpdir()], { stdio: 'ignore' });
const commands = new PeerCommands({
  driver: new MacDriver({ helper: `${build}/reticle-ax`, app: 'fixture', pid: fixture.pid }),
  emit: () => undefined,
});

const pad = async () =>
  (await commands.answer(ReticleCommand.QUERY, { role: 'button', name: 'Pad' })).elements[0];
const status = async () =>
  (await commands.answer(ReticleCommand.QUERY, { role: 'text' })).elements[0]?.name;
/** One gesture on the pad, and the words the pad then shows. */
async function gesture(action, args) {
  await commands.answer(ReticleCommand.ACT, {
    ref: (await pad()).ref,
    action,
    args: { settleMs: 700, ...args },
  });
  return status();
}

try {
  await sleep(1500);
  // Without the foreground, the realm does not take the pointer, and it says how to ask.
  await assert.rejects(gesture(ActionType.DBLCLICK), /foreground: true/);

  assert.equal(await gesture(ActionType.CLICK, { foreground: true }), 'Pad: click');
  assert.equal(await gesture(ActionType.DBLCLICK, { foreground: true }), 'Pad: double');
  assert.equal(
    await gesture(ActionType.CLICK, { foreground: true, button: 'right' }),
    'Pad: right',
  );
  const { box } = await commands.answer(ReticleCommand.INSPECT, { ref: (await pad()).ref });
  const to = { x: box.x + box.width / 2 + 30, y: box.y + box.height / 2 };
  assert.equal(await gesture(ActionType.DRAG, { foreground: true, to }), 'Pad: dragged 30');
  // A hover leaves the pointer where it is. So the pointer is first put on another control: a
  // pointer that is on the pad already does not come in again.
  const save = await commands.answer(ReticleCommand.QUERY, { role: 'button', name: 'Save' });
  await commands.answer(ReticleCommand.ACT, {
    ref: save.elements[0]?.ref,
    action: ActionType.HOVER,
    args: { foreground: true, settleMs: 300 },
  });
  assert.equal(await gesture(ActionType.HOVER, { foreground: true }), 'Pad: hover');

  process.stdout.write('computer-use pointercheck: 6 of 6 cases held\n');
} finally {
  fixture.kill();
}
