import { describe, expect, it } from 'vitest';
import { CloseCondition, Grade, Independence, RefusalReason } from 'open-verification';
import { CliRealm } from './cli-realm.js';
import { CliChannel } from './channels.js';
import type { CommandManifest } from './manifest.js';
import type { Invocation, Supervisor } from './process/supervisor.js';

/**
 * A supervisor that runs nothing.
 *
 * The realm must be testable without spawning, which is the whole reason `Supervisor` is a port
 * rather than a call to `node:child_process`. A realm that could only be tested by running real
 * programs would be tested rarely and slowly, and the interesting cases -- a kill, a fork, a
 * process that never ends -- are the ones hardest to produce on demand.
 */
function fakeSupervisor(over: Partial<Invocation> = {}): Supervisor {
  const invocation: Invocation = {
    id: 'i1',
    command: 'build',
    argv: ['build'],
    startedAt: 0,
    endedAt: 10,
    exit: { code: 0, signal: undefined, wasSignalled: false },
    stdout: [{ seq: 0, text: 'built ok' }],
    stderr: [],
    settledMs: 0,
    ...over,
  };
  return {
    run: () => Promise.resolve(invocation),
    invocationsSince: () => [invocation],
    toolIdentity: () => ({ id: 'mytool', version: '1.0.0', workspace: 'ws-abc' }),
  };
}

const manifest: CommandManifest = {
  workspaceRoot: '/tmp/ws',
  commands: [
    { name: 'build', meaning: 'compile the project', mutating: true, argv: ['build'] },
    { name: 'status', meaning: 'report state', mutating: false, argv: ['status'] },
  ],
};

const realm = (supervisor = fakeSupervisor()): CliRealm =>
  new CliRealm({ supervisor, manifest, now: () => 100 });

describe('what a CLI realm says about itself', () => {
  /**
   * The identity is the installed tool and the workspace, never the process.
   *
   * A CLI's process is shorter than the journey it belongs to: `tool init` then `tool build` is two
   * processes and one subject. An implementation that names the process makes every multi-step
   * journey self-invalidating and reports it as evidence superseded, which describes a fault in
   * nothing. That is OVP-SUBJ-3, and this is the realm it was written for.
   */
  it('identifies the tool and the workspace, not the process', () => {
    const id = realm().identity();
    expect(id.surface).toBe('x-cli');
    expect(id.instance).toBe('mytool@1.0.0#ws-abc');
    expect(id.locator).toBe('/tmp/ws');
  });

  /**
   * Four channels, and the two downgrades are the point.
   *
   * `log` is INDEPENDENT in the specification's default table, on the reasoning that an uncaught
   * exception reaches the log without the application choosing to report it. For a command-line
   * tool that is backwards: stdout is deliberate output from the same code path that did the work.
   * `signal` carries the exit code the tool CHOSE, so it drops from consequence to presence.
   *
   * Section 3 permits declaring a channel less trustworthy than the table and never more.
   */
  it('declares log and the exit code below the specification default, because a CLI chose them', () => {
    const declared = realm().channels();
    const log = declared.find((c) => c.id === CliChannel.LOG);
    expect(log?.independence).toBe(Independence.ACTUATION_DERIVED);

    const exit = declared.find((c) => c.id === CliChannel.EXIT_STATUS);
    expect(exit?.independence).toBe(Independence.ACTUATION_DERIVED);
    expect(exit?.grade).toBe(Grade.PRESENCE);
  });

  /**
   * A kill is decided by another party, so it is a SEPARATE channel from the code the tool chose.
   *
   * Merging them would force a lie in one of two directions: `independent` lets `exit 0` buy a
   * proof, and `actuation-derived` leaves a real crash unable to contradict the tool's own "done",
   * because two actuation-derived channels disagreeing may never convict. OVP-CHAN-5.
   */
  it('separates the kill the OS imposed from the code the tool chose', () => {
    const proc = realm()
      .channels()
      .find((c) => c.id === CliChannel.PROCESS);
    expect(proc?.independence).toBe(Independence.INDEPENDENT);
  });

  /**
   * Phase 1 observes no consequence, and says so at startup rather than one `unknown` at a time.
   *
   * This is a correct implementation that can observe, describe and act, and can prove nothing.
   * `canProveAnything` exists so an implementation learns that about itself before it is asked.
   */
  it('knows it cannot prove anything yet, without being asked a question first', () => {
    expect(realm().canProveAnything()).toBe(false);
  });
});

describe('what a CLI realm will and will not do', () => {
  it('offers the manifest as capabilities, in the tool own domain language', () => {
    const names = realm()
      .capabilities()
      .map((c) => c.name);
    expect(names).toContain('build');
    expect(names).toContain('status');
  });

  /**
   * The refusal is not this class's to forget: `perform` is sealed in the protocol.
   *
   * An implementation that quietly does something adjacent to what was asked produces a result
   * that looks like evidence and is not.
   */
  it('refuses a capability the manifest never declared', async () => {
    const receipt = await realm().perform({
      id: 'a1',
      actor: 'test',
      capability: 'deploy',
      at: 0,
    });
    expect(receipt.dispatched).toBe(false);
    expect(receipt.refused?.reason).toBe(RefusalReason.UNDECLARED);
  });

  it('reports a dispatch as delivery, never as success', async () => {
    const receipt = await realm().perform({
      id: 'a1',
      actor: 'test',
      capability: 'build',
      at: 0,
    });
    expect(receipt.dispatched).toBe(true);
    expect(receipt).not.toHaveProperty('verdict');
  });
});

describe('when a CLI window closes', () => {
  it('closes on exit for a one-shot command, which is the cleanest close there is', () => {
    const window = realm().openWindow(5_000);
    expect(window.closes).toBe(CloseCondition.EXIT);
  });

  /**
   * A killed process did not end of its own accord and did not exhaust OUR budget.
   *
   * Reporting `exit` would make `closedCleanly` true for a crashed run. Reporting
   * `budget-exhausted` would blame our patience for the subject misfortune.
   */
  it('reports a kill as terminated, which is not a clean close', () => {
    const killed = fakeSupervisor({
      exit: { code: undefined, signal: 'SIGKILL', wasSignalled: true },
    });
    const r = realm(killed);
    const closed = r.closeWindow(r.openWindow(5_000));
    expect(closed.closedBy).toBe(CloseCondition.TERMINATED);
  });

  it('reports the verifier own impatience as budget-exhausted, never as the subject ending', () => {
    const never = fakeSupervisor({ endedAt: undefined, exit: undefined });
    const r = realm(never);
    const closed = r.closeWindow(r.openWindow(5_000));
    expect(closed.closedBy).toBe(CloseCondition.BUDGET_EXHAUSTED);
  });
});
