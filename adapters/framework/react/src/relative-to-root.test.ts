/**
 * Making a source pointer repo-relative — on the platform two thirds of users are on.
 *
 * `__RETICLE_ROOT__` is the dev server's `process.cwd()`, and `_debugSource.fileName` is the file
 * React recorded. On Windows BOTH are backslash-separated (`C:\Users\dev\app`,
 * `C:\Users\dev\app\src\Counter.tsx`) — and the code built its prefix as `root + '/'`, producing
 * `C:\Users\dev\app/`, a mixed separator that can never match the start of the file path.
 *
 * So on Windows the root was never stripped and every pointer came back as an absolute path from the
 * developer's own machine. That is the exact failure the vite plugin's comment warns about:
 * "Without this, source pointers come back as absolute paths from YOUR machine — useless in a
 * report." It was true on Windows the whole time, and Windows is a large share of our users.
 *
 * Found by reading, not by running: this repo has no Windows CI, so a pure-string bug on the
 * majority platform had nothing to trip over.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { RETICLE_ROOT_GLOBAL } from '@reticlehq/core';
import { relativeToRoot } from './index.js';

const setRoot = (root: string | undefined): void => {
  if (root === undefined) delete (globalThis as Record<string, unknown>)[RETICLE_ROOT_GLOBAL];
  else (globalThis as Record<string, unknown>)[RETICLE_ROOT_GLOBAL] = root;
};
afterEach(() => setRoot(undefined));

describe('relativeToRoot', () => {
  it('strips a posix root', () => {
    setRoot('/Users/dev/app');
    expect(relativeToRoot('/Users/dev/app/src/Counter.tsx')).toBe('src/Counter.tsx');
  });

  it('strips a WINDOWS root, where both sides use backslashes', () => {
    setRoot('C:\\Users\\dev\\app');
    expect(relativeToRoot('C:\\Users\\dev\\app\\src\\Counter.tsx')).toBe('src/Counter.tsx');
  });

  it('handles the mixed case Vite produces — posix file, windows root', () => {
    // Vite normalizes module ids to forward slashes while cwd() stays native, so one side of the
    // comparison is routinely already posix on Windows.
    setRoot('C:\\Users\\dev\\app');
    expect(relativeToRoot('C:/Users/dev/app/src/Counter.tsx')).toBe('src/Counter.tsx');
  });

  it('emits forward slashes, because every other surface expects them', () => {
    // Flow anchors, `file:line` pointers and the source-drift checks all speak posix paths.
    setRoot('C:\\app');
    expect(relativeToRoot('C:\\app\\src\\deep\\Thing.tsx')).toBe('src/deep/Thing.tsx');
  });

  it('tolerates a trailing separator on the root, either flavour', () => {
    setRoot('/Users/dev/app/');
    expect(relativeToRoot('/Users/dev/app/src/A.tsx')).toBe('src/A.tsx');
    setRoot('C:\\app\\');
    expect(relativeToRoot('C:\\app\\src\\B.tsx')).toBe('src/B.tsx');
  });

  it('leaves a file outside the root alone rather than mangling it', () => {
    setRoot('/Users/dev/app');
    expect(relativeToRoot('/elsewhere/vendor/x.tsx')).toBe('/elsewhere/vendor/x.tsx');
  });

  it('returns the file unchanged when no root was supplied', () => {
    setRoot(undefined);
    expect(relativeToRoot('/Users/dev/app/src/A.tsx')).toBe('/Users/dev/app/src/A.tsx');
  });

  it('is case-insensitive on the drive letter, which Windows treats as the same path', () => {
    setRoot('C:\\Users\\Dev\\App');
    expect(relativeToRoot('c:\\users\\dev\\app\\src\\A.tsx')).toBe('src/A.tsx');
  });
});
