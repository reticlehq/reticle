#!/usr/bin/env node
/**
 * Stamp the enterprise issuer PUBLIC key into the built server. Runs from `@reticlehq/server`'s
 * `prepack`, which is the ONLY safe place for it: prepack does `rm -rf dist && tsc -b --force`, so a
 * stamp applied any earlier in the release job is deleted and rebuilt away, and the artifact that
 * reaches npm has an empty key with nothing having failed. That is not hypothetical — the first version
 * of this script ran as a separate step before `pnpm publish` and packed an unstamped tarball.
 *
 * The gate reads `BAKED_ISSUER_PUBLIC_KEY_PEM` in preference to the environment precisely so a
 * self-hosted operator cannot switch enforcement off by never setting an env var. That only works if a
 * release actually has the key baked. A release that ships with the literal still empty resolves no
 * issuer key at all, so in production `assertEnterpriseFromEnv` denies every enterprise feature with
 * `enterprise-gate-unconfigured` and every customer key activates NOTHING. This script is the step that
 * makes the shipped artifact different from the source tree.
 *
 *   RETICLE_ISSUER_PUBLIC_KEY="$(cat issuer-public.pem)" node scripts/stamp-issuer-key.mjs
 *
 * Runs only when the env var is set: a normal `pnpm build` in a checkout stamps nothing and stays in
 * eval mode, which is what keeps contributors and CI unblocked.
 *
 * The public key is safe to ship openly and safe to hold in a CI secret — it can only VERIFY licenses,
 * never mint them. Minting needs the private key, which lives in a vault and never touches this repo.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolved from this file, not the cwd: the stamp runs from server (prepack) as well as from
// the repo root, and a cwd-relative path would silently miss in one of them.
const TARGET = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../server/dist/features/license/license.js',
);
/** Must match the declaration in license.ts verbatim. A rename here fails loudly rather than no-oping. */
const EMPTY_DECLARATION = "const BAKED_ISSUER_PUBLIC_KEY_PEM = '';";

/**
 * Is this run putting a tarball on a REAL registry, as opposed to a build, a dry run, or a test?
 *
 * npm and pnpm both set `npm_command` for the invoked command, `npm_config_dry_run` for `--dry-run`,
 * and `npm_config_registry` for `--registry`. A plain `pnpm build` sets none of them.
 *
 * The registry check is the one that is easy to leave out, and leaving it out broke `gate:install`
 * on every one of its twenty matrix cells: that gate publishes this whole checkout to a Verdaccio on
 * localhost so `init` resolves dependencies the way a user would, which is a real `pnpm -r publish`
 * and is not a release. The danger being guarded against is an unstamped artifact reaching people —
 * so the question is not "is this a publish" but "is this a publish somebody can install from".
 * A scratch registry on loopback is neither.
 */
function isLoopbackRegistry(url) {
  if (url === undefined || url.length === 0) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

const isRealPublish =
  process.env.npm_command === 'publish' &&
  process.env.npm_config_dry_run !== 'true' &&
  !isLoopbackRegistry(process.env.npm_config_registry);

const pem = process.env.RETICLE_ISSUER_PUBLIC_KEY;
if (pem === undefined || pem.length === 0) {
  /*
   * A PUBLISH with no key is refused; every other run is fine and says so.
   *
   * Eval mode is correct for a contributor's build and for CI, and that is what keeps this script
   * from simply requiring the variable. It is not correct for a tarball going to the registry: the
   * artifact looks normal, every gate is green, and enterprise keys activate nothing for anyone who
   * installs it. The release workflow sets the variable; a laptop `pnpm -r publish` does not, and
   * nothing anywhere said so — RELEASING.md names `pnpm -r publish --dry-run` as an authority and
   * never mentions the key.
   *
   * `RETICLE_ALLOW_EVAL_PUBLISH=1` is the deliberate override, for a release that is meant to ship
   * without enterprise enforcement. It has to be typed, which is the whole point.
   */
  if (isRealPublish && process.env.RETICLE_ALLOW_EVAL_PUBLISH !== '1') {
    process.stderr.write(
      'stamp-issuer-key: refusing to publish without RETICLE_ISSUER_PUBLIC_KEY.\n' +
        '  The tarball would ship in eval mode: enterprise licence keys would activate nothing,\n' +
        '  and nothing at runtime or in any gate would report it. Publish through the release\n' +
        '  workflow, which supplies the key, or set RETICLE_ALLOW_EVAL_PUBLISH=1 to mean it.\n',
    );
    process.exit(1);
  }
  // stderr, not stdout: `npm pack --json` parses stdout, and a line of prose here makes the output
  // unparseable for any release tooling that reads it. The same defect was found and fixed in
  // openreality's prepack earlier in this release; this is the second copy of it.
  process.stderr.write('stamp-issuer-key: RETICLE_ISSUER_PUBLIC_KEY unset, leaving eval mode\n');
  process.exit(0);
}

// Reject anything that is not a real spki public key BEFORE it reaches a published artifact. A typo, a
// truncated secret, or a private key pasted by mistake all fail identically at runtime (eval mode, gate
// off) and are invisible until a customer reports their key does nothing.
try {
  const parsed = createPublicKey(pem);
  if (parsed.asymmetricKeyType !== 'ed25519') {
    throw new Error(`expected an ed25519 key, got ${parsed.asymmetricKeyType}`);
  }
} catch (error) {
  process.stderr.write(
    `stamp-issuer-key: RETICLE_ISSUER_PUBLIC_KEY is not a valid ed25519 public key: ${error.message}\n`,
  );
  process.exit(1);
}
if (pem.includes('PRIVATE KEY')) {
  process.stderr.write(
    'stamp-issuer-key: refusing to stamp a PRIVATE key into a published artifact\n',
  );
  process.exit(1);
}

const source = readFileSync(TARGET, 'utf8');
if (!source.includes(EMPTY_DECLARATION)) {
  process.stderr.write(
    `stamp-issuer-key: ${TARGET} does not contain the expected declaration\n` +
      `  looked for: ${EMPTY_DECLARATION}\n` +
      '  The literal was renamed, already stamped, or the build did not run. Refusing to publish a\n' +
      '  release whose enterprise gate would be silently off.\n',
  );
  process.exit(1);
}

const stamped = source.replace(
  EMPTY_DECLARATION,
  `const BAKED_ISSUER_PUBLIC_KEY_PEM = ${JSON.stringify(pem)};`,
);
writeFileSync(TARGET, stamped);

// Prove the stamp took, against the real module rather than the string we just wrote. With a key baked
// and no customer key present, activation must read `missing` (enforcement ON). If it still reads
// `eval`, the gate is off and this release must not ship.
// `pathToFileURL`, not the bare path: ESM `import()` takes a URL, and an absolute Windows path
// (`D:\a\…\license.js`) is not one — the drive letter reads as a protocol and the loader throws
// before the check can run. The release gate then fails as "the stamp could not be verified" on a
// stamp that worked. Same conversion trap as `new URL(import.meta.url).pathname`.
const { describeLicense } = await import(pathToFileURL(TARGET).href);
const report = describeLicense(Date.now(), {});
if (report.status !== 'missing') {
  process.stderr.write(
    `stamp-issuer-key: post-stamp check failed — expected status "missing", got "${report.status}"\n`,
  );
  process.exit(1);
}
process.stdout.write('stamp-issuer-key: issuer key baked, enterprise gate enforcing\n');
