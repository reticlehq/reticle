import { describe, expect, it } from 'vitest';
import { Verdict } from 'open-verification';
import { renderFrame, type HudState } from './frame.js';

const base: HudState = {
  expectation: 'dist/index.js is written',
  command: 'build',
  argv: ['--out', 'dist'],
  elapsedMs: 4_200,
  phase: 'running',
  watching: ['x-artifact', 'log', 'signal'],
  stdout: ['compiling 12 modules'],
  stderr: [],
  changes: [],
  dials: [],
  exit: undefined,
  verdict: undefined,
  workspaceRoot: '/ws',
};

describe('what a person watches while it runs', () => {
  /**
   * The expectation is on screen BEFORE anything has happened, and stays there.
   *
   * Watching is the only moment a human can see that the claim was pre-registered. Afterwards a
   * transcript cannot show it: an expectation amended once the result is known reads exactly like
   * an original one. So the live pane leads with it and never moves it below the result.
   */
  it('shows the expectation while the command is still running', () => {
    const out = renderFrame(base);
    expect(out).toContain('dist/index.js is written');
    expect(out.indexOf('EXPECT')).toBeLessThan(out.indexOf('OUT'));
  });

  /**
   * What is being WATCHED is on screen, not just what was seen.
   *
   * "Nothing was watching" and "it did not happen" produce identical silence, and the live pane is
   * the one place a person can tell them apart before the verdict lands. A channel absent from
   * this row is a question nobody is going to be able to answer.
   */
  it('names the channels being watched, so silence can be read correctly', () => {
    expect(renderFrame(base)).toContain('x-artifact');
  });

  it('shows elapsed time while running, and the exit only once there is one', () => {
    expect(renderFrame(base)).toContain('4.2s');
    expect(renderFrame(base)).not.toContain('exit');
    const done = renderFrame({
      ...base,
      phase: 'done',
      exit: { code: 0, signal: undefined, wasSignalled: false },
    });
    expect(done).toContain('exit 0');
  });

  /** Filesystem changes appear AS THEY LAND, relative to the workspace. That is the evidence. */
  it('streams the paths that changed, relative to the workspace', () => {
    const out = renderFrame({
      ...base,
      changes: [
        { path: '/ws/dist/index.js', kind: 'written', before: undefined, after: undefined },
      ],
    });
    expect(out).toContain('./dist/index.js');
    expect(out).not.toContain('/ws/dist');
  });

  /**
   * While running there is NO verdict, and the pane says so rather than leaving a blank.
   *
   * A blank where a verdict goes is read as a pass by anybody scanning. "not yet" is the honest
   * state and it has to be visible.
   */
  it('says the verdict is pending rather than leaving the row empty', () => {
    expect(renderFrame(base)).toContain('pending');
  });

  it('shows what bought the verdict once there is one', () => {
    const out = renderFrame({
      ...base,
      phase: 'done',
      verdict: { verdict: Verdict.YES, ground: 'proved', boughtBy: 'x-artifact' },
      exit: { code: 0, signal: undefined, wasSignalled: false },
    });
    expect(out).toMatch(/VERDICT.*yes/);
    expect(out).toContain('x-artifact');
  });

  /**
   * An `unknown` never renders as a failure, live or finished.
   *
   * On a live pane this matters more than in a report: somebody is watching, and a red-looking
   * row is the thing they will act on.
   */
  it('renders an unknown as not proved rather than as broken', () => {
    const out = renderFrame({
      ...base,
      phase: 'done',
      verdict: {
        verdict: Verdict.UNKNOWN,
        ground: 'no-independent-consequence',
        boughtBy: undefined,
      },
    });
    expect(out).toContain('NOT PROVED');
    expect(out).not.toMatch(/FAIL|✗/);
  });

  it('shows a host that was dialled, when a proxy is watching', () => {
    expect(renderFrame({ ...base, dials: [{ host: 'api.github.com', port: 443 }] })).toContain(
      'api.github.com',
    );
  });
});
