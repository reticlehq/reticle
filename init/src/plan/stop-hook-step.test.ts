/**
 * `init --hooks` installs the print-only Stop hook into `.claude/settings.json`.
 *
 * That file is the user's, and other tools write in it, so the step MERGES: it adds one Stop entry,
 * keeps every other setting, never adds the entry twice, and refuses to touch a file it cannot parse.
 */
import { describe, expect, it } from 'vitest';
import { StepStatus } from './plan-types.js';
import {
  STOP_HOOK_COMMAND,
  stopHookStep,
  COMPACT_HOOK_COMMAND,
  claudeSettingsSteps,
  compactHookStep,
  promptHookStep,
} from './stop-hook-step.js';
import { PROMPT_HOOK_AGENTS, PromptHookAgent } from '@/register/prompt-hooks.js';

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

describe('the resume-after-compaction hook', () => {
  it('adds a SessionStart entry with matcher compact running `context --compact`', () => {
    const step = compactHookStep('.claude/settings.json', null);
    expect(step.status).toBe(StepStatus.APPLY);
    const written = JSON.parse(step.write?.content ?? '{}') as {
      hooks: { SessionStart: { matcher: string; hooks: { command: string }[] }[] };
    };
    expect(written.hooks.SessionStart).toEqual([
      { matcher: 'compact', hooks: [{ type: 'command', command: COMPACT_HOOK_COMMAND }] },
    ]);
    expect(COMPACT_HOOK_COMMAND).toMatch(/context --compact$/);
  });

  it('keeps every other setting and hook, and is idempotent', () => {
    const existing = JSON.stringify({ model: 'x', hooks: { SessionStart: [{ hooks: [] }] } });
    const step = compactHookStep('p', existing);
    const written = JSON.parse(step.write?.content ?? '{}') as Record<string, unknown>;
    expect(written['model']).toBe('x');
    expect(compactHookStep('p', step.write?.content).status).toBe(StepStatus.ALREADY);
  });

  it('merges on top of the Stop hook when both are asked for, so neither write undoes the other', () => {
    const steps = claudeSettingsSteps('p', null, { stop: true, compact: true });
    const last = steps.at(-1)?.write?.content ?? '';
    expect(last).toContain(STOP_HOOK_COMMAND);
    expect(last).toContain(COMPACT_HOOK_COMMAND);
  });
});

/**
 * Codex skips a project hook until the user trusts it in `/hooks`, and says nothing: a headless
 * `codex exec` ran a whole task on 2026-10-19 with every Reticle hook installed and none fired.
 */
describe('a hook the agent runs only after the user trusts it', () => {
  const codex = PROMPT_HOOK_AGENTS.find((agent) => PromptHookAgent.CODEX === agent.id);
  const cursor = PROMPT_HOOK_AGENTS.find((agent) => PromptHookAgent.CURSOR === agent.id);

  it('says how to trust it when it is installed, and again when it is already there', () => {
    if (codex === undefined) throw new Error('no Codex spec');
    const applied = promptHookStep({ spec: codex, path: 'p', existing: null });
    expect(applied.detail).toContain('/hooks');
    const again = promptHookStep({ spec: codex, path: 'p', existing: applied.write?.content ?? null });
    expect(again.status).toBe(StepStatus.ALREADY);
    expect(again.detail).toContain('/hooks');
  });

  it('adds nothing for an agent that runs its hooks as soon as they are written', () => {
    if (cursor === undefined) throw new Error('no Cursor spec');
    expect(promptHookStep({ spec: cursor, path: 'p', existing: null }).detail).not.toContain('/hooks');
  });
});
