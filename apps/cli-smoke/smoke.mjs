#!/usr/bin/env node
// A tool that can be put into each behaviour the conformance suite asks for.
//
//   node smoke.mjs --scenario <id> --out <dir>
//
// Every scenario is reachable by an argument and nothing happens unless one is given. The
// behaviours come from the suite rather than from our detectors: a fixture whose only defect is
// one we already look for proves that we can find what we went looking for, and nothing else.

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const scenario = flag('--scenario');
const out = flag('--out') ?? process.cwd();

/** The ordinary, correct behaviour: write what you said you would write, and say so. */
function healthy() {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'built.txt'), `built at ${String(Date.now())}\n`);
  process.stdout.write('built 1 file\n');
}

const SCENARIOS = {
  /**
   * The negative control, and the reason the rest of the list means anything.
   *
   * Almost every scenario asks for something OTHER than a confident yes, so an implementation
   * answering "I could not tell" to everything satisfies nearly all of them. This one must
   * produce `yes`.
   */
  healthy,

  /**
   * The same command twice. The second run is the scenario.
   *
   * `built.txt` is already there, so a claim that it exists was true before the action and the
   * action proves nothing about it. Reachable here and on no other subject in the suite.
   */
  'already-true': healthy,

  /**
   * The effect lands somewhere nobody is watching.
   *
   * Writes outside the declared roots, into the system temp directory. The file is really
   * written and the verifier really cannot see it, which is the distinction between "it did not
   * happen" and "nothing was watching" that this scenario exists to keep apart.
   */
  elsewhere() {
    const away = join(tmpdir(), `cli-smoke-elsewhere-${String(process.pid)}`);
    mkdirSync(away, { recursive: true });
    writeFileSync(join(away, 'hidden.txt'), 'written where nobody is looking\n');
    process.stdout.write('built 1 file\n');
  },

  /**
   * Something was sent and nothing can observe whether it ran.
   *
   * A detached child, unreferenced, doing its work after the parent has gone. The parent exits 0
   * with nothing to show for itself.
   */
  'fire-and-forget'() {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    process.stdout.write('dispatched\n');
  },

  /**
   * The tool announces success and the operating system ends it.
   *
   * The kill is imposed rather than chosen, so it arrives on an INDEPENDENT channel, and a
   * disagreement with the tool's own output is entitled to convict. On one merged exit channel
   * this would be two actuation-derived channels disagreeing, which may never force a `no`.
   */
  'claimed-over-failure'() {
    process.stdout.write('✓ completed successfully\n');
    process.kill(process.pid, 'SIGKILL');
  },

  /** Runs longer than any budget it will be given. The verifier gives up; the subject does not. */
  'over-budget'() {
    process.stdout.write('working\n');
    setInterval(() => {}, 1000);
  },

  /**
   * The thing being watched goes away before the window closes.
   *
   * Removes the WORKSPACE, not just the output directory, and the difference is the whole
   * scenario: a verifier watching a root that has vanished has lost its vantage point, and must
   * report that rather than reporting an empty window as "nothing happened". Deleting only the
   * output would leave the root readable and prove nothing about the case.
   */
  'subject-disappears'() {
    process.stdout.write('cleaning\n');
    rmSync(join(out, '..'), { recursive: true, force: true });
  },

  /** Does nothing at all, quietly, and exits 0. */
  'no-effect'() {
    process.exit(0);
  },
};

const run = SCENARIOS[scenario];
if (run === undefined) {
  process.stderr.write(`unknown scenario: ${String(scenario)}\n`);
  process.exit(2);
}
run();
