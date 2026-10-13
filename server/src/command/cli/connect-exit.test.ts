/**
 * From persona drives: `reticle connect` printed "→ Connected." and exited 1, because the one thing
 * that did not finish was installing a dependency (here pnpm refusing a store in an isolated HOME).
 * A script or an agent reading the exit code read a failed connect over an account that was linked.
 */
import { describe, expect, it } from 'vitest';
import { InitFailure } from '@reticlehq/init';
import { connectExit } from '../cli.js';

describe('the exit code of a connect', () => {
  it('is 0 when it connected and only the dependency install was left, which it says', () => {
    const out = connectExit(0, InitFailure.DEPENDENCY_INSTALL);
    expect(out.code).toBe(0);
    expect(out.note).toContain('dependency install did not finish');
  });

  it('stays non-zero when setup stopped for anything else', () => {
    expect(connectExit(0, InitFailure.MCP_REGISTRATION).code).toBe(1);
    expect(connectExit(0, 'unknown').code).toBe(1);
  });

  it('is the cloud step’s own code when linking failed, and 0 when everything finished', () => {
    expect(connectExit(2, InitFailure.DEPENDENCY_INSTALL).code).toBe(2);
    expect(connectExit(0, undefined)).toEqual({ code: 0 });
  });
});
