import { describe, expect, it } from 'vitest';
import { RETICLE_NPM_PACKAGE, SERVER_VERSION } from './server-version.js';

/**
 * The version we report has to be a real one.
 *
 * This reads the package's own manifest at startup, and it used to find it by counting directories
 * upwards. That is a runtime path: the compiler cannot check it, no test touched it, and when the
 * file moved one level deeper every one of them still passed. The failure showed up only when an app
 * that embeds the server tried to start, which is the worst place to find out.
 *
 * What made it invisible is that nothing ever asserted the answer was sensible. An undefined version
 * reads as "this build has no version" rather than as a bug, and it is reported to the agent, put in
 * the handshake, and sent with telemetry. So this asks the smallest useful question: is what came
 * back actually a version, and actually our package name.
 */
describe('the server knows its own version', () => {
  it('reports a real version number, not nothing', () => {
    expect(
      SERVER_VERSION,
      'the version is read from this package manifest at startup. If it is empty, the manifest was ' +
        'not found — see ownManifest in server-version.ts.',
    ).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('names the package that actually carries the command', () => {
    expect(RETICLE_NPM_PACKAGE).toBe('@reticlehq/server');
  });
});
