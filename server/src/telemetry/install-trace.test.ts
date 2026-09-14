import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const reported: unknown[] = [];
vi.mock('./onboarding-funnel.js', () => ({
  reportOnboardingStep: (step: unknown) => {
    reported.push(step);
    return Promise.resolve(true);
  },
}));

const { drainInstallTrace } = await import('./install-trace.js');

/**
 * The installer runs before there is a CLI, so the three steps that can fail before Reticle exists
 * have nobody to emit them. They are written to a file and drained here.
 *
 * The file is on disk in a directory the user owns, which makes it the one telemetry payload a
 * person can edit — so every property below is about not trusting it.
 */
describe('draining what the installer could not report', () => {
  let dir = '';
  const trace = (): string => join(dir, 'install-trace.jsonl');

  beforeEach(() => {
    reported.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'reticle-trace-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('emits each breadcrumb the installer wrote', () => {
    writeFileSync(
      trace(),
      [
        '{"phase":"install","step":"script_started","status":"completed"}',
        '{"phase":"install","step":"runtime_ready","status":"completed","elapsedMs":120}',
      ].join('\n'),
    );
    expect(drainInstallTrace(dir)).toBe(2);
    expect(reported).toHaveLength(2);
  });

  /**
   * Deleted whether or not every line parsed. A file that stays re-reports the same install on
   * every CLI invocation for the life of the machine, which would make the first funnel step count
   * users-times-commands rather than users.
   */
  it('deletes the file, so one install is reported once', () => {
    writeFileSync(trace(), '{"phase":"install","step":"script_started","status":"completed"}');
    drainInstallTrace(dir);
    expect(existsSync(trace())).toBe(false);
    expect(drainInstallTrace(dir), 'a second run has nothing left to find').toBe(0);
  });

  it('drops a line that is not a valid step instead of putting it on the wire', () => {
    writeFileSync(
      trace(),
      [
        '{"phase":"install","step":"script_started","status":"completed"}',
        // A path where a step name should be. This is the shape rule 3 exists to stop, and the file
        // being user-editable is exactly why validating at the reporter alone is not enough.
        '{"phase":"install","step":"/Users/someone/secret/project","status":"completed"}',
        '{"phase":"nonsense","step":"x","status":"completed"}',
      ].join('\n'),
    );
    expect(drainInstallTrace(dir)).toBe(1);
    expect(reported).toHaveLength(1);
  });

  it('survives a truncated last write, which is what a killed installer leaves', () => {
    writeFileSync(
      trace(),
      '{"phase":"install","step":"script_started","status":"completed"}\n{"phase":"inst',
    );
    expect(drainInstallTrace(dir), 'the good line still counts').toBe(1);
  });

  it('caps how much a runaway file can emit', () => {
    const line = '{"phase":"install","step":"script_started","status":"completed"}';
    writeFileSync(trace(), Array.from({ length: 500 }, () => line).join('\n'));
    expect(drainInstallTrace(dir)).toBeLessThanOrEqual(32);
  });

  it('does nothing at all when the installer never ran', () => {
    expect(drainInstallTrace(dir)).toBe(0);
    expect(reported).toHaveLength(0);
  });

  it('leaves an unreadable directory alone rather than throwing into the CLI', () => {
    // Telemetry may never change what the product does — a missing state dir is not an error here.
    expect(() => drainInstallTrace(join(dir, 'does', 'not', 'exist'))).not.toThrow();
  });

  it('keeps the step exactly as written, so a real elapsed time is not invented', () => {
    writeFileSync(
      trace(),
      '{"phase":"install","step":"cli_installed","status":"failed","reason":"not_on_path","elapsedMs":9100}',
    );
    drainInstallTrace(dir);
    expect(reported[0]).toMatchObject({
      step: 'cli_installed',
      status: 'failed',
      reason: 'not_on_path',
      elapsedMs: 9100,
    });
  });
});
