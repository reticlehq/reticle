// Checks what the person at the machine sees: the window of the realm shows the action and its
// effect, and Pause in that window stops the realm. The check presses Pause the way a person
// does: a second realm reads the window and presses its button.
//
//   node native/mac/hudcheck.mjs
//
// Needs the Accessibility permission. Build the package first.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands, macHud } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
for (const [name, to] of [
  ['reticle-ax', 'reticle-ax'],
  ['fixture', 'fixture'],
  ['hud', 'reticle-hud'],
]) {
  execFileSync('swiftc', ['-O', `${here}${name}.swift`, '-o', `${build}/${to}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

// Only this check may read the window of Reticle: it presses Pause as a person does.
process.env.RETICLE_AX_CHECKS_ITS_OWN_WINDOW = '1';
const helper = `${build}/reticle-ax`;
const fixture = spawn(`${build}/fixture`, [tmpdir()], { stdio: 'ignore' });
const hud = macHud(`${build}/reticle-hud`);
const commands = new PeerCommands({
  driver: new MacDriver({ helper, app: 'fixture', pid: fixture.pid }),
  emit: () => undefined,
  hud,
});

async function press(peer, name) {
  const found = await peer.answer(ReticleCommand.QUERY, { role: 'button', name });
  assert.ok(found.elements[0], `no button named ${name}`);
  return peer.answer(ReticleCommand.ACT, {
    ref: found.elements[0].ref,
    action: ActionType.CLICK,
    args: { settleMs: 500 },
  });
}

try {
  await sleep(1500);
  await press(commands, 'Save');

  const hudPid = Number(execFileSync('pgrep', ['-n', '-f', 'build/reticle-hud']).toString().trim());
  const onHud = new PeerCommands({
    driver: new MacDriver({ helper, app: 'reticle-hud', pid: hudPid }),
    emit: () => undefined,
  });
  const window = (await onHud.answer(ReticleCommand.SNAPSHOT, {})).tree;
  // The action is shown with its quotes, and the tree writes a quote in a name with a mark
  // before it. So the words are looked for without the quotes.
  for (const words of ['text "fixture"', 'press button', '2 change(s)']) {
    assert.ok(window.includes(words), `the window does not show: ${words}`);
  }

  await press(onHud, 'Pause');
  await sleep(400);
  await assert.rejects(press(commands, 'Slow'), /paused Reticle/);
  await press(onHud, 'Resume');
  await sleep(400);
  const after = await press(commands, 'Slow');
  assert.ok(after.effect.domMutatedWithin > 0, 'the realm did not act after Resume');
  const status = (await commands.answer(ReticleCommand.QUERY, { role: 'text' })).elements[0]?.name;
  assert.equal(status, 'Slow done');

  process.stdout.write('computer-use hudcheck: 4 of 4 cases held\n');
} finally {
  hud.close();
  fixture.kill();
}
