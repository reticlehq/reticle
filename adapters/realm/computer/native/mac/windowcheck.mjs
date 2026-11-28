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

  // An ordinary application has a tile in the Dock: its window goes there and comes back. The
  // window that went has no ref, so it comes back from the application element, as a person
  // brings it back from the Dock. This part takes the screen for a few seconds.
  const regular = spawn(`${build}/fixture`, [tmpdir()], {
    stdio: 'ignore',
    env: { ...process.env, RETICLE_FIXTURE_RESIZABLE: '1', RETICLE_FIXTURE_REGULAR: '1' },
  });
  try {
    const onRegular = new PeerCommands({
      driver: new MacDriver({ helper: `${build}/reticle-ax`, app: 'fixture', pid: regular.pid }),
      emit: () => undefined,
    });
    await sleep(1500);
    const application = (await onRegular.answer(ReticleCommand.QUERY, { role: 'application' }))
      .elements[0]?.ref;
    await onRegular.answer(ReticleCommand.ACT, {
      ref: application,
      action: ActionType.FOCUS,
      args: { foreground: true, settleMs: 600 },
    });
    const windowRefOf = async () =>
      (await onRegular.answer(ReticleCommand.QUERY, { role: 'window' })).elements[0]?.ref;
    const gone = await onRegular.answer(ReticleCommand.ACT, {
      ref: await windowRefOf(),
      action: ActionType.WINDOW,
      args: { arrange: WindowArrangement.MINIMIZE, settleMs: 800 },
    });
    assert.equal(gone.window?.minimized, true, 'the window did not go to the Dock');
    const back = await onRegular.answer(ReticleCommand.ACT, {
      ref: application,
      action: ActionType.WINDOW,
      args: { arrange: WindowArrangement.RESTORE, settleMs: 800 },
    });
    assert.equal(back.window?.minimized, false, 'the window did not come back from the Dock');
    assert.ok(await windowRefOf(), 'the window that came back has no ref');
  } finally {
    regular.kill();
  }

  process.stdout.write('computer windowcheck: 8 of 8 cases held\n');
} finally {
  fixture.kill();
}
