import { describe, expect, it } from 'vitest';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import { dialsTheDaemon, parseCliArgs } from './cli-parse.js';

/**
 * A monorepo root whose wired apps name different ports printed "Not guessing which one you meant"
 * and then carried on with the default port: `reticle status` there reported on :4400 and exited 0,
 * so `status`, `mcp` and `verify` still answered for whichever project owned that daemon.
 */
describe('dialsTheDaemon — which commands the ambiguous-port refusal stops', () => {
  const parse = (argv: string[]): ReturnType<typeof parseCliArgs> =>
    parseCliArgs(argv, RETICLE_DEFAULT_PORT);

  it('stops every command that talks to the daemon on the resolved port', () => {
    for (const argv of [['status'], ['mcp'], ['stop'], ['doctor'], ['open']]) {
      expect(dialsTheDaemon(parse(argv))).toBe(true);
    }
  });

  it('lets through what never dials: init resolves the workspace itself, the rest need no port', () => {
    for (const argv of [['init'], ['version'], ['help'], ['license']]) {
      expect(dialsTheDaemon(parse(argv))).toBe(false);
    }
  });
});
