import { describe, expect, it } from 'vitest';
import { AnchorKind, type FlowFile } from '@reticlehq/core';
import { REDACTED_FILL, secretEnvKey, unsuppliedSecrets } from './flow-secret-field.js';

/**
 * A credential nobody supplied, reported as a change in the application.
 *
 * MEASURED against the bench app over a real MCP client. A flow recorded minutes earlier, replayed
 * against source nobody had touched, came back `drift: expect.element "nav-deployments" not present
 * after the action`, pointing at a component that had not changed and offering to "update the flow
 * if the change was intended". The actual cause: the password saves as REDACTED_FILL, nothing
 * supplied `RETICLE_SECRET_LOGIN_PASSWORD`, so replay typed the placeholder into the box and the
 * sign-in failed.
 *
 * Setting that one variable took the suite from 4/30 to 13/34 -- nine flows reported as application
 * regressions were the harness missing a credential. `replayActionArgs` knows the placeholder
 * survived substitution and had been discarding the fact; the argument for discarding it was that
 * the failure "names its own fix" by leaving the placeholder visible in the field, which is true
 * for a human watching a browser and false for the headless suite replay that is the normal case.
 */
const flowWith = (value: string): FlowFile =>
  ({
    version: 1,
    name: 'sign-in',
    steps: [
      {
        tool: 'reticle_act',
        anchor: { kind: AnchorKind.TESTID, value: 'login-password' },
        action: 'fill',
        args: { value },
      },
    ],
  }) as unknown as FlowFile;

describe('a flow whose credential nobody supplied', () => {
  it('derives the variable name from the field, so the flow can say what to set', () => {
    expect(secretEnvKey('login-password')).toBe('RETICLE_SECRET_LOGIN_PASSWORD');
  });

  it('is reported as unsupplied when the variable is absent', () => {
    expect(unsuppliedSecrets(flowWith(REDACTED_FILL), {})).toEqual([
      { field: 'login-password', envKey: 'RETICLE_SECRET_LOGIN_PASSWORD' },
    ]);
  });

  it('is satisfied once the variable is set', () => {
    const env = { RETICLE_SECRET_LOGIN_PASSWORD: 'hunter2' };
    expect(unsuppliedSecrets(flowWith(REDACTED_FILL), env)).toEqual([]);
  });

  it('treats an EMPTY variable as unsupplied, matching what substitution does', () => {
    // replayActionArgs requires length > 0, so an empty value leaves the placeholder in place.
    expect(
      unsuppliedSecrets(flowWith(REDACTED_FILL), { RETICLE_SECRET_LOGIN_PASSWORD: '' }),
    ).toEqual([{ field: 'login-password', envKey: 'RETICLE_SECRET_LOGIN_PASSWORD' }]);
  });

  it('says nothing about a flow that carries no redacted field', () => {
    expect(unsuppliedSecrets(flowWith('admin@reticle.dev'), {})).toEqual([]);
  });
});
