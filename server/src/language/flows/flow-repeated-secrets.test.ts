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
} from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { FlowStore, REDACTED_FILL } from './flows.js';
import {
  SECRET_FIELD_ARG,
  SECRET_NAME_ARG,
  unsuppliedSecrets,
} from './fields/flow-secret-field.js';
import { compileActStep, compileSequenceStep, replayActionArgs } from './replay.js';
import { withCallSecrets } from '@/surface/tools/tool-kit.js';
import { runRoleStep } from './flow-step-runners.js';
import type { FlowReplaySession } from './flow-replay-types.js';

const FIRST_KEY = 'RETICLE_SECRET_PASSWORD';
const SECOND_KEY = 'RETICLE_SECRET_PASSWORD_2';
const anchor = { kind: AnchorKind.ROLE, role: 'textbox', name: 'Password' } as const;

const recordedFill = (value: string, name = 'Password') => ({
  tool: ReticleTool.ACT,
  stable: false,
  args: { by: QueryBy.ROLE, value: 'textbox', name, action: ActionType.FILL, args: { value } },
});

describe('a journey that fills the same secret field twice', () => {
  let root: string;
  let store: FlowStore;

  beforeEach(async () => {
    vi.stubEnv(FIRST_KEY, undefined);
    vi.stubEnv(SECOND_KEY, undefined);
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
    expect(flow.steps.map((step) => step.args?.['value'])).toEqual([REDACTED_FILL, REDACTED_FILL]);
    expect(flow.steps.map((step) => step.args?.[SECRET_NAME_ARG])).toEqual([FIRST_KEY, SECOND_KEY]);
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

  it('assigns distinct supplies when a new compiled journey is saved', async () => {
    const result = await store.saveJourney(
      {
        name: 'drive-saved-sign-in',
        version: 1,
        steps: [recordedFill('first-password'), recordedFill('second-password')],
      },
      undefined,
      'drive-saved-',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a saved journey');
    const loaded = await store.load(result.value.name);
    if (!loaded.ok) throw new Error('expected the new journey');
    expect(unsuppliedSecrets(loaded.value, {})).toEqual([
      { field: 'Password', envKey: FIRST_KEY },
      { field: 'Password', envKey: SECOND_KEY },
    ]);
  });

  it('counts sequence children in the same order as top-level fills', async () => {
    await store.save({
      name: 'sign-in-retry',
      version: 1,
      steps: [
        recordedFill('first-password'),
        {
          tool: ReticleTool.ACT_SEQUENCE,
          stable: false,
          args: { steps: [recordedFill('second-password').args] },
        },
      ],
    });
    const loaded = await store.load('sign-in-retry');
    if (!loaded.ok) throw new Error('expected a saved sequence');
    expect(unsuppliedSecrets(loaded.value, {})).toEqual([
      { field: 'Password', envKey: FIRST_KEY },
      { field: 'Password', envKey: SECOND_KEY },
    ]);
  });

  it('does not reuse another field’s existing key as an occurrence suffix', async () => {
    await store.save({
      name: 'sign-in-retry',
      version: 1,
      steps: [
        recordedFill('first-password'),
        recordedFill('second-password'),
        recordedFill('other-password', 'Password 2'),
      ],
    });
    const loaded = await store.load('sign-in-retry');
    if (!loaded.ok) throw new Error('expected a saved flow');
    expect(unsuppliedSecrets(loaded.value, {}).map((secret) => secret.envKey)).toEqual([
      FIRST_KEY,
      'RETICLE_SECRET_PASSWORD_3',
      SECOND_KEY,
    ]);
  });

  it('keeps the unsuffixed supply for legacy repeated placeholders without rewriting the file', async () => {
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
    expect(unsuppliedSecrets(loaded.value, {}).map((secret) => secret.envKey)).toEqual([FIRST_KEY]);
    expect(unsuppliedSecrets(loaded.value, { [FIRST_KEY]: 'legacy-password' })).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await store.load(flow.name)).toEqual(loaded);
    vi.stubEnv(FIRST_KEY, 'legacy-password');
    expect(
      loaded.value.steps.map((step) => replayActionArgs(step.args, false, 'Password')['value']),
    ).toEqual(['legacy-password', 'legacy-password']);
    await store.saveFlow(loaded.value);
    const resaved = await store.load(flow.name);
    if (!resaved.ok) throw new Error('expected a resaved legacy flow');
    expect(unsuppliedSecrets(resaved.value, { [FIRST_KEY]: 'legacy-password' })).toEqual([]);
  });

  it('keeps existing duplicate named secrets compatible when loaded', async () => {
    const flow = await saved();
    const legacy = {
      ...flow,
      steps: flow.steps.map((step) => ({
        ...step,
        args: { value: REDACTED_FILL, secret: FIRST_KEY },
      })),
    };
    await writeFile(join(root, 'flows', 'sign-in-retry.json'), JSON.stringify(legacy));
    const loaded = await store.load(flow.name);
    if (!loaded.ok) throw new Error('expected an existing named flow');
    await withCallSecrets({ [FIRST_KEY]: 'legacy-call-password' }, () => {
      expect(unsuppliedSecrets(loaded.value, {})).toEqual([]);
      expect(
        loaded.value.steps.map((step) => replayActionArgs(step.args, false, 'Password')['value']),
      ).toEqual(['legacy-call-password', 'legacy-call-password']);
      return Promise.resolve();
    });
  });

  it.each(['learning', 'resaving'])(
    'keeps old named secrets after %s writes the flow',
    async (write) => {
      const flow = await saved();
      const legacy = {
        ...flow,
        steps: flow.steps.map((step) => ({
          ...step,
          args: { value: REDACTED_FILL, secret: FIRST_KEY },
        })),
      };
      await writeFile(join(root, 'flows', 'sign-in-retry.json'), JSON.stringify(legacy));
      const loaded = await store.load(flow.name);
      if (!loaded.ok) throw new Error('expected a legacy named flow');
      const result =
        'learning' === write
          ? await store.recordLearned(flow.name, [
              { kind: 'console-error', step: 0, state: 'open' },
            ])
          : await store.saveFlow(loaded.value);
      expect(result.ok).toBe(true);
      const reloaded = await store.load(flow.name);
      if (!reloaded.ok) throw new Error('expected the updated legacy flow');
      vi.stubEnv(FIRST_KEY, 'legacy-environment');
      expect(unsuppliedSecrets(reloaded.value, { [FIRST_KEY]: 'legacy-environment' })).toEqual([]);
      expect(
        reloaded.value.steps.map((step) => replayActionArgs(step.args, false, 'Password')['value']),
      ).toEqual(['legacy-environment', 'legacy-environment']);
      await withCallSecrets({ Password: 'legacy-call' }, () => {
        expect(unsuppliedSecrets(reloaded.value, {})).toEqual([]);
        expect(
          reloaded.value.steps.map(
            (step) => replayActionArgs(step.args, false, 'Password')['value'],
          ),
        ).toEqual(['legacy-call', 'legacy-call']);
        return Promise.resolve();
      });
    },
  );

  it('allocates distinct supplies for SDK-marked fields with arbitrary labels', async () => {
    const name = 'Mot de passe';
    const first = 'RETICLE_SECRET_MOT_DE_PASSE';
    const second = `${first}_2`;
    const result = { role: 'textbox', name, secret: true };
    const act = (value: string) => ({ ref: 'pw', action: ActionType.FILL, args: { value } });
    const single = compileActStep(act('first-french-value'), result);
    const sequence = compileSequenceStep(
      { steps: [act('second-french-value')] },
      { steps: [result] },
    );
    expect(single.args[SECRET_FIELD_ARG]).toBe(true);
    await store.save({ name: 'connexion', version: 1, steps: [single, sequence] });
    const loaded = await store.load('connexion');
    if (!loaded.ok) throw new Error('expected the marked secret flow');
    expect(unsuppliedSecrets(loaded.value, {})).toEqual([
      { field: name, envKey: first },
      { field: name, envKey: second },
    ]);
    const saved = await readFile(join(root, 'flows', 'connexion.json'), 'utf8');
    expect(saved).not.toContain('first-french-value');
    expect(saved).not.toContain('second-french-value');
    expect(saved).not.toContain(SECRET_FIELD_ARG);
    await withCallSecrets({ [first]: 'call-first', [second]: 'call-second' }, () => {
      expect(unsuppliedSecrets(loaded.value, {})).toEqual([]);
      expect(replayActionArgs(loaded.value.steps[0]?.args, false, name)).toEqual({
        value: 'call-first',
      });
      expect(replayActionArgs(loaded.value.steps[1]?.steps?.[0]?.args, false, name)).toEqual({
        value: 'call-second',
      });
      return Promise.resolve();
    });
  });

  it('strips recorder metadata beside the secret name before replay dispatch', () => {
    vi.stubEnv(SECOND_KEY, 'second-supply');
    expect(
      replayActionArgs(
        { value: REDACTED_FILL, [SECRET_NAME_ARG]: SECOND_KEY, [SECRET_FIELD_ARG]: true },
        false,
        'Password',
      ),
    ).toEqual({ value: 'second-supply' });
  });

  it('reports an absent or empty second supply by its suffixed key', async () => {
    const flow = await saved();
    await withCallSecrets({ [FIRST_KEY]: 'first-password' }, () => {
      expect(unsuppliedSecrets(flow, { [SECOND_KEY]: '' })).toEqual([
        { field: 'Password', envKey: SECOND_KEY },
      ]);
      expect(replayActionArgs(flow.steps[1]?.args, false, 'Password')).toEqual({
        value: REDACTED_FILL,
      });
      return Promise.resolve();
    });
  });

  it.each([
    'RETICLE_SECRET_API_KEY_2',
    'PATH',
    `${FIRST_KEY}_1`,
    `${FIRST_KEY}_01`,
    `${FIRST_KEY}_next`,
  ])('ignores an unrelated or malformed secret name %s', async (name) => {
    const flow = await saved();
    const first = flow.steps[0];
    if (first === undefined) throw new Error('expected a fill');
    const args = { value: REDACTED_FILL, secret: name };
    const invalid = { ...flow, steps: [{ ...first, args }] };
    vi.stubEnv(name, 'unrelated-environment');
    await withCallSecrets({ [name]: 'unrelated-call' }, () => {
      expect(unsuppliedSecrets(invalid, { [name]: 'unrelated-environment' })).toEqual([
        { field: 'Password', envKey: FIRST_KEY },
      ]);
      expect(replayActionArgs(args, false, 'Password')).toEqual({ value: REDACTED_FILL });
      return Promise.resolve();
    });
    await withCallSecrets({ Password: 'own-password', [name]: 'unrelated-call' }, () => {
      expect(unsuppliedSecrets(invalid, {})).toEqual([]);
      expect(replayActionArgs(args, false, 'Password')).toEqual({ value: 'own-password' });
      return Promise.resolve();
    });
  });

  it('uses per-call keys for both fills without leaking the secret argument to the page', async () => {
    const flow = await saved();
    vi.stubEnv(FIRST_KEY, 'environment-first');
    vi.stubEnv(SECOND_KEY, 'environment-second');
    const values: unknown[] = [];
    const session: FlowReplaySession = {
      command: (name, args = {}): Promise<CommandResult> => {
        if (ReticleCommand.ACT === name) values.push(args['args']);
        return Promise.resolve({
          kind: 'command_result',
          id: 'secret-call',
          ok: true,
          result: { elements: [{ ref: 'password-field' }] },
        });
      },
      eventsSince: () => [],
      onEvent: () => () => undefined,
      elapsed: () => 0,
    };
    await withCallSecrets({ Password: 'call-first', [SECOND_KEY]: 'call-second' }, async () => {
      expect(unsuppliedSecrets(flow, {})).toEqual([]);
      const first = flow.steps[0];
      const second = flow.steps[1];
      if (first === undefined || second === undefined) throw new Error('expected two fills');
      expect(
        (await runRoleStep(session, first, 0, anchor, false, () => Promise.resolve())).ok,
      ).toBe(true);
      expect(
        (await runRoleStep(session, second, 1, anchor, false, () => Promise.resolve())).ok,
      ).toBe(true);
    });
    expect(values).toEqual([{ value: 'call-first' }, { value: 'call-second' }]);
  });
});
