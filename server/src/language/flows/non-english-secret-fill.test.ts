/**
 * A fill into a password field with a non-English accessible name is saved redacted on every path.
 *
 * Field report: a password field with the accessible name "Пароль" was saved verbatim in a flow
 * file, and the same flow with an English password field was redacted. Flow files are often in git,
 * so this leaked a credential. Two causes: the live `act_sequence` result dropped the SDK's
 * `secret` mark, and an SDK before 3.8.0 sends no mark, so the server rule was English only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionType, AnchorKind, ReticleTool, type FlowFile } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { describeStepResult } from '@/surface/tools/act/act-sequence-retry.js';
import { driveFlowsFrom } from '@/memory/journal/drive-flow.js';
import { withCallSecrets } from '@/surface/tools/tool-kit.js';
import { FlowStore, REDACTED_FILL, redactRecordedSteps } from './flows.js';
import {
  SECRET_NAME_ARG,
  secretEnvKey,
  secretKeyForFill,
  secretValue,
} from './fields/flow-secret-field.js';
import { compileActStep, compileSequenceStep } from './replay.js';
import type { RecordedStep } from './recording/tape/recordings.js';

const TYPED = 'fictional-cyrillic-password';
const NAME = 'Пароль';
const marked = { ok: true, role: 'textbox', name: NAME, secret: true };
const unmarked = { ok: true, role: 'textbox', name: NAME };
const fill = { ref: 'e7', action: ActionType.FILL, args: { value: TYPED } };

describe('a fill into a field named "Пароль"', () => {
  let root: string;
  let store: FlowStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reticle-non-english-secret-'));
    store = new FlowStore(createNodeFileSystem(), root, { now: () => 1 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function savedText(steps: RecordedStep[]): Promise<string> {
    const res = await store.save({ name: 'uvijty', version: 1, steps });
    if (!res.ok) {
      throw new Error('expected a saved flow');
    }
    return readFile(join(root, 'flows', 'uvijty.json'), 'utf8');
  }

  it('is redacted from a single act that carries the SDK mark', async () => {
    const text = await savedText([compileActStep(fill, marked)]);
    expect(text).not.toContain(TYPED);
    expect(text).toContain(REDACTED_FILL);
  });

  it('is redacted from a live act_sequence step that carries the SDK mark', async () => {
    // The live tool builds each step's result with describeStepResult, then compiles it.
    const result = describeStepResult(fill, marked);
    const text = await savedText([compileSequenceStep({ steps: [fill] }, { steps: [result] })]);
    expect(text).not.toContain(TYPED);
    expect(text).toContain(REDACTED_FILL);
  });

  it('is redacted from a live act_sequence step by the mark alone, whatever the name', async () => {
    // No name rule knows "Ключ", so only the SDK mark can redact this fill.
    const result = describeStepResult(fill, { ...marked, name: 'Ключ' });
    const text = await savedText([compileSequenceStep({ steps: [fill] }, { steps: [result] })]);
    expect(text).not.toContain(TYPED);
    expect(text).toContain(REDACTED_FILL);
  });

  it('is redacted from a single act of an SDK that sends no mark', async () => {
    const text = await savedText([compileActStep(fill, unmarked)]);
    expect(text).not.toContain(TYPED);
    expect(text).toContain(REDACTED_FILL);
  });

  it('is redacted from an act_sequence step of an SDK that sends no mark', async () => {
    const result = describeStepResult(fill, unmarked);
    const text = await savedText([compileSequenceStep({ steps: [fill] }, { steps: [result] })]);
    expect(text).not.toContain(TYPED);
  });

  it('is redacted from the flow a session saves at teardown', async () => {
    const step = {
      ...compileActStep(fill, unmarked),
      route: '/uvijty',
      expect: { kind: 'route', pathname: '/home' },
    } as RecordedStep & { route: string };
    const { programs } = driveFlowsFrom({ steps: [step] });
    const [program] = programs;
    if (program === undefined) {
      throw new Error('expected a drive program');
    }
    const res = await store.saveJourney(program, undefined, 'drive-');
    if (!res.ok) {
      throw new Error('expected a saved journey');
    }
    const text = await readFile(join(root, 'flows', `${res.value.name}.json`), 'utf8');
    expect(text).not.toContain(TYPED);
  });

  it('shows the placeholder in what record stop returns', () => {
    const shown = JSON.stringify(redactRecordedSteps([compileActStep(fill, unmarked)]));
    expect(shown).not.toContain(TYPED);
    expect(shown).toContain(REDACTED_FILL);
  });

  it('is redacted from an in-page recorded flow that an older SDK saved in clear', async () => {
    const flow: FlowFile = {
      version: 1,
      name: 'uvijty-page',
      createdAt: 1,
      steps: [
        {
          tool: ReticleTool.ACT,
          action: ActionType.FILL,
          anchor: { kind: AnchorKind.ROLE, role: 'textbox', name: NAME },
          args: { value: TYPED },
        },
      ],
    };
    const res = await store.saveFlow(flow);
    if (!res.ok) {
      throw new Error('expected a saved flow');
    }
    const text = await readFile(join(root, 'flows', 'uvijty-page.json'), 'utf8');
    expect(text).not.toContain(TYPED);
    expect(text).toContain(REDACTED_FILL);
  });
});

describe('the variable that supplies a non-ASCII field', () => {
  const VARIABLE = /^RETICLE_SECRET_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

  it('is a usable name, distinct for two different fields', () => {
    const first = secretEnvKey('Пароль');
    const second = secretEnvKey('Гасло');
    expect(first).toMatch(VARIABLE);
    expect(second).toMatch(VARIABLE);
    expect(first).not.toBe(second);
    expect(secretEnvKey('пароль')).toBe(first);
  });

  it('keeps the name an ASCII field had before', () => {
    expect(secretEnvKey('auth-password')).toBe('RETICLE_SECRET_AUTH_PASSWORD');
    expect(secretEnvKey('Mot de passe')).toBe('RETICLE_SECRET_MOT_DE_PASSE');
  });

  it('gives each field its own supply when the call names the field', async () => {
    await withCallSecrets({ Гасло: 'second', Пароль: 'first' }, () => {
      expect(secretValue(secretEnvKey('Пароль'), {})).toBe('first');
      expect(secretValue(secretEnvKey('Гасло'), {})).toBe('second');
      return Promise.resolve();
    });
  });

  it('still reads the name that an earlier version saved in the flow', () => {
    const legacy = 'RETICLE_SECRET__';
    expect(secretKeyForFill({ value: REDACTED_FILL, [SECRET_NAME_ARG]: legacy }, NAME)).toBe(
      legacy,
    );
    expect(secretKeyForFill({ value: REDACTED_FILL, [SECRET_NAME_ARG]: 'PATH' }, NAME)).toBe(
      secretEnvKey(NAME),
    );
  });
});
