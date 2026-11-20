/**
 * The defect this guards: 3.10.3 changed `open-verification` (a zod-free `channel-id.ts` and
 * `sideEffects: false`) and kept its version at 1.1.0. `pnpm -r publish` skips a version already on
 * npm, so the release shipped the OLD 1.1.0, `@reticlehq/core@3.10.3` pinned it, and every page that
 * installed the SDK from npm loaded zod again: 330 KB on the first load where the repository build
 * measured 221 KB. `check-unbumped-packages.mjs` compared only DEPENDENCIES, and those had not changed.
 * It now also compares the packed FILES, through `contentDifferences`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { contentDifferences } from '../../../../scripts/check-unbumped-packages.mjs';
import { removeTempDirSync } from '@/machine/temp-dir.test-helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    removeTempDirSync(dir);
  }
});

function packageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-unbumped-'));
  dirs.push(dir);
  return dir;
}

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const MANIFEST = { name: 'open-verification', version: '1.1.0', type: 'module' };

describe('the packed content of a package already on npm', () => {
  it('finds no difference when the files are the same', () => {
    const npm = packageDir();
    const local = packageDir();
    put(npm, 'package.json', JSON.stringify(MANIFEST));
    put(local, 'package.json', JSON.stringify(MANIFEST));
    put(npm, 'dist/index.js', 'export * from "./vocabulary/channel.js";\n');
    put(local, 'dist/index.js', 'export * from "./vocabulary/channel.js";\n');
    expect(contentDifferences(npm, local)).toEqual([]);
  });

  it('names a file whose bytes changed, and a file only one side has', () => {
    const npm = packageDir();
    const local = packageDir();
    put(npm, 'package.json', JSON.stringify(MANIFEST));
    put(local, 'package.json', JSON.stringify(MANIFEST));
    put(npm, 'dist/index.js', 'export * from "./vocabulary/channel.js";\n');
    put(local, 'dist/index.js', 'export * from "./vocabulary/channel-id.js";\n');
    put(local, 'dist/vocabulary/channel-id.js', 'export const ChannelId = {};\n');
    expect(contentDifferences(npm, local)).toEqual([
      'dist/index.js: changed',
      'dist/vocabulary/channel-id.js: only in this tree',
    ]);
  });

  it('reads package.json as data, so key order and spacing are not a change', () => {
    const npm = packageDir();
    const local = packageDir();
    put(
      npm,
      'package.json',
      JSON.stringify({ version: '1.1.0', name: 'open-verification', type: 'module' }),
    );
    put(local, 'package.json', `${JSON.stringify(MANIFEST, null, 2)}\n`);
    expect(contentDifferences(npm, local)).toEqual([]);
  });

  it('names a package.json field that changed', () => {
    const npm = packageDir();
    const local = packageDir();
    put(npm, 'package.json', JSON.stringify(MANIFEST));
    put(local, 'package.json', JSON.stringify({ ...MANIFEST, sideEffects: false }));
    expect(contentDifferences(npm, local)).toEqual(['package.json: changed']);
  });
});
