/**
 * `init` ends with what Reticle sees of the app and the prompt for the coding agent, never a drive.
 *
 * The Harness is opt-in and unlocks at 80% instrumentation, and a freshly wired app is rarely
 * there, so the first flow is proved by the coding agent with the prompt `init` prints.
 */
import { describe, expect, it } from 'vitest';
import { initCoverageLines, msgProveOneFlow } from './try-command.js';

const URL = 'http://localhost:5173';
const PROMPT =
  "Read https://reticle.sh/SKILL.md, then improve Reticle's coverage in this repo:\n- add a store";

describe("init's ending", () => {
  it('below the gate: the score, the gaps, the Harness sentence, then the prompt to paste', () => {
    const reason =
      'Harness unlocks at 80% instrumentation. This app is at 62%: missing app state (store registered).';
    const lines = initCoverageLines(
      {
        missing: [{ capability: 'app state (store registered)' }],
        notSeenYet: ['stable test ids'],
        harnessGate: { percent: 62, unlocked: false, reason },
        prompt: PROMPT,
      },
      URL,
    );
    expect(lines[0]).toBe(
      'Instrumentation: 62% — missing: app state (store registered), stable test ids',
    );
    expect(lines[1]).toBe(reason);
    expect(lines.slice(3)).toEqual(PROMPT.split('\n').map((line) => `  ${line}`));
  });

  it('at the gate: says the Harness can be switched on, and still hands the first flow to the agent', () => {
    const lines = initCoverageLines({ harnessGate: { percent: 87, unlocked: true } }, URL);
    expect(lines[0]).toBe('Instrumentation: 87%');
    expect(lines[1]).toContain('Harness can be switched on');
    expect(lines[2]).toBe(msgProveOneFlow(URL));
  });

  it('with no tab to measure, says where to see it and still names the next step', () => {
    const lines = initCoverageLines(undefined, URL);
    expect(lines.join('\n')).toContain('reticle doctor');
    expect(lines.join('\n')).toContain('reticle_act_and_wait');
  });
});
