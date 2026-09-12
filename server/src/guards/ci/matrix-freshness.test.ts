/**
 * `docs/matrix/MATRIX.md` must not read as current when its records are not.
 *
 * The matrix holds MCP-client records for **2.5.0 only**, and the repo ships 2.13.1 — eight minor
 * releases, every one of them able to move the config path, the entry shape or the tool count that
 * those rows are about. `matrix.mjs --validate` checks records that EXIST, so a version with no
 * records at all is indistinguishable from a version nobody has submitted for; there is no shape of
 * missing data for it to reject. Meanwhile the page publishes to users under a heading that says
 * what works, with no year attached.
 *
 * Client compatibility cannot be manufactured from this repository — a record is somebody running a
 * GUI client on their own machine, and inventing one is exactly the self-report the whole flow
 * exists to replace. So this guard does not ask for data. It asks for one of two honest things:
 *
 *   1. `docs/matrix/<current minor>.x/` has at least one record, or
 *   2. `MATRIX.md` states the gap in its own text, naming both versions.
 *
 * Either way a release cannot quietly ship a matrix that is eight versions behind. And because
 * `apps/e2e/matrix.mjs` regenerates `MATRIX.md` without knowing about the banner, regenerating
 * deletes it and this reddens again — which is the intended cost of republishing stale rows.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

const REPO = REPO_ROOT;
const MATRIX_DIR = join(REPO, 'docs', 'matrix');
const MATRIX = join(MATRIX_DIR, 'MATRIX.md');

/** The version every published package shares, from the root manifest. */
const currentVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const version = (pkg as { version?: unknown }).version;
  if ('string' !== typeof version) throw new Error('root package.json has no version');
  return version;
};

/** `2.13.1` → `2.13`. Records are per release, but a patch does not invalidate one. */
const minor = (version: string): string => version.split('.').slice(0, 2).join('.');

/** Every `docs/matrix/<version>/` that holds at least one record, newest first. */
const recordVersions = (): string[] =>
  readdirSync(MATRIX_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => readdirSync(join(MATRIX_DIR, e.name)).some((f) => f.endsWith('.json')))
    .map((e) => e.name)
    .sort()
    .reverse();

/**
 * The banner, machine-checkable on purpose: it has to name the version the records came from AND the
 * version shipping now. A sentence saying only "these may be out of date" ages into a lie the same
 * way the table does, and cannot be checked at all.
 */
const BANNER =
  /\*\*Records below are from ([0-9][^.]*\.[^.]*\.[^*]*)\. This release is ([^*]+)\.\*\*/;

describe('the client matrix does not present stale records as current', () => {
  it('has records for the shipping minor, or says in MATRIX.md which version they are from', () => {
    const current = currentVersion();
    const versions = recordVersions();
    if (versions.some((v) => minor(v) === minor(current))) return;

    const newest = versions[0] ?? 'no version at all';
    const banner = BANNER.exec(readFileSync(MATRIX, 'utf8'));

    expect(
      null === banner ? null : { from: banner[1], release: banner[2] },
      `docs/matrix/ has no client record for ${minor(current)}.x (newest records: ${newest}), and ` +
        `MATRIX.md does not say so. It publishes to users as the answer to "does Reticle work in ` +
        `my client", with no version attached to any row. Submit a record for this release ` +
        `(docs/matrix/README.md, about three minutes with a real client), or state the gap in ` +
        `MATRIX.md as: **Records below are from ${newest}. This release is ${current}.**`,
    ).toEqual({ from: newest, release: current });
  });
});
