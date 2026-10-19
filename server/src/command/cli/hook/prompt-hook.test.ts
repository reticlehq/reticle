/**
 * `reticle hook prompt --agent <id>`: what an agent's prompt-submit hook runs.
 *
 * It reads each agent's own payload, keeps the prompt in the engine's shape, redacts secrets first,
 * and never stands between the user and the prompt: a bad payload or no project is exit 0 and
 * nothing written.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromptContextSchema } from '@reticlehq/core/artifacts';
import { capturePrompt, hookAck, promptFromPayload } from './prompt-hook.js';

const PROMPT = 'The checkout must show the total. Use the existing Button.';

function project(config: Record<string, unknown> = { projectId: 'shop-1' }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-hook-')));
  writeFileSync(join(dir, '.reticle.json'), JSON.stringify(config));
  return dir;
}

const request = (dir: string): unknown =>
  JSON.parse(readFileSync(join(dir, '.reticle', 'request.json'), 'utf8'));
const history = (dir: string): unknown[] =>
  readFileSync(join(dir, '.reticle', 'requests.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

const run = (agent: string, payload: unknown, cwd = '/nowhere', env: NodeJS.ProcessEnv = {}) =>
  capturePrompt(agent, JSON.stringify(payload), { cwd, env, now: () => 1_000 });

describe('the prompt in each agent payload', () => {
  it('reads the prompt and the folder each agent sends', () => {
    expect(promptFromPayload('claude-code', { prompt: 'a', cwd: '/x' }, '/f', {})).toEqual({
      prompt: 'a',
      cwd: '/x',
    });
    expect(
      promptFromPayload('cursor', { prompt: 'a', workspace_roots: ['/w', '/v'] }, '/f', {}),
    ).toEqual({ prompt: 'a', cwd: '/w' });
    // Windsurf sends no folder: the hook runs in the workspace root.
    expect(promptFromPayload('windsurf', { tool_info: { user_prompt: 'a' } }, '/f', {})).toEqual({
      prompt: 'a',
      cwd: '/f',
    });
    expect(
      promptFromPayload('copilot', { prompt: 'a', cwd: '/c', sessionId: 's' }, '/f', {}),
    ).toEqual({ prompt: 'a', cwd: '/c' });
    // The agent's project variable when the payload names no folder.
    expect(
      promptFromPayload('gemini', { prompt: 'a' }, '/f', { GEMINI_PROJECT_DIR: '/g' }),
    ).toEqual({ prompt: 'a', cwd: '/g' });
  });

  it('answers each agent the way it expects', () => {
    expect(hookAck('cursor')).toBe('{"continue":true}\n');
    expect(hookAck('gemini')).toBe('{}\n');
    expect(hookAck('claude-code')).toBe('');
  });
});

describe('capturing a prompt', () => {
  it('writes the engine shape and the history', () => {
    const dir = project();
    expect(run('claude-code', { prompt: PROMPT, cwd: dir }).written).toEqual([
      join(dir, '.reticle'),
    ]);
    const kept = PromptContextSchema.parse(request(dir));
    expect(kept.request).toBe(PROMPT);
    expect(kept.at).toBe(1_000);
    expect(kept.statements.map((s) => [s.source, s.kind])).toEqual([
      ['user', 'acceptance-criterion'],
      ['user', 'technical-constraint'],
    ]);
    expect(history(dir)).toEqual([{ at: 1_000, agent: 'claude-code', request: PROMPT }]);
  });

  it('redacts a secret before anything is written', () => {
    const dir = project();
    run('codex', { prompt: 'deploy with api_key=sk_live_abcdefghijklmnop1234 now', cwd: dir });
    const text = readFileSync(join(dir, '.reticle', 'request.json'), 'utf8');
    expect(text).not.toContain('sk_live_abcdefghijklmnop1234');
    expect(readFileSync(join(dir, '.reticle', 'requests.jsonl'), 'utf8')).not.toContain(
      'sk_live_abcdefghijklmnop1234',
    );
  });

  it('finds the project from a folder inside it', () => {
    const dir = project();
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
    run('claude-code', { prompt: PROMPT, cwd: join(dir, 'src', 'deep') });
    expect(existsSync(join(dir, '.reticle', 'request.json'))).toBe(true);
  });

  it('writes into the app of a monorepo too, where its runs read it', () => {
    const dir = project({ projectId: 'shop-1' });
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    writeFileSync(
      join(dir, 'apps', 'web', '.reticle.json'),
      JSON.stringify({ projectId: 'shop-1' }),
    );
    mkdirSync(join(dir, 'apps', 'other'), { recursive: true });
    writeFileSync(
      join(dir, 'apps', 'other', '.reticle.json'),
      JSON.stringify({ projectId: 'other-2' }),
    );
    const { written } = run('claude-code', { prompt: PROMPT, cwd: dir });
    expect(written.sort()).toEqual(
      [join(dir, '.reticle'), join(dir, 'apps', 'web', '.reticle')].sort(),
    );
  });

  it('writes nothing and does not throw on a bad payload or with no project', () => {
    const dir = project();
    expect(
      capturePrompt('claude-code', 'not json', { cwd: dir, env: {}, now: () => 1 }).written,
    ).toEqual([]);
    expect(run('claude-code', { cwd: dir }).written).toEqual([]);
    expect(run('claude-code', { prompt: PROMPT, cwd: '/no/such/folder' }).written).toEqual([]);
    expect(existsSync(join(dir, '.reticle'))).toBe(false);
  });

  it('keeps a prompt the agent wrote for itself out', () => {
    const dir = project();
    expect(
      run('claude-code', { prompt: '<task-notification>x</task-notification>', cwd: dir }).written,
    ).toEqual([]);
  });

  it('honours the project setting and the machine switch', () => {
    const off = project({ projectId: 'shop-1', promptCapture: false });
    expect(run('claude-code', { prompt: PROMPT, cwd: off }).written).toEqual([]);
    const on = project();
    expect(
      run('claude-code', { prompt: PROMPT, cwd: on }, '/nowhere', {
        RETICLE_PROMPT_CAPTURE: '0',
      }).written,
    ).toEqual([]);
    expect(existsSync(join(on, '.reticle'))).toBe(false);
  });

  it('keeps one copy when two hooks fire for one prompt', () => {
    const dir = project();
    run('copilot', { prompt: PROMPT, cwd: dir });
    run('copilot', { prompt: PROMPT, cwd: dir });
    expect(history(dir)).toHaveLength(1);
  });

  it('caps what it keeps', () => {
    const dir = project();
    run('claude-code', { prompt: 'word '.repeat(10_000), cwd: dir });
    const kept = PromptContextSchema.parse(request(dir));
    expect(kept.request?.length).toBeLessThanOrEqual(20_000);
  });
});

/*
 * Writers run detached and can finish out of order. The newest prompt must stay the request, and
 * every prompt must reach the history.
 */
describe('prompts kept out of order', () => {
  it('keeps the newest as the request and every one in the history', () => {
    const dir = project();
    capturePrompt('claude-code', JSON.stringify({ prompt: 'second', cwd: dir }), {
      cwd: dir,
      env: {},
      now: () => 2_000,
    });
    capturePrompt('claude-code', JSON.stringify({ prompt: 'first', cwd: dir }), {
      cwd: dir,
      env: {},
      now: () => 1_000,
    });
    expect(request(dir)).toMatchObject({ request: 'second', at: 2_000 });
    expect(history(dir)).toHaveLength(2);
  });
});
