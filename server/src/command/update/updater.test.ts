import { describe, it, expect } from 'vitest';
import { installArgs, classifyExecutionKind } from './updater.js';

describe('classifyExecutionKind — global installs are not misread as local', () => {
  it('detects npx from the _npx cache path', () => {
    expect(
      classifyExecutionKind('/Users/x/.npm/_npx/abc/node_modules/@reticlehq/server/dist/cli.js'),
    ).toBe('npx');
  });

  it('detects global installs under the npm global prefix (lib/node_modules, Homebrew, nvm)', () => {
    expect(classifyExecutionKind('/usr/local/lib/node_modules/@reticlehq/server/dist/cli.js')).toBe(
      'global',
    );
    expect(
      classifyExecutionKind('/opt/homebrew/lib/node_modules/@reticlehq/server/dist/cli.js'),
    ).toBe('global');
    expect(
      classifyExecutionKind(
        '/Users/x/.nvm/versions/node/v20.0.0/lib/node_modules/@reticlehq/server/dist/cli.js',
      ),
    ).toBe('global');
  });

  it('detects a genuine local project install', () => {
    expect(
      classifyExecutionKind('/Users/x/my-app/node_modules/@reticlehq/server/dist/cli.js'),
    ).toBe('local');
  });
});

// The `reticle` bin ships in @reticlehq/server; @reticlehq/core is schema-only with no executable.
// Self-update must install the server package for every non-npx launch kind.
describe('installArgs — installs the bin package, never @reticlehq/core', () => {
  it('local install targets @reticlehq/server in the project root', () => {
    const plan = installArgs('9.9.9', 'local', '/proj');
    expect(plan).toEqual({ args: ['install', '@reticlehq/server@9.9.9'], cwd: '/proj' });
  });

  it('global install targets @reticlehq/server with -g', () => {
    expect(installArgs('9.9.9', 'global', null)).toEqual({
      args: ['install', '-g', '@reticlehq/server@9.9.9'],
    });
  });

  it('local with no project root falls back to a global install (still @reticlehq/server)', () => {
    expect(installArgs('9.9.9', 'local', null)).toEqual({
      args: ['install', '-g', '@reticlehq/server@9.9.9'],
    });
  });

  it('npx needs no install — restart re-resolves the package', () => {
    expect(installArgs('9.9.9', 'npx', null)).toBeNull();
  });

  it('never references @reticlehq/core', () => {
    for (const kind of ['local', 'global'] as const) {
      const plan = installArgs('1.0.0', kind, '/x');
      expect(plan?.args.join(' ')).not.toContain('@reticlehq/core');
    }
  });
});
