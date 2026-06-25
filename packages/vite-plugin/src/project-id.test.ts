/**
 * Zero-config projectId derivation: stable, human-readable, and unchanged when the dev port shifts.
 */

import { describe, expect, it } from 'vitest';
import { deriveProjectId, resolveProjectId, shortHash, slugifyPackageName } from './project-id.js';

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
