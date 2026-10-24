/**
 * `init` ends with what Reticle sees of the app and the prompt for the coding agent, never a drive.
 *
 * The Harness is opt-in and runs at any setup score, so a low score is information only: the
 * first flow is proved by the coding agent with the prompt `init` prints.
 */
import { describe, expect, it } from 'vitest';
import { initCoverageLines, msgProveOneFlow } from './try-command.js';

const URL = 'http://localhost:5173';
const PROMPT =
  "Read https://docs.reticle.sh/skill.md, then improve Reticle's coverage in this repo:\n- add a store";

describe("init's ending", () => {
  it('at a low score: the score, the gaps, that the Harness can be switched on, then the prompt', () => {
    const lines = initCoverageLines(
      {
        missing: [{ capability: 'app state (store registered)' }],
        notSeenYet: ['stable test ids'],
        setupScore: 12,
        prompt: PROMPT,
      },
      URL,
    );
    expect(lines[0]).toBe(
      'Instrumentation: 12% — missing: app state (store registered), stable test ids',
    );
    expect(lines[1]).toContain('Harness can be switched on');
    expect(lines.join('\n')).not.toMatch(/unlocks|locked/i);
    expect(lines.slice(3)).toEqual(PROMPT.split('\n').map((line) => `  ${line}`));
  });

  it('with no prompt: says the Harness can be switched on, and still hands the first flow to the agent', () => {
    const lines = initCoverageLines({ setupScore: 87 }, URL);
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
