// Checks the save panel of the system, which most applications use to write a file. The panel
// is drawn by another process than the application. The realm reads it, fills the name and
// presses its Save, all in the background, and the proof is the file on disk.
//
//   node native/mac/savepanelcheck.mjs
//
// Needs the Accessibility permission. Build the package first.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { nodeWorkspace } from '@reticlehq/cli-realm';
import { ActionType, EventType, ReticleCommand } from '@reticlehq/core';

import { MacDriver, PeerCommands } from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
for (const name of ['reticle-ax', 'fixture']) {
  execFileSync('swiftc', ['-O', `${here}${name}.swift`, '-o', `${build}/${name}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

// The panel opens in this folder: the fixture gives it to the panel.
const folder = mkdtempSync(join(tmpdir(), 'reticle-cu-save-'));
const fixture = spawn(`${build}/fixture`, [folder], { stdio: 'ignore' });
const signals = [];
const commands = new PeerCommands({
  driver: new MacDriver({ helper: `${build}/reticle-ax`, app: 'fixture', pid: fixture.pid }),
  workspace: nodeWorkspace([folder], { exclude: [] }),
  emit: (type, data) => {
    if (EventType.SIGNAL === type) {
      signals.push(`${String(data.name)} ${String(data.data?.file ?? '')}`.trim());
    }
  },
});
const act = (ref, action, args) =>
  commands.answer(ReticleCommand.ACT, { ref, action, args: { settleMs: 2000, ...args } });
const find = async (query) => (await commands.answer(ReticleCommand.QUERY, query)).elements;

try {
  await sleep(1500);
  await act((await find({ role: 'textbox', name: 'Title' }))[0].ref, ActionType.FILL, {
    value: 'Plan',
  });
  await act((await find({ role: 'button', name: 'SaveAs' }))[0].ref, ActionType.CLICK);
  await sleep(1000);

  // The field for the name has an identifier that the system gave it. It is found by that.
  const [name] = await find({ by: 'testid', value: 'saveAsNameTextField' });
  assert.ok(name, 'the save panel was not read');
  await act(name.ref, ActionType.FILL, { value: 'from-reticle.txt' });

  // Two buttons are named Save: the one of the application, which the panel now covers, and
  // the one of the panel.
  const saves = await find({ role: 'button', name: 'Save' });
  assert.equal(saves.length, 2);
  await assert.rejects(act(saves[0].ref, ActionType.CLICK), /a person cannot reach/);
  await act(saves[1].ref, ActionType.CLICK);
  await sleep(600);

  assert.equal(readFileSync(join(folder, 'from-reticle.txt'), 'utf8'), 'Plan');
  assert.ok(signals.includes('file.written from-reticle.txt'), `signals: ${signals.join(', ')}`);
  process.stdout.write('computer savepanelcheck: 4 of 4 cases held\n');
} finally {
  fixture.kill();
  spawn('defaults', ['delete', 'fixture'], { stdio: 'ignore' });
  rmSync(folder, { recursive: true, force: true });
}
