import { describe, expect, it } from 'vitest';
import { rememberProjectOnDisk, type RegistryIo } from './remember-project.js';

/**
 * Registering one project must never forget the others.
 *
 * The registry is a single file in the user's home directory holding every project Reticle knows
 * about. Registering appends to it, which means reading it, adding a line, and writing the whole
 * thing back.
 *
 * The read fails soft: a registry that cannot be understood is treated as an empty one. For READING
 * that is right, and the daemon says so where it does it -- a cache it cannot read is a cache it
 * does without, and it finds the project by looking instead.
 *
 * Writing that emptiness back is a different act. One file it could not parse becomes one file with
 * a single entry in it, and every other project the user has ever set up is gone. It happens during
 * `init`, which is exactly what somebody runs after upgrading.
 *
 * The function already treats its own failure as unimportant -- the caller ignores the result, and
 * the comment says every failure is swallowed. A swallowed failure should leave things as they were.
 */

function fakeIo(initial: string | null): { io: RegistryIo; written: () => string | null } {
  let contents = initial;
  return {
    io: {
      readFile: () => contents,
      writeFile: (_path, next) => {
        contents = next;
      },
      exists: () => null !== contents,
      homeDir: () => '/home/someone',
    },
    written: () => contents,
  };
}

const A_REAL_REGISTRY = JSON.stringify({
  version: 1,
  projects: { 'shop-a1b2c3': { directory: '/work/shop', lastSeenAt: 1 } },
});

describe('registering a project never forgets the others', () => {
  it('adds to a registry it understands', () => {
    const { io, written } = fakeIo(A_REAL_REGISTRY);
    expect(rememberProjectOnDisk(io, 'blog-d4e5f6', '/work/blog', 2)).toBe(true);
    const after = JSON.parse(written() ?? '{}') as { projects: Record<string, unknown> };
    expect(Object.keys(after.projects).sort()).toEqual(['blog-d4e5f6', 'shop-a1b2c3']);
  });

  it('leaves a registry from another version exactly as it found it', () => {
    // The case that loses somebody's setup. The file is intact and a later release can read it.
    const fromTheFuture = JSON.stringify({ version: 99, projects: { 'shop-a1b2c3': {} } });
    const { io, written } = fakeIo(fromTheFuture);
    expect(rememberProjectOnDisk(io, 'blog-d4e5f6', '/work/blog', 2)).toBe(false);
    expect(written()).toBe(fromTheFuture);
  });

  it('DOES replace a file that is not JSON at all', () => {
    // The opposite call, and deliberately so. There is nothing in `{ half a file` to keep, nobody
    // repairs one by hand, and refusing would mean this user is never recorded again -- silently,
    // since failures here are swallowed. Damage is repaired; a message from another release is kept.
    const { io, written } = fakeIo('{ half a file');
    expect(rememberProjectOnDisk(io, 'blog-d4e5f6', '/work/blog', 2)).toBe(true);
    expect(written()).toContain('blog-d4e5f6');
  });

  it('still creates the registry when there is none', () => {
    const { io, written } = fakeIo(null);
    expect(rememberProjectOnDisk(io, 'blog-d4e5f6', '/work/blog', 2)).toBe(true);
    expect(written()).toContain('blog-d4e5f6');
  });
});
