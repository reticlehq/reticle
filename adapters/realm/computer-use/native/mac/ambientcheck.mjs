// Checks, against the fixture with its clock on, that the peer does not report what the
// application changes by itself as the effect of an action.
//
//   node native/mac/ambientcheck.mjs
//
// Needs the Accessibility permission, as selfcheck.mjs does. Build the package first.
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

const fixture = spawn(`${build}/fixture`, [tmpdir(), 'clock'], { stdio: 'ignore' });
const commands = new PeerCommands({
  driver: new MacDriver({ helper: `${build}/reticle-ax`, app: 'fixture', pid: fixture.pid }),
  emit: () => undefined,
});

async function press(name) {
  const found = await commands.answer(ReticleCommand.QUERY, { role: 'button', name });
  const ref = found.elements[0]?.ref;
  assert.ok(ref, `no button named ${name}`);
  const result = await commands.answer(ReticleCommand.ACT, { ref, action: ActionType.CLICK });
  return result.effect;
}

try {
  await sleep(1500);
  // Before the peer watched: it cannot know, so the clock counts as an effect of a dead button.
  const before = await press('Dead');
  assert.ok(before.domMutatedWithin > 0, 'the clock was not seen at all');

  // The peer looks while nothing acts, as its timer does.
  for (let look = 0; look < 6; look += 1) {
    await commands.sendTreeChanges();
    await sleep(600);
  }

  const dead = await press('Dead');
  assert.equal(dead.domMutatedWithin, 0, 'a dead button was given the clock as its effect');
  assert.ok(dead.changedByItself > 0, 'the answer did not say that the clock changed');

  const save = await press('Save');
  assert.ok(save.domMutatedWithin > 0, 'the real effect of Save was lost next to the clock');
  // The words, and not only a count: a count can come from a change that Save did not make.
  const shown = await commands.answer(ReticleCommand.QUERY, { role: 'text' });
  assert.ok(
    shown.elements.some((element) => element.name.startsWith('Saved:')),
    'Save did not change the status',
  );

  process.stdout.write(
    `computer-use ambientcheck: held (before ${String(before.domMutatedWithin)}, dead 0 + ${String(dead.changedByItself)} by itself, save ${String(save.domMutatedWithin)})\n`,
  );
} finally {
  fixture.kill();
}
