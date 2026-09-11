import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * The one release step nothing could see fail until release day.
 *
 * `stamp-issuer-key.mjs` writes the enterprise issuer's public key into the built server. It
 * runs from `server`'s `prepack`, so every `npm pack` and every publish goes through it, and
 * `.github/workflows/publish.yml` has a comment about its ordering.
 *
 * It pointed at `dist/license/license.js` for as long as that module had lived in
 * `dist/features/license/`. Nothing noticed, and the reason it went unnoticed is the shape
 * worth keeping: the script returns EARLY when `RETICLE_ISSUER_PUBLIC_KEY` is unset, printing
 * "leaving eval mode", and it validates the key before it opens the file. On a workstation
 * both guards fire first, so the path is never reached. `npm pack --dry-run` passes. Only a run
 * with a real key gets far enough to fail, and the only machine with a real key is the one
 * cutting the release.
 *
 * Measured, with a throwaway key generated here: the old path crashed, the current one prints
 * "issuer key baked". So the release would have failed at the stamp, loudly, on the day.
 *
 * This drives the script with a key that is real but disposable, against a COPY of the built
 * file, then puts the original back. It never touches the checked-in source and never writes a
 * key anybody could use.
 */

const SCRIPT = join(REPO_ROOT, 'scripts', 'stamp-issuer-key.mjs');
const TARGET = join(REPO_ROOT, 'server', 'dist', 'features', 'license', 'license.js');

function run(env: Record<string, string>): { out: string; code: number } {
  try {
    const out = execFileSync('node', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (thrown) {
    const e = thrown as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? -1 };
  }
}

describe('the issuer key can actually be stamped into the built server', () => {
  it('finds the built file the release writes into', () => {
    // Without this the test below could pass by never reaching the write at all, which is the
    // exact failure it exists to catch.
    expect(readFileSync(TARGET, 'utf8').length).toBeGreaterThan(0);
  });

  it('leaves eval mode alone when no key is supplied, without touching the file', () => {
    const before = readFileSync(TARGET, 'utf8');
    const { out } = run({ RETICLE_ISSUER_PUBLIC_KEY: '' });
    expect(out).toContain('eval mode');
    expect(readFileSync(TARGET, 'utf8')).toBe(before);
  });

  it('bakes a real key into the real path', () => {
    const backup = `${TARGET}.stamp-test-backup`;
    copyFileSync(TARGET, backup);
    try {
      const { publicKey } = generateKeyPairSync('ed25519');
      const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const { out, code } = run({ RETICLE_ISSUER_PUBLIC_KEY: pem });
      expect(code, out).toBe(0);
      expect(out).toContain('issuer key baked');
      expect(readFileSync(TARGET, 'utf8')).toContain('BEGIN PUBLIC KEY');
    } finally {
      // Put the unstamped build back, so a later `pnpm pack` cannot ship a throwaway key.
      writeFileSync(TARGET, readFileSync(backup, 'utf8'));
      execFileSync('rm', ['-f', backup]);
    }
  });

  it('refuses something that is not a key, before it reaches the artifact', () => {
    const before = readFileSync(TARGET, 'utf8');
    const { out } = run({ RETICLE_ISSUER_PUBLIC_KEY: 'not-a-key' });
    expect(out).toContain('not a valid ed25519 public key');
    expect(readFileSync(TARGET, 'utf8')).toBe(before);
  });
});
