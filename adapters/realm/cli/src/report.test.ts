import { describe, expect, it } from 'vitest';
import { Declaration, Grade, Verdict } from 'open-verification';
import { renderReport } from './report.js';
import type { DriveRecord } from './report.js';

const record: DriveRecord = {
  expectation: 'src/config.ts gains parseConfig; nothing outside src/ changes',
  command: 'format',
  argv: ['--write', 'src/config.ts'],
  durationMs: 14_200,
  exit: { code: 0, signal: undefined, wasSignalled: false },
  changes: [{ path: '/ws/src/config.ts', kind: 'modified', before: undefined, after: undefined }],
  blindSpots: [
    { kind: 'effect-elsewhere', detail: 'writes outside /ws are unobserved', impeaching: false },
  ],
  adjudication: {
    verdict: Verdict.YES,
    grade: Grade.CONSEQUENCE,
    ground: 'proved',
    reasons: ['proved by independent evidence over a cleanly closed window'],
  },
  declaredAt: Declaration.BEFORE_ACTION,
  boughtBy: 'x-artifact',
  workspaceRoot: '/ws',
};

describe('what a person sees when the agent verifies itself', () => {
  /**
   * The expectation is rendered ABOVE the command, and that ordering is the design.
   *
   * It is the one property a transcript can never show afterwards: an expectation amended once the
   * result is known reads exactly like an original one. Putting it first, every time, is how a
   * reader can see that the claim was pre-registered rather than back-filled.
   */
  it('shows what was expected before what was run', () => {
    const out = renderReport(record);
    expect(out.indexOf('EXPECT')).toBeLessThan(out.indexOf('RUN'));
    expect(out).toContain('parseConfig');
  });

  /**
   * The exit code is shown, and shown NOT to have decided anything.
   *
   * This is the whole pedagogy of the product in one row. Every reader arrives believing `exit 0`
   * means it worked; the report has to display the thing they trust and make visible that
   * something else paid for the verdict.
   */
  it('prints the exit code and names what actually bought the verdict', () => {
    const out = renderReport(record);
    expect(out).toContain('exit 0');
    expect(out).toContain('x-artifact');
    expect(out).toMatch(/VERDICT\s+yes/);
  });

  /** The diff is the evidence, so it is the part a human reads. Paths are shown relative. */
  it('shows the filesystem diff, relative to the workspace', () => {
    const out = renderReport(record);
    expect(out).toContain('./src/config.ts');
    expect(out).not.toContain('/ws/src/config.ts');
  });

  /**
   * What was not seen is part of the report, not an appendix.
   *
   * A verdict that cannot say what it missed is indistinguishable from one that saw everything,
   * and those are the two facts a reader most needs to tell apart.
   */
  it('always says what it could not see', () => {
    expect(renderReport(record)).toContain('BLIND');
    expect(renderReport(record)).toContain('outside /ws');
  });

  /**
   * An unknown must not read like a failure.
   *
   * "I could not see" and "the tool is broken" send a reader in opposite directions, and a report
   * that renders them alike undoes the distinction the whole protocol is built on.
   */
  it('renders an unknown as unproved rather than as a fault', () => {
    const out = renderReport({
      ...record,
      adjudication: {
        verdict: Verdict.UNKNOWN,
        ground: 'no-independent-consequence',
        reasons: ['nothing independent of the action supports this at consequence grade'],
      },
      boughtBy: undefined,
      changes: [],
    });
    expect(out).toContain('NOT PROVED');
    expect(out).not.toContain('FAILED');
  });

  it('marks a claim written after the action as unable to prove anything', () => {
    const out = renderReport({ ...record, declaredAt: Declaration.AFTER_ACTION });
    expect(out).toContain('after the action');
  });
});
