import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETICLE_CAPTURE_FILE_PREFIX } from '@reticlehq/core';
import { isCapturePath } from './visual-tools.js';

/**
 * The daemon reads a path that arrived from the PAGE, so this predicate is a trust boundary: it
 * decides whether `reticle_screenshot` will open a file a compromised renderer named. Both halves
 * matter and are tested separately — what it must accept (or desktop capture silently returns no
 * image), and what it must refuse (or the daemon becomes a file-read oracle).
 */
const PRIVATE_DIR = join(tmpdir(), `${RETICLE_CAPTURE_FILE_PREFIX}a1b2c3`);

describe('isCapturePath — what the daemon agrees to read', () => {
  it('accepts a capture inside the shell private capture directory', () => {
    expect(isCapturePath(join(PRIVATE_DIR, `${RETICLE_CAPTURE_FILE_PREFIX}1.png`))).toBe(true);
  });

  it('accepts the legacy flat layout, so an older SDK keeps working against a newer daemon', () => {
    expect(isCapturePath(join(tmpdir(), `${RETICLE_CAPTURE_FILE_PREFIX}90502-0.png`))).toBe(true);
  });

  it('refuses a private directory whose name is not ours', () => {
    expect(isCapturePath(join(tmpdir(), 'someone-else', `${RETICLE_CAPTURE_FILE_PREFIX}1.png`))).toBe(
      false,
    );
  });

  it('refuses a file that does not carry the prefix, even inside our directory', () => {
    expect(isCapturePath(join(PRIVATE_DIR, 'id_rsa'))).toBe(false);
  });

  it('refuses a traversal that climbs out of the temp dir', () => {
    expect(
      isCapturePath(`${PRIVATE_DIR}/../../etc/${RETICLE_CAPTURE_FILE_PREFIX}passwd.png`),
    ).toBe(false);
  });

  it('refuses a nesting deeper than one private directory', () => {
    expect(
      isCapturePath(join(PRIVATE_DIR, 'deeper', `${RETICLE_CAPTURE_FILE_PREFIX}1.png`)),
    ).toBe(false);
  });

  it('refuses a path outside the temp dir entirely', () => {
    expect(isCapturePath(`/etc/${RETICLE_CAPTURE_FILE_PREFIX}shadow.png`)).toBe(false);
  });
});
