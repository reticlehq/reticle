// Checks real keys: an application that was opened in the background is brought to the front,
// and the keys of a real keyboard go to it. A real key goes to whatever application has the
// keyboard, so the realm sends one only when the system says that the joined application has
// it. (That refusal is in the unit tests: this fixture always takes the keyboard when asked.)
//
//   node native/mac/keyscheck.mjs
//
// IT TAKES THE KEYBOARD for a few seconds: the fixture comes to the front, and the application
// that was in front gets the keyboard back when the fixture closes. Do not type while it runs.
// Needs the Accessibility permission. Build the package first.
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

const helper = `${build}/reticle-ax`;
const answerOf = (peer, name, args) => peer.answer(name, args);
const titleOf = async (peer) =>
  (await answerOf(peer, ReticleCommand.QUERY, { role: 'textbox', name: 'Title' })).elements[0];
const act = (peer, ref, action, args) =>
  answerOf(peer, ReticleCommand.ACT, { ref, action, args: { settleMs: 1000, ...args } });

// An ordinary application, opened in the background: it can come to the front.
const regular = spawn(`${build}/fixture`, [tmpdir()], {
  stdio: 'ignore',
  env: { ...process.env, RETICLE_FIXTURE_REGULAR: '1' },
});
const peerOf = (pid) =>
  new PeerCommands({
    driver: new MacDriver({ helper, app: 'fixture', pid }),
    emit: () => undefined,
  });

try {
  await sleep(1800);
  // Opened in the background and never in front: the system gives no window of it.
  const onRegular = peerOf(regular.pid);
  const closed = await answerOf(onRegular, ReticleCommand.SNAPSHOT, {});
  assert.equal(closed.windows, 0);
  await act(onRegular, 'e1', ActionType.FOCUS, { foreground: true });
  await sleep(600);
  const open = await answerOf(onRegular, ReticleCommand.SNAPSHOT, {});
  assert.equal(open.windows, 1, 'the application did not come to the front');

  const title = await titleOf(onRegular);
  await act(onRegular, title.ref, ActionType.TYPE, { text: 'Plan', foreground: true });
  assert.equal((await titleOf(onRegular)).value, 'Plan');
  await act(onRegular, title.ref, ActionType.PRESS, { text: 'Return', foreground: true });
  const status = (await answerOf(onRegular, ReticleCommand.QUERY, { role: 'text' })).elements;
  assert.ok(
    status.some((element) => 'Entered: Plan' === element.name),
    'the Return key did not reach the field',
  );

  process.stdout.write('computer-use keyscheck: 4 of 4 cases held\n');
} finally {
  regular.kill();
}
