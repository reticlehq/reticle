import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionType,
  AnchorKind,
  QueryBy,
  ReticleCommand,
  ReticleTool,
  type CommandResult,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { FlowStore, REDACTED_FILL } from './flows.js';
import { secretKeyForFill, unsuppliedSecrets } from './fields/flow-secret-field.js';
import { runRoleStep } from './flow-step-runners.js';
import type { FlowReplaySession } from './flow-replay-types.js';

const FIRST_KEY = 'RETICLE_SECRET_PASSWORD';
const SECOND_KEY = 'RETICLE_SECRET_PASSWORD_2';
const anchor = { kind: AnchorKind.ROLE, role: 'textbox', name: 'Password' } as const;

describe('a journey that fills the same secret field twice', () => {
  let root: string;
  let store: FlowStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reticle-repeated-secret-'));
    store = new FlowStore(createNodeFileSystem(), root, { now: () => 1234 });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function saved(): Promise<FlowFile> {
    await store.save({
      name: 'sign-in-retry',
      version: 1,
      steps: ['fictional-wrong-password', 'fictional-correct-password'].map((value) => ({
        tool: ReticleTool.ACT,
        stable: false,
        args: {
          by: QueryBy.ROLE,
          value: 'textbox',
          name: 'Password',
          action: ActionType.FILL,
          args: { value },
        },
      })),
    });
    const loaded = await store.load('sign-in-retry');
    if (!loaded.ok) throw new Error('expected a saved flow');
    return loaded.value;
  }

  it('asks for distinct keys and keeps both original values off disk', async () => {
    const flow = await saved();
    expect(unsuppliedSecrets(flow, {})).toEqual([
      { field: 'Password', envKey: FIRST_KEY },
      { field: 'Password', envKey: SECOND_KEY },
    ]);
    expect(unsuppliedSecrets(flow, { [FIRST_KEY]: 'fictional-wrong-password' })).toEqual([
      { field: 'Password', envKey: SECOND_KEY },
    ]);
    expect(flow.steps[0]?.args?.['value']).toBe(REDACTED_FILL);
    const bytes = await readFile(join(root, 'flows', 'sign-in-retry.json'), 'utf8');
    expect(bytes).not.toContain('fictional-wrong-password');
    expect(bytes).not.toContain('fictional-correct-password');
    await store.saveFlow(flow);
    const resaved = await store.load(flow.name);
    if (!resaved.ok) throw new Error('expected a resaved flow');
    expect(resaved.value).toEqual(flow);
    const savedBytes = await readFile(join(root, 'flows', 'sign-in-retry.json'), 'utf8');
    await store.saveFlow(resaved.value);
    expect(await readFile(join(root, 'flows', 'sign-in-retry.json'), 'utf8')).toBe(savedBytes);
  });

  it('replays the two supplied values in their recorded order', async () => {
    const flow = await saved();
    vi.stubEnv(FIRST_KEY, 'fictional-wrong-password');
    vi.stubEnv(SECOND_KEY, 'fictional-correct-password');
    const values: unknown[] = [];
    const session: FlowReplaySession = {
      command: (name, args = {}): Promise<CommandResult> => {
        if (ReticleCommand.ACT === name) {
          values.push((args['args'] as Record<string, unknown>)['value']);
        }
        return Promise.resolve({
          kind: 'command_result',
          id: 'repeated-secret',
          ok: true,
          result: { elements: [{ ref: 'password-field' }] },
        });
      },
      eventsSince: () => [],
      onEvent: () => () => undefined,
      elapsed: () => 0,
    };
    const first = flow.steps[0];
    const second = flow.steps[1];
    if (first === undefined || second === undefined) throw new Error('expected two fills');
    expect((await runRoleStep(session, first, 0, anchor, false, () => Promise.resolve())).ok).toBe(
      true,
    );
    expect((await runRoleStep(session, second, 1, anchor, false, () => Promise.resolve())).ok).toBe(
      true,
    );
    expect(values).toEqual(['fictional-wrong-password', 'fictional-correct-password']);
  });

  it('counts sequence children in the same order as top-level fills', async () => {
    const flow = await saved();
    const first = flow.steps[0];
    const second = flow.steps[1];
    if (first === undefined || second === undefined) throw new Error('expected two fills');
    const repeated: FlowStep = { ...second, args: { value: REDACTED_FILL } };
    await store.saveFlow({
      ...flow,
      steps: [first, { tool: ReticleTool.ACT_SEQUENCE, anchor, steps: [repeated] }],
    });
    const loaded = await store.load(flow.name);
    if (!loaded.ok) throw new Error('expected a saved sequence');
    expect(unsuppliedSecrets(loaded.value, {})).toEqual([
      { field: 'Password', envKey: FIRST_KEY },
      { field: 'Password', envKey: SECOND_KEY },
    ]);
  });

  it('does not reuse another field’s existing key as an occurrence suffix', async () => {
    const flow = await saved();
    const first = flow.steps[0];
    if (first === undefined) throw new Error('expected a fill');
    await store.saveFlow({
      ...flow,
      steps: [
        first,
        { ...first, args: { value: REDACTED_FILL } },
        { ...first, anchor: { ...anchor, name: 'Password 2' } },
      ],
    });
    const loaded = await store.load(flow.name);
    if (!loaded.ok) throw new Error('expected a saved flow');
    expect(unsuppliedSecrets(loaded.value, {}).map((secret) => secret.envKey)).toEqual([
      FIRST_KEY,
      'RETICLE_SECRET_PASSWORD_3',
      SECOND_KEY,
    ]);
  });

  it('loads legacy repeated placeholders with distinct keys without rewriting the file', async () => {
    const flow = await saved();
    const legacy = {
      ...flow,
      steps: flow.steps.map((step) => ({ ...step, args: { value: REDACTED_FILL } })),
    };
    const path = join(root, 'flows', 'sign-in-retry.json');
    const bytes = JSON.stringify(legacy);
    await writeFile(path, bytes);
    const loaded = await store.load(flow.name);
    if (!loaded.ok) throw new Error('expected a legacy flow');
    expect(unsuppliedSecrets(loaded.value, {}).map((secret) => secret.envKey)).toEqual([
      FIRST_KEY,
      SECOND_KEY,
    ]);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await store.load(flow.name)).toEqual(loaded);
  });

  it('refuses a placeholder naming an unrelated environment variable', () => {
    expect(
      secretKeyForFill('<redacted: supply RETICLE_SECRET_API_KEY_2 at replay>', 'Password'),
    ).toBeUndefined();
    expect(
      secretKeyForFill('<redacted: supply RETICLE_SECRET_PASSWORD_0 at replay>', 'Password'),
    ).toBeUndefined();
    expect(
      secretKeyForFill('<redacted: supply RETICLE_SECRET_PASSWORD_2', 'Password'),
    ).toBeUndefined();
  });
});
