/**
 * init-side projectId derivation + snippet/.iris.json baking. The derivation must be algorithmically
 * identical to the Vite plugin's so a Vite app's plugin-stamped id matches what init records.
 */

import { describe, expect, it } from 'vitest';
import { deriveProjectId, packageName, slugifyPackageName, shortHash } from './project-id.js';
import { irisConfigContent, nextIrisDevFile, htmlManual } from './snippets.js';

describe('deriveProjectId (init)', () => {
  it('slug of package name + 8-hex root hash', () => {
    expect(deriveProjectId('@acme/web', '/srv/web')).toMatch(/^acme-web-[0-9a-f]{8}$/);
  });

  it('is stable and port-independent (same path → same id)', () => {
    expect(deriveProjectId('dash', '/srv/dash')).toBe(deriveProjectId('dash', '/srv/dash'));
  });

  it('distinct checkouts differ', () => {
    expect(deriveProjectId('web', '/a/web')).not.toBe(deriveProjectId('web', '/b/web'));
  });

  it('falls back to folder name then "app"', () => {
    expect(deriveProjectId(undefined, '/srv/widget')).toMatch(/^widget-[0-9a-f]{8}$/);
    expect(deriveProjectId(undefined, '/')).toMatch(/^app-[0-9a-f]{8}$/);
  });

  it('slugify and shortHash behave like the plugin', () => {
    expect(slugifyPackageName('@acme/Web_App')).toBe('acme-web-app');
    expect(shortHash('/x')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('packageName reads a string name, else undefined', () => {
    expect(packageName({ name: 'foo' })).toBe('foo');
    expect(packageName({ name: 123 })).toBeUndefined();
    expect(packageName(null)).toBeUndefined();
  });
});

describe('snippets bake the projectId', () => {
  it('.iris.json records projectId', () => {
    const json = JSON.parse(irisConfigContent('next', undefined, 'acme-web-1234abcd')) as Record<
      string,
      unknown
    >;
    expect(json['projectId']).toBe('acme-web-1234abcd');
    expect(json['framework']).toBe('next');
    expect(json['port']).toBeUndefined(); // default port omitted
  });

  it('Next IrisDev snippet passes projectId to connect()', () => {
    const code = nextIrisDevFile(undefined, 'acme-web-1234abcd');
    expect(code).toContain("projectId: 'acme-web-1234abcd'");
    expect(code).toContain('iris.connect(');
  });

  it('HTML snippet passes projectId to connect()', () => {
    expect(htmlManual(undefined, 'acme-web-1234abcd')).toContain("projectId: 'acme-web-1234abcd'");
  });

  it('a non-default port and projectId appear together', () => {
    const code = nextIrisDevFile(5000, 'p-1234abcd');
    expect(code).toContain('ws://localhost:5000');
    expect(code).toContain("projectId: 'p-1234abcd'");
  });
});
