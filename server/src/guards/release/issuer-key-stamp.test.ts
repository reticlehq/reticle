import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

/**
 * Runs the stamp and keeps stdout and stderr APART.
 *
 * They used to be concatenated, so a test asserting the eval-mode message could not tell which
 * stream carried it — and the script wrote it to stdout, which is what `npm pack --json` parses.
 * Release tooling reading that JSON got a line of prose before the array and could not parse it.
 * The same defect was found and fixed in open-verification's prepack earlier in this release.
 */
function run(env: Record<string, string>): { out: string; err: string; code: number } {
  /*
   * spawnSync, not execFileSync: the latter returns only stdout, and on a SUCCESSFUL run it hands
   * back no stderr at all — so a test asking "was this said on the right stream" could not see the
   * answer in the case that matters most, the one that exits 0.
   *
   * The inherited environment is stripped of any key this call overrides, COMPARED CASE-INSENSITIVELY,
   * before the overrides go on. `process.env` reads are case-insensitive on Windows but a spread is
   * not, so `{ ...process.env, npm_command: 'publish' }` can produce BOTH `NPM_COMMAND` (whatever the
   * package manager set) and `npm_command` (what this test wants) in one object, and the child
   * resolves that ambiguously. It cost a red Windows job: the refusal below exited 0 there and 1
   * everywhere else, which reads as "the script is broken on Windows" and was really "the test asked
   * an ambiguous question".
   */
  const overrides = Object.keys(env).map((k) => k.toLowerCase());
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !overrides.includes(k.toLowerCase())),
  );
  const r = spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    env: { ...inherited, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1 };
}

describe('the issuer key can actually be stamped into the built server', () => {
  it('finds the built file the release writes into', () => {
    // Without this the test below could pass by never reaching the write at all, which is the
    // exact failure it exists to catch.
    expect(readFileSync(TARGET, 'utf8').length).toBeGreaterThan(0);
  });

  it('leaves eval mode alone when no key is supplied, without touching the file', () => {
    const before = readFileSync(TARGET, 'utf8');
    const { out, err, code } = run({ RETICLE_ISSUER_PUBLIC_KEY: '' });
    expect(err).toContain('eval mode');
    // Nothing on stdout, ever: `npm pack --json` parses that stream.
    expect(out).toBe('');
    expect(code).toBe(0);
    expect(readFileSync(TARGET, 'utf8')).toBe(before);
  });

  it('REFUSES a real publish with no key, and says what the artifact would have been', () => {
    // The tarball would look normal and ship with enterprise enforcement off: every customer key
    // activates nothing, and neither the runtime nor any gate reports it. A laptop `pnpm -r publish`
    // produced exactly that, silently, and RELEASING.md never mentioned the variable.
    const before = readFileSync(TARGET, 'utf8');
    const { err, code } = run({ RETICLE_ISSUER_PUBLIC_KEY: '', npm_command: 'publish' });
    expect(code).toBe(1);
    expect(err).toContain('refusing to publish');
    expect(readFileSync(TARGET, 'utf8')).toBe(before);
  });

  it('allows a publish to a LOCAL registry — this is what gate:install does', () => {
    /*
     * The regression this exists to prevent, and it was mine.
     *
     * The refusal above first asked only "is this a publish", and `gate:install` publishes the whole
     * checkout to a Verdaccio on localhost so that `init` resolves dependencies the way a user would.
     * That is a real `pnpm -r publish`, so all TWENTY matrix cells went red at once — on a change
     * whose local verification had passed, because nothing locally performs a publish.
     *
     * The question a release guard must ask is not "is this a publish" but "is this a publish
     * somebody can install from". A scratch registry on loopback is not one.
     */
    expect(
      run({
        RETICLE_ISSUER_PUBLIC_KEY: '',
        npm_command: 'publish',
        npm_config_registry: 'http://localhost:4873/',
      }).code,
    ).toBe(0);
    // ...while a real registry, and the absent-registry default (which IS npmjs), still refuse.
    expect(
      run({
        RETICLE_ISSUER_PUBLIC_KEY: '',
        npm_command: 'publish',
        npm_config_registry: 'https://registry.npmjs.org/',
      }).code,
    ).toBe(1);
  });

  it('still allows a dry run, a plain build, and a deliberate eval-mode publish', () => {
    // The refusal must not block the three things that are legitimately keyless, or it gets worked
    // around and stops meaning anything.
    expect(
      run({ RETICLE_ISSUER_PUBLIC_KEY: '', npm_command: 'publish', npm_config_dry_run: 'true' })
        .code,
    ).toBe(0);
    expect(run({ RETICLE_ISSUER_PUBLIC_KEY: '' }).code).toBe(0);
    expect(
      run({
        RETICLE_ISSUER_PUBLIC_KEY: '',
        npm_command: 'publish',
        RETICLE_ALLOW_EVAL_PUBLISH: '1',
      }).code,
    ).toBe(0);
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
      // `rmSync`, not `execFileSync('rm')`: there is no `rm` on a Windows runner, so the cleanup
      // threw INSIDE a finally block and replaced whatever the test was reporting.
      rmSync(backup, { force: true });
    }
  });

  it('refuses something that is not a key, before it reaches the artifact', () => {
    const before = readFileSync(TARGET, 'utf8');
    const { err } = run({ RETICLE_ISSUER_PUBLIC_KEY: 'not-a-key' });
    expect(err).toContain('not a valid ed25519 public key');
    expect(readFileSync(TARGET, 'utf8')).toBe(before);
  });
});
