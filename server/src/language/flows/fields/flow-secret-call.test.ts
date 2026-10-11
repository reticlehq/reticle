/**
 * From a persona drive: a redacted field's value could only come from the daemon's environment at
 * start, so an agent with the value in hand had to restart the daemon to replay one flow. A call can
 * now supply it, for that call only, and nothing it passes is kept.
 */
import { describe, expect, it } from 'vitest';
import { AnchorKind, FLOW_FILE_VERSION, type FlowFile } from '@reticlehq/core';
import { REDACTED_FILL, secretValue, unsuppliedSecrets } from './flow-secret-field.js';
import { takeCallSecrets, withCallSecrets } from '@/surface/tools/tool-kit.js';

const flow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: 'sign-in',
  createdAt: 0,
  steps: [
    {
      tool: 'reticle_act',
      anchor: { kind: AnchorKind.TESTID, value: 'auth-password' },
      action: 'fill',
      args: { value: REDACTED_FILL },
    },
  ],
} as unknown as FlowFile;

describe('a secret supplied with the call', () => {
  it('is taken out of the arguments, so nothing downstream logs or journals it', () => {
    const { secrets, rest } = takeCallSecrets({
      flowName: 'sign-in',
      secrets: { 'auth-password': 'typed-x' },
    });
    expect(rest).toEqual({ flowName: 'sign-in' });
    expect(secrets).toEqual({ 'auth-password': 'typed-x' });
  });

  it('supplies the field for that call only', async () => {
    expect(unsuppliedSecrets(flow, {})).toHaveLength(1);
    await withCallSecrets({ 'auth-password': 'x1' }, () => {
      expect(unsuppliedSecrets(flow, {})).toEqual([]);
      expect(secretValue('RETICLE_SECRET_AUTH_PASSWORD', {})).toBe('x1');
      return Promise.resolve();
    });
    expect(secretValue('RETICLE_SECRET_AUTH_PASSWORD', {})).toBeUndefined();
  });
});
