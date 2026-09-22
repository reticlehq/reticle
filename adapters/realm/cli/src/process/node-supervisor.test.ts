import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSupervisor } from './node-supervisor.js';

/**
 * The half that talks to the operating system, tested against real processes.
 *
 * `CliRealm` is tested with a fake because the interesting cases are hard to arrange on demand.
 * This one is the opposite: its whole job is the arranging, so faking anything here would test the
 * fake. Every case below runs a real process.
 */
const supervisor = (): NodeSupervisor =>
  new NodeSupervisor({
    executable: process.execPath,
    workspaceRoot: process.cwd(),
    tool: { id: 'node', version: process.version, workspace: 'test-ws' },
    now: () => Date.now(),
  });

describe('running a real process', () => {
  it('captures each stream separately, in the order that stream produced it', async () => {
    const run = await supervisor().run(
      'say',
      [
        '-e',
        // Written to the streams directly rather than through the console, because the subject
        // here is the PIPES: what arrives, on which stream, in what order. The console adds
        // formatting between the program and the bytes this test is about.
        'process.stdout.write("one\\ntwo\\n"); process.stderr.write("bad\\n")',
      ],
      10_000,
    );
    expect(run.stdout.map((l) => l.text)).toEqual(['one', 'two']);
    expect(run.stdout.map((l) => l.seq)).toEqual([0, 1]);
    expect(run.stderr.map((l) => l.text)).toEqual(['bad']);
  });

  it('reports a chosen exit code as chosen, not as a signal', async () => {
    const run = await supervisor().run('fail', ['-e', 'process.exit(3)'], 10_000);
    expect(run.exit?.code).toBe(3);
    expect(run.exit?.wasSignalled).toBe(false);
  });

  /**
   * A kill is the operating system's decision, and it must not be reported as the tool's.
   *
   * This is the case the `x-proc` channel exists for. If it arrived as an exit code, a realm would
   * have to file a kernel decision on the channel that carries the tool's own self-report, and a
   * crash would become indistinguishable from a tool choosing to fail.
   */
  /*
   * Windows has no signals, and pretending otherwise would be the lie this file exists to prevent.
   *
   * `process.kill(pid, 'SIGKILL')` there is TerminateProcess: the OS reports an exit CODE and no
   * signal, so `wasSignalled` is false. That is not a defect in the supervisor -- it reports what
   * the platform tells it -- it is a real limit on what the CLI realm can know on Windows, and a
   * killed subject is indistinguishable from one that chose to exit.
   *
   * Asserted per-platform rather than skipped, so the limit is pinned: anyone who later makes
   * Windows claim `wasSignalled: true` has to delete a test that says why it must not.
   */
  it('reports a kill as imposed from outside, with no exit code to mistake it for one', async () => {
    const run = await supervisor().run(
      'hang',
      ['-e', 'process.kill(process.pid, "SIGKILL")'],
      10_000,
    );
    if ('win32' === process.platform) {
      expect(run.exit?.wasSignalled).toBe(false);
      expect(run.exit?.signal).toBeUndefined();
      return;
    }
    expect(run.exit?.wasSignalled).toBe(true);
    expect(run.exit?.signal).toBe('SIGKILL');
    expect(run.exit?.code).toBeUndefined();
  });

  /**
   * Our own impatience must be legible as ours.
   *
   * The process is still running when the budget ends, so there is no exit at all. The realm reads
   * that absence as `budget-exhausted`, which blames the verifier rather than the subject, and is
   * the honest answer. Reporting `terminated` here would be true of the process and false about
   * WHO ended it.
   */
  it('leaves no exit status when the budget ran out, because the subject did not end', async () => {
    const run = await supervisor().run('forever', ['-e', 'setInterval(() => {}, 1000)'], 250);
    expect(run.exit).toBeUndefined();
    expect(run.endedAt).toBeUndefined();
  });

  /**
   * stdin is closed unless somebody asked for it.
   *
   * An inherited or open stdin hangs a tool that reads it to the budget, and a hang is
   * indistinguishable from a real one. Measured elsewhere: an AI coding CLI pays a three-second
   * tax waiting for input that never arrives.
   */
  it('does not hang on a tool that reads stdin', async () => {
    const run = await supervisor().run(
      'reads',
      ['-e', 'process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(0));'],
      5_000,
    );
    expect(run.exit?.code).toBe(0);
  });

  it('reports a tool it cannot run as a failure to reach it, rather than as a verdict', async () => {
    const s = new NodeSupervisor({
      executable: '/definitely/not/here',
      workspaceRoot: process.cwd(),
      tool: { id: 'ghost', version: '0', workspace: 'ws' },
      now: () => Date.now(),
    });
    await expect(s.run('x', [], 5_000)).rejects.toThrow();
  });
});

describe('an effect that lands after the process returns', () => {
  /**
   * A tool that forks and returns immediately, whose real work outlives it.
   *
   * Measured while planning this: a detached child leaves the artifact absent at the moment the
   * parent exits and present a second and a half later. Without a settle pass the realm sees an
   * exit 0 over an empty filesystem and reports a tool that worked as one that did nothing --
   * and clause 3 runs before the coverage check, so an `observed`-tier anomaly would convict it
   * before `still-in-flight` was ever consulted.
   *
   * The wait belongs HERE rather than in the realm, because this is the half that knows when the
   * process ended. The realm stays synchronous and simply finds the disk already settled.
   */
  it('waits after exit, so a deferred write is on disk before the run is reported', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reticle-settle-'));
    const target = join(root, 'late.txt');
    // The grandchild announces itself here, and the child does not exit until it appears. Kept as
    // evidence too: if this is absent on a failure, the grandchild never ran at all, which is a
    // different fault from a write that landed late.
    const spawned = join(root, 'ready.txt');
    const s = new NodeSupervisor({
      executable: process.execPath,
      workspaceRoot: root,
      tool: { id: 'node', version: process.version, workspace: 'ws' },
      now: () => Date.now(),
      /*
       * The window now has to cover ONE thing: a 150ms timer and a small write.
       *
       * It used to have to cover interpreter start-up as well, because the child spawned a second
       * `node` and exited immediately -- so the test raced Windows' process launch and lost, first
       * at 400ms and again at 3000. Raising the number was treating a race as a budget. The child
       * now waits until the grandchild is alive before exiting, which takes start-up out of the
       * window entirely; what remains is bounded by the timer the test itself sets.
       *
       * The deferred write still lands strictly AFTER the subject exits, which is the whole claim.
       */
      settleMs: 3_000,
    });
    const run = await s.run(
      'fork',
      [
        '-e',
        `const { spawn } = require('node:child_process');
         const fs = require('node:fs');
         const ready = ${JSON.stringify(spawned)};
         const c = spawn(process.execPath, ['-e', 'const fs = require("node:fs"); fs.writeFileSync(' + JSON.stringify(ready) + ', "up"); setTimeout(() => fs.writeFileSync(' + JSON.stringify(${JSON.stringify(target)}) + ', "late"), 150);'], { detached: true, stdio: 'ignore' });
         c.unref();
         // Do not exit until the grandchild is actually up, so the settle window bounds the
         // TIMER rather than this platform's process start-up.
         const deadline = Date.now() + 20000;
         const idle = new Int32Array(new SharedArrayBuffer(4));
         while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(idle, 0, 0, 10);`,
      ],
      10_000,
    );
    expect(
      existsSync(target),
      `deferred write not observed. child spawned a grandchild: ${String(existsSync(spawned))}; ` +
        `settledMs=${String(run.settledMs)}; dir now: [${readdirSync(root).join(', ')}]`,
    ).toBe(true);
    expect(run.settledMs).toBe(3_000);
    rmSync(root, { recursive: true, force: true });
  });

  /*
   * The bound, not the duration.
   *
   * This timed the call and asserted `Date.now() - started < 3_000`, with a comment calling it a
   * generous ceiling. CLAUDE.md names that shape as a bug outright -- it is a statement about the
   * machine and fails only under parallel load, i.e. only in CI -- and the comment defending it
   * was the tell. It had also drifted into coincidence: the sibling settle above is 3000, so the
   * two numbers were one edit from meeting and the test would have passed for the wrong reason.
   *
   * The claim is "no settle was ADDED", which is a fact about configuration. The supervisor now
   * reports it, so it can be read instead of timed, and there is no clock left to flake.
   */
  it('does not wait when nothing asked it to, so a fast tool stays fast', async () => {
    const s = new NodeSupervisor({
      executable: process.execPath,
      workspaceRoot: process.cwd(),
      tool: { id: 'node', version: process.version, workspace: 'ws' },
      now: () => Date.now(),
    });
    const run = await s.run('quick', ['-e', 'process.exit(0)'], 10_000);
    expect(run.settledMs).toBe(0);
  });
});

describe('what the supervisor remembers', () => {
  it('reports the runs since a moment, so a window can ask what happened in it', async () => {
    const s = supervisor();
    await s.run('first', ['-e', 'process.stdout.write("a\\n")'], 10_000);
    const midpoint = Date.now() + 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await s.run('second', ['-e', 'process.stdout.write("b\\n")'], 10_000);
    expect(s.invocationsSince(midpoint).map((i) => i.command)).toEqual(['second']);
  });
});
