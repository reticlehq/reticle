import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The browser SDK must not reach into core's Node-side plumbing.
 *
 * `@reticlehq/core` is the contract, but its root entry point re-exports everything it has —
 * including the on-disk and registry formats the CLI and bridge own (the journal, the intent ledger,
 * run context, the daemon/dev-server/project registries, the self-update policy, instrumentation
 * gaps). Those live behind `@reticlehq/core/artifacts`. Nothing that runs in a page has any business
 * importing one, and until this test existed the boundary was a comment in core's index.ts.
 *
 * The forbidden list is READ from core's source at test time, not copied here, so adding a name to
 * the artifacts group extends the guard without anyone remembering to update it.
 */

// Asked rather than counted: a count of `..` up to the root is a statement about how deep this
// package sits, and it moved. Git already knows where the repository starts.
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: __dirname,
  encoding: 'utf8',
}).trim();
const CORE_SRC = join(REPO_ROOT, 'packages', 'core', 'src');
const ARTIFACTS_ENTRY = 'artifacts-entry.ts';
const CORE_SPECIFIER = '@reticlehq/core';
const TS_EXTENSION = '.ts';
const TEST_SUFFIX = '.test.ts';

/** `export * from './daemon-registry.js';` -> `daemon-registry` */
const RE_ENTRY_MODULE = /export \* from '\.\/([a-z0-9-]+)\.js';/g;
/** every named production export of a module in the group */
const RE_EXPORTED_NAME =
  /^export (?:declare )?(?:const|function|type|interface|class|enum) ([A-Za-z0-9_]+)/gm;
/** an import statement whose specifier is exactly the core root entry point */
const RE_CORE_IMPORT = new RegExp(
  `import(?:\\s+type)?\\s*\\{([^}]*)\\}\\s*from\\s*'${CORE_SPECIFIER}'`,
  'g',
);

function artifactsGroupNames(): ReadonlySet<string> {
  const entry = readFileSync(join(CORE_SRC, ARTIFACTS_ENTRY), 'utf8');
  const names = new Set<string>();
  for (const [, moduleName] of entry.matchAll(RE_ENTRY_MODULE)) {
    if (moduleName === undefined) continue;
    const source = readFileSync(join(CORE_SRC, `${moduleName}${TS_EXTENSION}`), 'utf8');
    for (const [, exported] of source.matchAll(RE_EXPORTED_NAME)) {
      if (exported !== undefined) names.add(exported);
    }
  }
  return names;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(TS_EXTENSION) && !entry.name.endsWith(TEST_SUFFIX))
      found.push(path);
  }
  return found;
}

/** `file -> the artifacts-group names it imports from the core root entry point` */
function violations(forbidden: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(__dirname)) {
    const source = readFileSync(file, 'utf8');
    for (const [, clause] of source.matchAll(RE_CORE_IMPORT)) {
      if (clause === undefined) continue;
      for (const raw of clause.split(',')) {
        const name = raw
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name !== undefined && name.length > 0 && forbidden.has(name)) {
          found.push(`${file.slice(__dirname.length + 1)}: ${name}`);
        }
      }
    }
  }
  return found.sort();
}

describe('browser does not import core artifact formats', () => {
  it('reads a non-empty artifacts group from core', () => {
    expect(artifactsGroupNames().size).toBeGreaterThan(0);
  });

  it('imports no on-disk or registry format from the core root entry point', () => {
    expect(violations(artifactsGroupNames())).toEqual([]);
  });
});
