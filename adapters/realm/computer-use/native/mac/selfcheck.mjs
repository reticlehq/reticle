#!/usr/bin/env node
// Drives the fixture application through the realm and checks what it must never get wrong:
//   an effect is reported; a late effect is waited for; an action that does nothing is reported
//   as nothing; a control a person cannot reach is refused; an element that moved is refused;
//   and a claim gets a `yes` only when the file system agrees, whatever the application says.
//
//   node native/mac/selfcheck.mjs      (macOS, with Accessibility permission for the terminal)
//
// A small window opens for a few seconds. It does not take the keyboard.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { nodeWorkspace } from '@reticlehq/cli-realm';
import { Declaration, adjudicate, assertionsHeldUnder } from 'open-verification';

import {
  ActKind,
  ComputerUseRealm,
  CuChannel,
  CuSummary,
  Delivery,
  MacDriver,
} from '../../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = `${here}build`;
mkdirSync(build, { recursive: true });
for (const name of ['reticle-ax', 'fixture']) {
  execFileSync('swiftc', ['-O', `${here}${name}.swift`, '-o', `${build}/${name}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

const folder = mkdtempSync(join(tmpdir(), 'reticle-cu-'));
const fixture = spawn(`${build}/fixture`, [folder], { stdio: 'ignore' });
const helper = `${build}/reticle-ax`;
const realm = new ComputerUseRealm({
  driver: new MacDriver({ helper, app: 'fixture', pid: fixture.pid }),
  workspace: nodeWorkspace([folder], { exclude: [] }),
  now: () => Date.now(),
});

const report = [];
let actionSeq = 0;

/** One action in its own window: what the realm answered, saw and could not see. */
async function step(name, kind, parameters = {}) {
  const started = Date.now();
  const window = realm.openWindow(1000);
  const [handle] = await realm.locate({ name });
  assert.ok(handle, `no element named ${name}`);
  actionSeq += 1;
  const receipt = await realm.perform({
    id: `a${String(actionSeq)}`,
    actor: 'selfcheck',
    capability: kind,
    target: handle.ref,
    parameters,
    at: Date.now(),
  });
  const closed = realm.closeWindow(window);
  const observed = await realm.observe(closed);
  const coverage = await realm.coverage(closed);
  const ms = Date.now() - started;
  const summaries = observed.map((o) => o.summary);
  report.push(
    `${name.padEnd(8)} ${String(ms).padStart(5)} ms  ${summaries.join(', ') || receipt.refused?.detail}  [closed by ${closed.closedBy}]`,
  );
  return { receipt, closed, observed, coverage, summaries };
}

const noteWritten = {
  id: 'c1',
  statement: 'the note is saved to a file',
  declaredAt: Declaration.BEFORE_ACTION,
  assertions: [
    {
      id: 'a1',
      predicate: {
        kind: 'present',
        match: {
          channel: CuChannel.FILES,
          summary: CuSummary.FS_WRITTEN,
          valueContains: 'note.txt',
        },
      },
      reads: 'note.txt was written',
      channels: [CuChannel.FILES],
    },
  ],
};

/** The verdict on the claim, from what the realm saw in one step. No model is asked. */
function judge({ closed, observed, coverage }) {
  return adjudicate({
    claim: noteWritten,
    window: closed,
    channels: realm.channels(),
    evidence: observed
      .filter((o) => o.channel === CuChannel.FILES)
      .map((o) => ({
        observation: o,
        provenance: {
          class: 'observed',
          source: '@reticlehq/computer-use',
          method: 'file snapshot, before and after',
          subject: realm.identity(),
          at: Date.now(),
        },
        independence: 'independent',
        grade: 'consequence',
      })),
    coverage,
    anomalies: [],
    assertionsHeld: assertionsHeldUnder(noteWritten.assertions, observed, coverage),
    consequenceHeldBefore: undefined,
  });
}

try {
  await sleep(1500);
  assert.equal((await realm.describe()).unread, 0);

  const typed = await step('Title', ActKind.SET, { value: 'Plan' });
  assert.deepEqual(typed.summaries, [CuSummary.UI_CHANGED]);

  // Key events, not a value put in the field: the Return key runs the field's own action.
  const keyed = await step('Title', ActKind.TYPE, { value: ' B' });
  assert.deepEqual(keyed.summaries, [CuSummary.UI_CHANGED]);
  const entered = await step('Title', ActKind.KEY, { value: 'Return' });
  assert.deepEqual(entered.summaries, [CuSummary.UI_GONE, CuSummary.UI_APPEARED]);
  assert.equal(entered.observed[1].value.element, 'text "Entered: Plan B"');

  // A slider takes a number. The same path moves a scroll bar, which is how this realm scrolls.
  const slid = await step('Volume', ActKind.SET, { value: '0.5' });
  // Two elements change: the slider, and the mark on it that shows the value.
  assert.deepEqual(slid.summaries, [CuSummary.UI_CHANGED, CuSummary.UI_CHANGED]);

  const saved = await step('Save', ActKind.PRESS);
  assert.deepEqual(saved.summaries, [CuSummary.UI_GONE, CuSummary.UI_APPEARED]);

  const slow = await step('Slow', ActKind.PRESS);
  assert.deepEqual(slow.summaries, [CuSummary.UI_GONE, CuSummary.UI_APPEARED]);

  const dead = await step('Dead', ActKind.PRESS);
  assert.deepEqual(dead.summaries, [CuSummary.UI_NO_EFFECT]);

  const blocked = await step('Covered', ActKind.PRESS);
  assert.equal(blocked.receipt.dispatched, false);
  const covered = await step('Covered', ActKind.PRESS, { delivery: Delivery.DIRECT });
  assert.ok(covered.summaries.includes(CuSummary.ACT_NOT_REACHABLE));

  const stale = JSON.parse(
    execFileSync(helper, ['act', String(fixture.pid), '0.2', 'AXButton', 'Dead', 'press'], {
      encoding: 'utf8',
    }),
  );
  assert.equal(stale.refused, 'stale');

  // The application says "Exported" both times. Only one of them wrote the file.
  const fake = await step('Fake', ActKind.PRESS);
  assert.ok(fake.summaries.includes(CuSummary.UI_APPEARED), 'the false success shows in the tree');
  const lied = judge(fake);
  assert.notEqual(lied.verdict, 'yes');

  const exported = await step('Export', ActKind.PRESS);
  const proved = judge(exported);
  assert.equal(
    proved.verdict,
    'yes',
    `Export: ${proved.ground}; closed by ${exported.closed.closedBy}; saw ${exported.summaries.join(', ')}`,
  );

  report.push(
    `Fake   -> verdict ${lied.verdict} (${lied.ground})`,
    `Export -> verdict ${proved.verdict} (${proved.ground})`,
    'computer-use selfcheck: 12 of 12 cases held',
    '',
  );
  process.stdout.write(report.join('\n'));
} catch (error) {
  // What each step saw up to the failure: the first thing to read when this check is not steady.
  process.stderr.write(`${report.join('\n')}\n`);
  throw error;
} finally {
  fixture.kill();
  rmSync(folder, { recursive: true, force: true });
}
