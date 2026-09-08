/**
 * Zero-config projectId derivation: stable, human-readable, and unchanged when the dev port shifts.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveProjectId,
  readConfiguredProjectId,
  resolveProjectId,
  shortHash,
  slugifyPackageName,
} from './project-id.js';

describe('slugifyPackageName', () => {
  it('drops the @scope punctuation and dasherizes', () => {
    expect(slugifyPackageName('@acme/web-app')).toBe('acme-web-app');
    expect(slugifyPackageName('My_Cool.App')).toBe('my-cool-app');
    expect(slugifyPackageName('  spaced  name ')).toBe('spaced-name');
  });
});

describe('deriveProjectId', () => {
  it('combines the slugified package name with a stable root-path hash', () => {
    const id = deriveProjectId('@acme/web', '/Users/dev/acme-web');
    expect(id).toMatch(/^acme-web-[0-9a-f]{8}$/);
  });

  it('is stable across runs (same inputs → same id)', () => {
    expect(deriveProjectId('web', '/a/b')).toBe(deriveProjectId('web', '/a/b'));
  });

  it('does NOT change when the port changes — identity is the path, not the port', () => {
    // Same checkout, whatever port it boots on, yields the same projectId.
    const a = deriveProjectId('dash', '/srv/dash');
    const b = deriveProjectId('dash', '/srv/dash');
    expect(a).toBe(b);
  });

  it('different checkouts of the same package get distinct ids', () => {
    expect(deriveProjectId('web', '/clone-a/web')).not.toBe(deriveProjectId('web', '/clone-b/web'));
  });

  it('falls back to the folder name, then to "app", when no package name', () => {
    expect(deriveProjectId(undefined, '/srv/my-dash')).toMatch(/^my-dash-[0-9a-f]{8}$/);
    expect(deriveProjectId(undefined, '/')).toMatch(/^app-[0-9a-f]{8}$/);
  });
});

describe('shortHash', () => {
  it('is 8 hex chars and deterministic', () => {
    expect(shortHash('/x')).toMatch(/^[0-9a-f]{8}$/);
    expect(shortHash('/x')).toBe(shortHash('/x'));
    expect(shortHash('/x')).not.toBe(shortHash('/y'));
  });
});

describe('resolveProjectId', () => {
  it('an explicit id wins over derivation', () => {
    expect(resolveProjectId('custom-id', '/root', () => 'pkg')).toBe('custom-id');
  });

  it('derives from the injected package-name reader when no explicit id', () => {
    expect(resolveProjectId(undefined, '/srv/app', () => '@acme/dash')).toMatch(
      /^acme-dash-[0-9a-f]{8}$/,
    );
  });

  it('handles a missing package.json (reader returns undefined)', () => {
    expect(resolveProjectId(undefined, '/srv/widgets', () => undefined)).toMatch(
      /^widgets-[0-9a-f]{8}$/,
    );
  });
});

/**
 * The id of record is the one `init` wrote, not the one the plugin can re-derive.
 *
 * Both halves derived independently from `pkg.name + sha1(absolute root)`, and they agreed only
 * while the plugin's `process.cwd()` matched the directory `init` ran in. A dev server in a
 * container breaks that: the root is `/app` inside and the host path outside, so the page announced
 * one project and the daemon expected another, and the bridge refused every connection with
 * `authentication failed` — an error that says nothing about paths. Measured in the field at six
 * minutes to diagnose, ending in a hand-written `projectId` option in vite.config.
 *
 * `.reticle.json` already carries the answer, it is already the file the server walks up to find,
 * and the plugin simply never opened it.
 */
describe('resolveProjectId reads the id init recorded', () => {
  const noPkg = (): undefined => undefined;

  it('prefers .reticle.json over deriving from the root path', () => {
    expect(resolveProjectId(undefined, '/app', noPkg, () => 'bluedot-frontend-ac78e745')).toBe(
      'bluedot-frontend-ac78e745',
    );
  });

  it('still lets an explicit option win — it is the most local statement of intent', () => {
    expect(resolveProjectId('explicit', '/app', noPkg, () => 'from-config')).toBe('explicit');
  });

  it('derives as before when no config names an id', () => {
    expect(resolveProjectId(undefined, '/srv/widgets', noPkg, () => undefined)).toMatch(
      /^widgets-[0-9a-f]{8}$/,
    );
  });

  it('ignores an empty id rather than stamping an empty string', () => {
    expect(resolveProjectId(undefined, '/srv/widgets', noPkg, () => '')).toMatch(
      /^widgets-[0-9a-f]{8}$/,
    );
  });
});

describe('readConfiguredProjectId', () => {
  const tree = (files: Record<string, string>) => (path: string) => {
    const found = files[path];
    if (found === undefined) throw new Error(`ENOENT: ${path}`);
    return found;
  };

  it('reads projectId from .reticle.json in the given directory', () => {
    const read = tree({ '/app/.reticle.json': '{"framework":"vite","projectId":"acme-1234abcd"}' });
    expect(readConfiguredProjectId('/app', read)).toBe('acme-1234abcd');
  });

  it('walks up to the config, for an app wired one directory below it', () => {
    const read = tree({ '/repo/.reticle.json': '{"projectId":"acme-1234abcd"}' });
    expect(readConfiguredProjectId('/repo/frontend', read)).toBe('acme-1234abcd');
  });

  it('returns undefined when no config exists', () => {
    expect(readConfiguredProjectId('/nowhere', tree({}))).toBeUndefined();
  });

  it('returns undefined for a config that names no id, rather than throwing', () => {
    const read = tree({ '/app/.reticle.json': '{"framework":"vite"}' });
    expect(readConfiguredProjectId('/app', read)).toBeUndefined();
  });

  it('survives an unparseable config — a dev server must still start', () => {
    const read = tree({ '/app/.reticle.json': '{not json' });
    expect(readConfiguredProjectId('/app', read)).toBeUndefined();
  });
});
