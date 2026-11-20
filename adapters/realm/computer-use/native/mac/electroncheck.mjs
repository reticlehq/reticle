// Checks the realm against a small Electron application, through the peer:
//   - with the accessibility switch off, a press does nothing, and the answer says why;
//   - with the switch on, a press works;
//   - a slow effect belongs to its own press, and the next press does not get it.
//
//   node native/mac/electroncheck.mjs
//
// Needs the Accessibility permission, and Electron as the repository's Electron fixture has it.
// Build the package first.
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
  process.stdout.write('computer-use electroncheck: skipped, Electron is not installed\n');
  process.exit(0);
}

const NOTE = 'the switch is off';
// The data of the application goes to a folder of this run, not to the home folder.
const data = mkdtempSync(join(tmpdir(), 'reticle-cu-electron-'));
const app = spawn(electron, [`${here}electron-fixture/main.mjs`, `--user-data-dir=${data}`], {
  stdio: 'ignore',
});
const helper = `${build}/reticle-ax`;
const commands = new PeerCommands({
  driver: new MacDriver({ helper, app: 'Electron', pid: app.pid }),
  emit: () => undefined,
  noEffectNote: NOTE,
});

async function act(role, name, action, args) {
  const found = await commands.answer(ReticleCommand.QUERY, { role, name });
  const ref = found.elements[0]?.ref;
  assert.ok(ref, `no ${role} named ${name}`);
  const result = await commands.answer(ReticleCommand.ACT, { ref, action, args });
  return result.effect;
}
const press = (name) => act('button', name, ActionType.CLICK, { settleMs: 1200 });

try {
  await sleep(4000);
  const off = await press('Add');
  assert.equal(off.domMutatedWithin, 0, 'a press did something with the switch off');
  assert.equal(off.note, NOTE, 'a press with no effect did not say why');

  execFileSync(helper, ['web-tree', String(app.pid), 'on']);
  await sleep(1000);
  const filled = await act('textbox', 'New note', ActionType.FILL, { value: 'Buy milk' });
  assert.equal(filled.valueChanged, true, 'the field did not take the value');
  const added = await press('Add');
  assert.ok(added.domMutatedWithin > 0, 'a press did nothing with the switch on');
  assert.equal(added.note, undefined);

  const slow = await press('Slow');
  assert.ok(slow.domMutatedWithin > 0, 'a slow effect was not given to its own press');
  const dead = await press('Dead');
  assert.equal(dead.domMutatedWithin, 0, 'a dead button was given the effect of another press');

  process.stdout.write('computer-use electroncheck: 5 of 5 cases held\n');
} finally {
  app.kill();
  await sleep(500);
  rmSync(data, { recursive: true, force: true });
}
