/**
 * A Node.js too old to load the CLI's ES modules never reached `main()`, so the Node version line
 * from the first-use checks could not show. `bin/reticle.js` now checks the version first, in
 * CommonJS that any Node.js can parse.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nodeTooOldLine } from './first-use-checks.js';
import { SERVER_NODE_RANGE, SERVER_VERSION } from '@/command/version/identity/server-version.js';

const BIN = fileURLToPath(new URL('../../../bin/reticle.js', import.meta.url));
const VERSION_FLAG = '--version';
const TOO_OLD = '18.0.0';
const NEW_ENOUGH = '99.0.0';

/** The bin's own exports. It runs the CLI only when it is the main module. */
const bin = createRequire(import.meta.url)(BIN) as {
  NODE_VERSION_ENV: string;
  nodeTooOldLine: (version: string, range: string | undefined) => string | undefined;
};

function run(version: string | undefined): ReturnType<typeof spawnSync> {
  const env = { ...process.env };
  delete env[bin.NODE_VERSION_ENV];
  if (version !== undefined) {
    env[bin.NODE_VERSION_ENV] = version;
  }
  return spawnSync(process.execPath, [BIN, VERSION_FLAG], { env, encoding: 'utf8' });
}

describe('the Node.js check in bin/reticle.js', () => {
  it('prints the first-use line and exits 1 on a Node.js below the floor', () => {
    const result = run(TOO_OLD);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`${String(nodeTooOldLine(TOO_OLD, SERVER_NODE_RANGE))}\n`);
  });

  it('lets a Node.js at or above the floor run the CLI', () => {
    for (const version of [NEW_ENOUGH, undefined]) {
      const result = run(version);
      expect(result.status).toBe(0);
      expect(String(result.stdout).trim()).toBe(SERVER_VERSION);
    }
  });

  it('gives the same line as the first-use check for each version', () => {
    for (const version of ['20.10.9', '20.11.0', '16.20.2', '22.1.0', 'not-a-version']) {
      expect(bin.nodeTooOldLine(version, SERVER_NODE_RANGE)).toBe(
        nodeTooOldLine(version, SERVER_NODE_RANGE),
      );
    }
  });
});
