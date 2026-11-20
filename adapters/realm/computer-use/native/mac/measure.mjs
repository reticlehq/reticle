#!/usr/bin/env node
// Measures the realm on the fixture application and prints the times. It asserts nothing: a time
// is true only for the machine and the moment it was taken on. Use it to compare two builds on
// one machine, and to give a number its source.
//
//   node native/mac/measure.mjs [rounds]      (macOS, with Accessibility permission)
//
// A small window opens. It does not take the keyboard.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ActKind, ComputerUseRealm, MacDriver } from '../../dist/index.js';

const rounds = Number(process.argv[2] ?? 10);
const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
for (const name of ['reticle-ax', 'fixture']) {
  execFileSync('swiftc', ['-O', `${here}${name}.swift`, '-o', `${build}/${name}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

const fixture = spawn(`${build}/fixture`, ['/tmp'], { stdio: 'ignore' });
const driver = new MacDriver({ helper: `${build}/reticle-ax`, app: 'fixture', pid: fixture.pid });
const realm = new ComputerUseRealm({ driver, now: () => Date.now() });

const times = {};
async function timed(label, work) {
  const started = performance.now();
  const result = await work();
  (times[label] ??= []).push(performance.now() - started);
  return result;
}
const middle = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const worst = (list) => Math.max(...list);

let action = 0;
async function press(name) {
  const window = realm.openWindow(1500);
  const [handle] = await realm.locate({ name });
  action += 1;
  await realm.perform({
    id: `m${String(action)}`,
    actor: 'measure',
    capability: ActKind.PRESS,
    target: handle.ref,
    at: Date.now(),
  });
  return realm.observe(realm.closeWindow(window));
}

try {
  await sleep(1500);
  await realm.describe();
  for (let round = 0; round < rounds; round += 1) {
    await timed('read the window', () => realm.describe());
    await timed('find one element by name', () => realm.locate({ name: 'Save' }));
    // Two buttons that each write a different status text, so every press here has an effect.
    // The same button twice has none the second time, and the time is then the whole budget.
    await timed('press with an effect', () => press('Fake'));
    await timed('press with an effect', () => press('Save'));
    await timed('press with no effect', () => press('Dead'));
    await timed('refuse a covered control', () => press('Covered'));
  }
  process.stdout.write(`${String(rounds)} rounds on the fixture application\n`);
  for (const [label, list] of Object.entries(times)) {
    process.stdout.write(
      `  ${label.padEnd(28)} middle ${middle(list).toFixed(0).padStart(5)} ms   worst ${worst(list).toFixed(0).padStart(5)} ms\n`,
    );
  }
} finally {
  fixture.kill();
}
