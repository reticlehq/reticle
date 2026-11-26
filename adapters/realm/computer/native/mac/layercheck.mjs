// Checks the reach test against a page of Chromium with layers, in the Electron fixture:
//   - an empty layer over the whole window, that clicks pass through (Discord has one for its
//     popups), does not cover a button: the button is pressed, and the press has its effect;
//   - the backdrop of an open dialog covers a button behind it: the press is refused;
//   - the button in the dialog is pressed;
//   - the backdrop of a popup with no mark of a dialog covers a button behind it too.
// Chromium answers a hit test with the empty layer, so the realm refused every button of Discord.
//
//   node native/mac/layercheck.mjs
//
// Needs the Accessibility permission. Build the package first.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActionType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
execFileSync('swiftc', ['-O', `${here}reticle-ax.swift`, '-o', `${build}/reticle-ax`], {
  stdio: ['ignore', 'ignore', 'ignore'],
});

let electron;
try {
  const fixture = fileURLToPath(new URL('../../../../../apps/electron-smoke/', import.meta.url));
  electron = createRequire(`${fixture}package.json`)('electron');
} catch {
  process.stdout.write('computer layercheck: skipped, Electron is not installed\n');
  process.exit(0);
}

const data = mkdtempSync(join(tmpdir(), 'reticle-cu-layers-'));
const app = spawn(electron, [`${here}electron-fixture/main.mjs`, `--user-data-dir=${data}`], {
  stdio: 'ignore',
  env: { ...process.env, RETICLE_FIXTURE_PAGE: 'layers' },
});
const helper = `${build}/reticle-ax`;
const commands = new PeerCommands({
  driver: new MacDriver({ helper, app: 'Electron', pid: app.pid }),
  emit: () => undefined,
});

async function press(name) {
  const found = await commands.answer(ReticleCommand.QUERY, { role: 'button', name });
  const ref = found.elements[0]?.ref;
  assert.ok(ref, `no button named ${name}`);
  return commands.answer(ReticleCommand.ACT, {
    ref,
    action: ActionType.CLICK,
    args: { settleMs: 800 },
  });
}
const texts = async () =>
  (await commands.answer(ReticleCommand.QUERY, { role: 'text' })).elements.map((e) => e.name);

try {
  await sleep(4000);
  execFileSync(helper, ['web-tree', String(app.pid), 'on']);
  await sleep(500);

  await press('Go');
  assert.ok(
    (await texts()).includes('1 clicks'),
    'the button under the empty layer was not pressed',
  );

  // A popup that is not marked as a dialog: only its place after the backdrop says it is in front.
  await press('Open menu');
  await sleep(300);
  await assert.rejects(
    press('Go'),
    /cannot reach/,
    'a button behind an unmarked popup was pressed',
  );
  assert.ok(!(await texts()).includes('2 clicks'), 'the button behind the popup was pressed');
  await press('Keep');
  assert.ok((await texts()).includes('kept'), 'the button in the unmarked popup was not pressed');

  await press('Open dialog');
  await sleep(300);
  await assert.rejects(press('Go'), /cannot reach/, 'a button behind the backdrop was pressed');
  assert.ok(!(await texts()).includes('2 clicks'), 'the button behind the backdrop was pressed');

  await press('Done');
  assert.ok((await texts()).includes('dialog done'), 'the button in the dialog was not pressed');

  process.stdout.write('computer layercheck: 5 of 5 cases held\n');
} finally {
  app.kill();
  await sleep(500);
  rmSync(data, { recursive: true, force: true });
}
