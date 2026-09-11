import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReticleSourceCheckout, loadDotEnv } from './dev-repo.js';

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'reticle-devrepo-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return root;
}

describe('isReticleSourceCheckout — telemetry must never fire from our own repo', () => {
  /**
   * The `.env` file carrying RETICLE_TELEMETRY=0 is gitignored, so it exists only on whichever
   * machine created it. A fresh clone would otherwise phone home on the first `reticle serve` a
   * contributor runs. This marker is committed, so the guarantee travels with the repo.
   */
  it('detects the monorepo by its root package name', () => {
    const root = tree({ 'package.json': JSON.stringify({ name: 'reticle-monorepo' }) });
    expect(isReticleSourceCheckout(root)).toBe(true);
  });

  it('detects it from a nested working directory', () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'reticle-monorepo' }),
      'packages/server/package.json': JSON.stringify({ name: '@reticlehq/server' }),
    });
    expect(isReticleSourceCheckout(join(root, 'packages', 'server'))).toBe(true);
  });

  it('does not match an ordinary app that merely depends on Reticle', () => {
    const root = tree({
      'package.json': JSON.stringify({
        name: 'my-app',
        dependencies: { '@reticlehq/browser': '^2.0.0' },
      }),
    });
    expect(isReticleSourceCheckout(root)).toBe(false);
  });

  it('is false when there is no package.json at all', () => {
    expect(isReticleSourceCheckout(mkdtempSync(join(tmpdir(), 'reticle-empty-')))).toBe(false);
  });
});

describe('loadDotEnv', () => {
  it('reads KEY=value pairs, ignoring comments and blanks', () => {
    const root = tree({
      '.env': '# a comment\n\nRETICLE_TELEMETRY=0\nQUOTED="yes"\nSINGLE=\'ok\'\n',
    });
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(root, env);
    expect(env['RETICLE_TELEMETRY']).toBe('0');
    expect(env['QUOTED']).toBe('yes');
    expect(env['SINGLE']).toBe('ok');
  });

  /**
   * A real environment variable always wins. A .env that silently overrode `RETICLE_PORT=4401` from
   * the caller's shell would make the daemon bind somewhere the caller did not ask for.
   */
  it('never overrides a variable the environment already set', () => {
    const root = tree({ '.env': 'RETICLE_PORT=4400\n' });
    const env: NodeJS.ProcessEnv = { RETICLE_PORT: '4401' };
    loadDotEnv(root, env);
    expect(env['RETICLE_PORT']).toBe('4401');
  });

  it('is a no-op when there is no .env', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadDotEnv(mkdtempSync(join(tmpdir(), 'reticle-noenv-')), env)).not.toThrow();
    expect(Object.keys(env)).toEqual([]);
  });

  it('tolerates a malformed line rather than failing the whole load', () => {
    const root = tree({ '.env': 'GOOD=1\nthis is not a pair\nALSO_GOOD=2\n' });
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(root, env);
    expect(env['GOOD']).toBe('1');
    expect(env['ALSO_GOOD']).toBe('2');
  });
});
