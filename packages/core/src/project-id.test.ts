import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PROJECT_ID_HASH_LENGTH, projectIdFrom, slugifyPackageName } from './project-id.js';

/** The callers' hashing, reproduced here so the assertions are about the RULE, not about sha1. */
const sha1Short = (input: string): string =>
  createHash('sha1').update(input).digest('hex').slice(0, PROJECT_ID_HASH_LENGTH);

describe('slugifyPackageName', () => {
  it('strips the scope and collapses non-alphanumerics', () => {
    expect(slugifyPackageName('@acme/web')).toBe('acme-web');
    expect(slugifyPackageName('Weird__Name!!')).toBe('weird-name');
  });
});

describe('projectIdFrom', () => {
  it('uses the package name plus a fingerprint of the root', () => {
    expect(projectIdFrom('@acme/web', '/x/y', sha1Short)).toBe(`acme-web-${sha1Short('/x/y')}`);
  });

  it('falls back to the root folder name when there is no package name', () => {
    expect(projectIdFrom(undefined, '/a/b/my-app', sha1Short)).toBe(
      `my-app-${sha1Short('/a/b/my-app')}`,
    );
  });

  it('falls back to "app" when neither name yields anything usable', () => {
    expect(projectIdFrom('', '/', sha1Short)).toBe(`app-${sha1Short('/')}`);
  });

  /**
   * Two checkouts of the same package are different projects. Without the root in the hash, a
   * developer with the app cloned twice gets one id for both and their sessions interleave.
   */
  it('distinguishes two checkouts of the same package', () => {
    const a = projectIdFrom('web', '/home/me/one', sha1Short);
    const b = projectIdFrom('web', '/home/me/two', sha1Short);
    expect(a).not.toBe(b);
  });

  /** The folder-name fallback must not depend on which OS wrote the path. */
  it('reads the last path segment the same on both separators', () => {
    const posix = projectIdFrom(undefined, '/a/b/my-app', () => 'h');
    const windows = projectIdFrom(undefined, 'C:\\a\\b\\my-app', () => 'h');
    expect(posix).toBe(windows);
  });

  /** A trailing separator is not part of the folder name. */
  it('ignores a trailing separator', () => {
    expect(projectIdFrom(undefined, '/a/b/', () => 'h')).toBe(
      projectIdFrom(undefined, '/a/b', () => 'h'),
    );
  });
});
