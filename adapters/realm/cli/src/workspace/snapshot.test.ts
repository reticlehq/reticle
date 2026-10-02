import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeKind, diffSnapshots, takeSnapshot } from './snapshot.js';

/**
 * Tested against a real filesystem, on purpose.
 *
 * Every interesting case here is a way a real filesystem differs from the one people imagine:
 * two writes in the same second, a rename that looks like two unrelated events, a symlink that a
 * naive walk does not see at all. A fake filesystem would implement the imagined one, and pass.
 */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'reticle-snap-'));
}

describe('what a snapshot notices', () => {
  it('sees a file appear', () => {
    const root = scratch();
    const before = takeSnapshot([root]);
    writeFileSync(join(root, 'out.txt'), 'hello');
    const changes = diffSnapshots(before, takeSnapshot([root]));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe(ChangeKind.WRITTEN);
    expect(changes[0]?.path).toBe(join(root, 'out.txt'));
    rmSync(root, { recursive: true });
  });

  it('sees a file vanish', () => {
    const root = scratch();
    writeFileSync(join(root, 'gone.txt'), 'here');
    const before = takeSnapshot([root]);
    rmSync(join(root, 'gone.txt'));
    const changes = diffSnapshots(before, takeSnapshot([root]));
    expect(changes[0]?.kind).toBe(ChangeKind.DELETED);
    rmSync(root, { recursive: true });
  });

  /**
   * The case that makes mtime-and-size gating a false green.
   *
   * Measured while planning this: two writes inside the same second, of equal length, produce
   * identical mtime and identical size and different bytes. A snapshot that compared only the
   * cheap fields would report that nothing changed, over a file the tool had rewritten.
   *
   * So size and mtime may decide when to LOOK, and only a content hash decides what changed.
   */
  it('sees content change when the size and the timestamp do not', () => {
    const root = scratch();
    const path = join(root, 'same-size.txt');
    writeFileSync(path, 'aaaa');
    const before = takeSnapshot([root]);
    writeFileSync(path, 'bbbb');
    const changes = diffSnapshots(before, takeSnapshot([root]));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe(ChangeKind.MODIFIED);
    rmSync(root, { recursive: true });
  });

  it('says nothing at all when nothing happened', () => {
    const root = scratch();
    writeFileSync(join(root, 'steady.txt'), 'unchanged');
    const before = takeSnapshot([root]);
    expect(diffSnapshots(before, takeSnapshot([root]))).toEqual([]);
    rmSync(root, { recursive: true });
  });

  /**
   * A symlink is a thing that exists, and a naive walk does not see it.
   *
   * `find -type f` skips it, so a tool that replaced a real file with a link to somewhere else
   * would be reported as having done nothing. That is exactly the shape of change worth catching.
   */
  it('sees a symlink, which a file-only walk would miss', () => {
    const root = scratch();
    writeFileSync(join(root, 'real.txt'), 'target');
    const before = takeSnapshot([root]);
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
    const changes = diffSnapshots(before, takeSnapshot([root]));
    expect(changes.map((c) => c.path)).toEqual([join(root, 'link.txt')]);
    rmSync(root, { recursive: true });
  });

  /**
   * A permission change leaves the bytes identical.
   *
   * Making a file executable, or removing read access, changes what the world can do with it and
   * changes no content hash at all. A verifier that reported "unchanged" over a `chmod +x` would
   * be silent about the entire class of change that installers and build steps make.
   */
  /*
   * Read-only rather than executable, because the executable bit does not exist on Windows.
   *
   * This set 0o755 and asserted a change. Node's `chmod` on Windows honours ONE bit -- read-only --
   * and silently ignores the rest, so the mode never moved, the snapshot correctly reported nothing
   * changed, and the test failed on a platform where the product was right. Toggling read-only is a
   * real mode change on both, so one value covers both rather than skipping Windows.
   *
   * Restored before the delete: Windows refuses to unlink a read-only file.
   */
  it('sees a mode change, which leaves the content identical', () => {
    const root = scratch();
    const path = join(root, 'script.sh');
    writeFileSync(path, '#!/bin/sh\n');
    const before = takeSnapshot([root]);
    chmodSync(path, 0o444);
    const changes = diffSnapshots(before, takeSnapshot([root]));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe(ChangeKind.MODE_CHANGED);
    chmodSync(path, 0o644);
    rmSync(root, { recursive: true });
  });
});

describe('what a snapshot deliberately does not look at', () => {
  /**
   * The cost is not theoretical: hashing a `node_modules` measured over fifty thousand files and
   * more than a gigabyte, and a window takes two snapshots. Excluded by default, and the exclusion
   * is reported as coverage rather than hidden, because an empty blind-spot list is a positive
   * claim that nothing was hidden.
   */
  it('skips the directories that are somebody else content by default', () => {
    const root = scratch();
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'mine.ts'), 'export const a = 1');
    const snapshot = takeSnapshot([root]);
    expect([...snapshot.files.keys()].some((p) => p.includes('node_modules'))).toBe(false);
    expect([...snapshot.files.keys()].some((p) => p.endsWith('mine.ts'))).toBe(true);
    rmSync(root, { recursive: true });
  });

  it('can be told to look at something excluded by default', () => {
    const root = scratch();
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'bundle.js'), 'built');
    const snapshot = takeSnapshot([root], { exclude: [] });
    expect([...snapshot.files.keys()].some((p) => p.endsWith('bundle.js'))).toBe(true);
    rmSync(root, { recursive: true });
  });

  /**
   * A root that is not there is reported, not guessed at.
   *
   * Silently treating a missing directory as an empty one makes every `absent` claim over it true
   * and every `present` claim false, for a reason that has nothing to do with the subject.
   */
  it('reports a root it could not read, rather than treating it as empty', () => {
    const snapshot = takeSnapshot(['/definitely/not/a/real/root']);
    expect(snapshot.unreadable).toEqual(['/definitely/not/a/real/root']);
    expect(snapshot.files.size).toBe(0);
  });
});
