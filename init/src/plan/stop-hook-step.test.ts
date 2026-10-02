/**
 * `init --hooks` installs the print-only Stop hook into `.claude/settings.json`.
 *
 * That file is the user's, and other tools write in it, so the step MERGES: it adds one Stop entry,
 * keeps every other setting, never adds the entry twice, and refuses to touch a file it cannot parse.
 */
import { describe, expect, it } from 'vitest';
import { StepStatus } from './plan-types.js';
import { STOP_HOOK_COMMAND, stopHookStep } from './stop-hook-step.js';

const PATH = '/repo/.claude/settings.json';
const written = (content: string | null): unknown => {
  const step = stopHookStep(PATH, content);
  return step.write === undefined ? undefined : JSON.parse(step.write.content);
};
const ours = { hooks: [{ type: 'command', command: STOP_HOOK_COMMAND }] };

describe('stopHookStep', () => {
  it('creates the file when there is none', () => {
    expect(stopHookStep(PATH, null).status).toBe(StepStatus.APPLY);
    expect(written(null)).toEqual({ hooks: { Stop: [ours] } });
  });

  it('keeps every setting and every other hook already there', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [] },
    });
    expect(written(existing)).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }, ours],
        PreToolUse: [],
      },
    });
  });

  it('is already done when the hook is there', () => {
    const step = stopHookStep(PATH, JSON.stringify({ hooks: { Stop: [ours] } }));
    expect(step.status).toBe(StepStatus.ALREADY);
    expect(step.write).toBeUndefined();
  });

  // A file it cannot read is a file it must not rewrite: the user's other settings are in there.
  it('refuses to rewrite a file that is not a JSON object, and says what to add', () => {
    for (const bad of ['{ "hooks": ', '[1,2]']) {
      const step = stopHookStep(PATH, bad);
      expect(step.status).toBe(StepStatus.MANUAL);
      expect(step.write).toBeUndefined();
      expect(step.detail).toContain(STOP_HOOK_COMMAND);
    }
  });
});
