// Checks the window action against the fixture: a window put on the left half and the right half
// of the screen, given an exact frame and zoomed. Each answer gives the frame of the window, and
// the check reads the window again to see that it is true. The fixture has no tile in the Dock,
// so minimize must fail and say so: the system says yes to it and does nothing. A minimize that
// works needs an ordinary application in front, which takes the screen: not in this check.
//
//   node native/mac/windowcheck.mjs
//
// Needs the Accessibility permission. Build the package first. No pointer and no keyboard.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand, WindowArrangement } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
for (const name of ['reticle-ax', 'fixture']) {
  execFileSync('swiftc', ['-O', `${here}${name}.swift`, '-o', `${build}/${name}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

const fixture = spawn(`${build}/fixture`, [tmpdir()], {
  stdio: 'ignore',
  env: { ...process.env, RETICLE_FIXTURE_RESIZABLE: '1' },
});
const commands = new PeerCommands({
  driver: new MacDriver({ helper: `${build}/reticle-ax`, app: 'fixture', pid: fixture.pid }),
  emit: () => undefined,
});

const windowRef = async () =>
  (await commands.answer(ReticleCommand.QUERY, { role: 'window' })).elements[0]?.ref;
const boxNow = async () =>
  (await commands.answer(ReticleCommand.INSPECT, { ref: await windowRef() })).box;
const arrange = async (args) =>
  commands.answer(ReticleCommand.ACT, { ref: await windowRef(), action: ActionType.WINDOW, args });
const near = (a, b) => Math.abs(a - b) <= 2;

try {
  await sleep(1500);
  const left = await arrange({ arrange: WindowArrangement.LEFT });
  const right = await arrange({ arrange: WindowArrangement.RIGHT });
  assert.ok(left.window && right.window, 'an arrangement gave no frame');
  assert.ok(near(left.window.width, right.window.width), 'the two halves are not the same width');
  assert.ok(
    near(right.window.x, left.window.x + left.window.width),
    'the halves are not side by side',
  );
  const box = await boxNow();
  assert.ok(
    near(box.x, right.window.x) && near(box.width, right.window.width),
    'the answer is not the window',
  );

  const exact = await arrange({ frame: { x: 200, y: 150, width: 520, height: 380 } });
  const { x, y, width, height } = exact.window;
  assert.deepEqual({ x, y, width, height }, { x: 200, y: 150, width: 520, height: 380 });

  const zoomed = await arrange({ arrange: WindowArrangement.ZOOM });
  assert.ok(near(zoomed.window.width, left.window.width * 2), 'zoom did not fill the width');

  // The fixture has no tile in the Dock, so macOS keeps its window on the screen. The system
  // says yes to the set all the same; the realm reads the window again and fails.
  await assert.rejects(arrange({ arrange: WindowArrangement.MINIMIZE }), /did not go to the Dock/);

  await assert.rejects(arrange({ arrange: 'sideways' }), /one of: minimize/);

  process.stdout.write('computer windowcheck: 5 of 5 cases held\n');
} finally {
  fixture.kill();
}
