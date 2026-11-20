#!/usr/bin/env node
/**
 * Runs the protocol's scenarios against the computer-use realm, with its fixture application as
 * the subject.
 *
 *   node conformance/run-computer-use.mjs [--gate] [--self-test]
 *
 * macOS only, with Accessibility permission for the terminal. It is not part of
 * `pnpm gate:conformance`: that gate runs on Linux in CI, and this needs a Mac that a person set
 * up. A small window opens for each scenario and does not take the keyboard.
 *
 * `--self-test` answers `yes` to everything. The run must then be refused, or a green run proves
 * nothing.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { nodeWorkspace } from '../adapters/realm/cli/dist/index.js';
import {
  ActKind,
  ComputerUseRealm,
  CuChannel,
  CuSummary,
  MacDriver,
} from '../adapters/realm/computer-use/dist/index.js';
import { Declaration, adjudicate, assertionsHeldUnder } from '../open-verification/dist/index.js';
import { driveAll } from './drive.mjs';
import { COMPUTER_USE_FIXTURE_SUBJECT, TITLE } from './subjects/computer-use-fixture.mjs';

const args = process.argv.slice(2);
if ('darwin' !== process.platform) {
  console.error('run-computer-use: macOS only. Nothing was run.');
  process.exit(args.includes('--gate') ? 1 : 0);
}

const native = fileURLToPath(
  new URL('../adapters/realm/computer-use/native/mac/', import.meta.url),
);
const build = `${native}build`;
mkdirSync(build, { recursive: true });
for (const name of ['reticle-ax', 'fixture']) {
  execFileSync('swiftc', ['-O', `${native}${name}.swift`, '-o', `${build}/${name}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

const FILE = 'note.txt';
const REGISTRATION = {
  name: '@reticlehq/computer-use',
  version: '3.10.7',
  platform: 'native',
  channels: [CuChannel.UI, CuChannel.FILES, CuChannel.FILES_CONTENT],
  profile: undefined,
};

function client() {
  let entry;
  let realm;
  let open;
  let fixture;
  let folder;
  let watched;
  let step = 0;
  let current;

  const press = async (name) => {
    const [handle] = await realm.locate({ name });
    step += 1;
    await realm.perform({
      id: `s${String(step)}`,
      actor: 'conformance',
      capability: ActKind.PRESS,
      target: handle.ref,
      at: Date.now(),
    });
  };
  const end = () => {
    fixture?.kill();
    for (const dir of [folder, watched]) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  };

  return {
    hello: () => Promise.resolve({ ...REGISTRATION, commands: ['plant'] }),

    async command(_name, { scenario } = {}) {
      current = scenario;
      entry = COMPUTER_USE_FIXTURE_SUBJECT[scenario];
      if (entry === undefined) return { planted: false, reason: 'this subject cannot produce it' };
      end();
      folder = mkdtempSync(join(tmpdir(), 'cu-conf-'));
      watched =
        true === entry.watchElsewhere ? mkdtempSync(join(tmpdir(), 'cu-conf-other-')) : folder;
      fixture = spawn(`${build}/fixture`, [folder], { stdio: 'ignore' });
      await sleep(1200);
      realm = new ComputerUseRealm({
        driver: new MacDriver({ helper: `${build}/reticle-ax`, app: 'fixture', pid: fixture.pid }),
        workspace: nodeWorkspace([watched], { exclude: [] }),
        now: () => Date.now(),
      });
      // Before any window: a title, so that Export writes a file with something in it.
      const [title] = await realm.locate({ name: 'Title' });
      await realm.perform({
        id: 'title',
        actor: 'conformance',
        capability: ActKind.SET,
        target: title.ref,
        parameters: { value: TITLE },
        at: Date.now(),
      });
      if (entry.warm !== undefined) {
        const warm = realm.openWindow(1500);
        for (const name of entry.warm) await press(name);
        realm.closeWindow(warm);
      }
      open = realm.openWindow(entry.budgetMs ?? 1500);
      for (const name of entry.press) await press(name);
      return { planted: true, claim: `the application wrote ${FILE}` };
    },

    async verify(claim) {
      const window = realm.closeWindow(open);
      const observed = await realm.observe(window);
      const coverage = await realm.coverage(window);
      const declared = {
        id: 'c1',
        statement: 'string' === typeof claim ? claim : `the application wrote ${FILE}`,
        declaredAt:
          true === entry.declaredAfter ? Declaration.AFTER_ACTION : Declaration.BEFORE_ACTION,
        assertions:
          true === entry.declareNothing
            ? []
            : [
                {
                  id: 'a1',
                  predicate: {
                    kind: 'present',
                    match: {
                      channel: CuChannel.FILES,
                      summary: CuSummary.FS_WRITTEN,
                      valueContains: FILE,
                    },
                  },
                  reads: `${FILE} was written in the watched folder`,
                  channels: [CuChannel.FILES],
                },
              ],
      };
      const decided = adjudicate({
        claim: declared,
        window,
        channels: realm.channels(),
        evidence: observed
          .filter((o) => o.channel === CuChannel.FILES)
          .map((o) => ({
            observation: o,
            provenance: {
              class: 'observed',
              source: REGISTRATION.name,
              method: 'file snapshot, before and after',
              subject: realm.identity(),
              at: Date.now(),
            },
            independence: 'independent',
            grade: 'consequence',
          })),
        coverage,
        anomalies: (await realm.detect?.(window, observed)) ?? [],
        assertionsHeld: assertionsHeldUnder(declared.assertions, observed, coverage),
        consequenceHeldBefore:
          'state' === entry.about
            ? realm.existedBefore(window, heldPath(realm, window))
            : undefined,
      });
      if (args.includes('--verbose')) {
        console.error(
          `  ${String(current).padEnd(34)} ${decided.verdict} / ${decided.ground} — closed by ${String(window.closedBy)}; saw ${observed.map((o) => o.summary).join(', ') || 'nothing'}`,
        );
      }
      end();
      return {
        verdict: decided.verdict,
        ground: decided.ground,
        ...(decided.reasons[0] === undefined ? {} : { reason: decided.reasons[0] }),
      };
    },
  };
}

/** The path of the file as the snapshot names it, whatever form the folder's path took. */
function heldPath(realm, window) {
  for (const candidate of [FILE, join(realpathSync(tmpdir()), FILE)]) {
    if (true === realm.existedBefore(window, candidate)) return candidate;
  }
  return FILE;
}

function dishonestIfSelfTesting(bound) {
  if (!args.includes('--self-test')) return bound;
  return {
    ...bound,
    verify: () =>
      Promise.resolve({ verdict: 'yes', ground: 'proved', reason: 'self-test: always yes' }),
  };
}

const report = await driveAll(dishonestIfSelfTesting(client()), REGISTRATION);
for (const [id, outcome] of Object.entries(report.outcomes ?? {})) {
  console.error(`${String(outcome).padEnd(11)} ${id}`);
}
const failed = report.failed ?? [];
const count = (kind) => Object.values(report.outcomes ?? {}).filter((o) => kind === o).length;
console.error(
  `\n${String(count('passed'))} passed, ${String(failed.length)} failed, ${String(count('absent'))} absent`,
);

if (args.includes('--self-test')) {
  const refused = failed.length > 0;
  console.error(
    refused
      ? `\nself-test: the gate refused a run that answered yes to everything (${String(failed.length)} caught)`
      : '\nself-test FAILED: a run that answered yes to everything was accepted',
  );
  process.exit(refused ? 0 : 1);
}
if (args.includes('--gate') && failed.length > 0) {
  console.error(`\nFAILED: ${failed.join(', ')}`);
  process.exit(1);
}
