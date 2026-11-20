/**
 * A password entered with `type` is saved redacted, like one entered with `fill`.
 *
 * Reported from the field: a password field was saved in plain text in a flow file. Redaction
 * read only a fill's `value`, and `type` carries its text in `text`, so a password typed key by key
 * reached the file verbatim even when the SDK marked the field as a secret. Flow files are often in
 * git, so this leaked a credential.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionType } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { describeStepResult } from '@/surface/tools/act/act-sequence-retry.js';
import { FlowStore, REDACTED_FILL, redactRecordedSteps } from './flows.js';
import { compileActStep, compileSequenceStep, replayActionArgs } from './replay.js';
import { secretEnvKey } from './fields/flow-secret-field.js';
import type { RecordedStep } from './recording/tape/recordings.js';

const TYPED = 'fictional-typed-password';
const typed = { ref: 'e7', action: ActionType.TYPE, args: { text: TYPED } };
/** A password input with no accessible name: the SDK marks it, and the anchor is the component. */
const nameless = { ok: true, component: 'PasswordInput', source: 'src/Login.tsx:12', secret: true };
const named = { ok: true, role: 'textbox', name: 'Password', secret: true };

describe('a password entered with type', () => {
  let root: string;
  let store: FlowStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reticle-typed-secret-'));
    store = new FlowStore(createNodeFileSystem(), root, { now: () => 1 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function savedText(steps: RecordedStep[]): Promise<string> {
    const res = await store.save({ name: 'typed', version: 1, steps });
    if (!res.ok) {
      throw new Error('expected a saved flow');
    }
    return readFile(join(root, 'flows', 'typed.json'), 'utf8');
  }

  it('is redacted from a named field the SDK marked', async () => {
    const text = await savedText([compileActStep(typed, named)]);
    expect(text).not.toContain(TYPED);
    expect(text).toContain(REDACTED_FILL);
  });

  it('is redacted from a field with no accessible name the SDK marked', async () => {
    const text = await savedText([compileActStep(typed, nameless)]);
    expect(text).not.toContain(TYPED);
    expect(text).toContain(REDACTED_FILL);
  });

  it('is redacted from a live act_sequence step', async () => {
    const result = describeStepResult(typed, nameless);
    const text = await savedText([compileSequenceStep({ steps: [typed] }, { steps: [result] })]);
    expect(text).not.toContain(TYPED);
  });

  it('is redacted from the recorded steps a tool hands back', () => {
    const shown = JSON.stringify(redactRecordedSteps([compileActStep(typed, nameless)]));
    expect(shown).not.toContain(TYPED);
  });

  it('gets its value back on replay, into the text a type step writes', () => {
    const key = secretEnvKey('Password');
    process.env[key] = TYPED;
    try {
      const args = replayActionArgs({ text: REDACTED_FILL, secret: key }, false, 'Password');
      expect(args['text']).toBe(TYPED);
      expect(args).not.toHaveProperty('value');
    } finally {
      delete process.env[key];
    }
  });
});
