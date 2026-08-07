#!/usr/bin/env node
// Lossy-transform guard for the Reticle read path.
//
// THE INVARIANT
//
//   Any transform that can drop, truncate, or shape-coerce data on a path an agent reads must
//   report that it did, in a machine-readable way the consumer can detect.
//
// The consumer is an agent deciding whether a green verdict is trustworthy. A partial answer it
// cannot distinguish from a complete one is a false green — the failure this whole project exists to
// prevent. A note in a log, or a value quietly shortened with nothing to say so, is not a report.
//
// WHY A GUARD AND NOT DISCIPLINE
//
// The rule was broken three separate times, each found by hand and fixed in isolation: the ring
// buffer dropped events so an agent got a confident false negative; the offline queue dropped events
// during a bridge blip while the ledger still read clean; capDepth coerced a Map to `{}` with no
// marker, immediately upstream of the one function that gets this right. Three instances of one
// shape is a missing invariant, not three bugs.
//
// WHAT THIS CATCHES, AND WHAT IT HONESTLY DOES NOT
//
// Catches: a NEW export appearing in a read-path module without anybody classifying it, and a
// classified-lossy export with no conformance test naming it. That is the moment someone who has
// never heard of this rule is made to answer the question, which is the entire value.
//
// Does NOT catch: a newly-lossy BRANCH added inside a function already listed here. Nothing textual
// can. Stated so nobody mistakes a green guard for a proof.
//
// Usage:
//   node scripts/check-lossy-transforms.mjs            # check the real tree; exit 1 on drift
//   node scripts/check-lossy-transforms.mjs --self-test # prove the guard fails on a synthetic gap
//
// Wired into `pnpm lint`, so drift fails the build. See CONTRIBUTING.md ("Lossy transforms declare
// their loss") and packages/*/src/**/lossy-conformance.test.ts for the behavioural half.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * How a transform declares what it removed. Four legitimate styles, because the read path carries
 * four different kinds of payload and a report cannot always ride beside the value.
 */
export const Declaration = Object.freeze({
  /** A machine-readable field travelling BESIDE the value. The strongest form; prefer it. */
  REPORT: 'report',
  /** An unambiguous in-band sentinel the consumer can detect, where the value's shape must survive. */
  MARKER: 'marker',
  /** Announced on the event stream or a health surface rather than beside any one value. */
  SIGNAL: 'signal',
  /** Not lossy. Types, registration helpers, predicates. */
  NONE: 'none',
  /** KNOWN undeclared loss, accepted with a written reason. Every one of these is a real gap. */
  SILENT: 'silent',
});

const LOSSY = new Set([Declaration.REPORT, Declaration.MARKER, Declaration.SIGNAL]);

/**
 * The read path: the modules whose output an agent reads to reach a verdict, and the classification
 * of every export in them.
 *
 * Scope is deliberately the STATE/READ path rather than everything that can drop a byte. That is
 * where all three known instances landed and where a silent loss most directly produces a wrong
 * verdict. Snapshot/query truncation and the visual path are a second pass, not this one.
 *
 * To add a module here, list EVERY export. An unlisted export fails the guard, which is the point.
 */
export const READ_PATH = Object.freeze({
  'packages/browser/src/security/serialization.ts': {
    TruncationReport: [Declaration.NONE, 'the report type itself'],
    isSensitiveKey: [Declaration.NONE, 'predicate; reports whether a key should be redacted'],
    scrubKnownSecrets: [
      Declaration.MARKER,
      'replaces recognized secret shapes with the unambiguous REDACTED_VALUE sentinel',
    ],
    sanitizeWithReport: [
      Declaration.REPORT,
      'the reference implementation — returns { value, truncation? } so a caller cannot mistake a fraction for the whole',
    ],
    sanitizeForTransport: [
      Declaration.SILENT,
      'convenience wrapper that DISCARDS the report. Kept for callers whose payload is bounded by construction; anything on the read path must use sanitizeWithReport instead',
    ],
    safeStringify: [
      Declaration.SILENT,
      'wraps sanitizeForTransport and so inherits its dropped report, and additionally collapses a throwing value to "[UNSERIALIZABLE]". Log/diagnostic use only',
    ],
  },
  'packages/core/src/state-select.ts': {
    PathSelection: [Declaration.NONE, 'the selection result type'],
    selectPath: [
      Declaration.REPORT,
      'a miss returns { found:false, availableKeys } and, when that key list is a SAMPLE, totalKeys beside it',
    ],
    capDepth: [
      Declaration.MARKER,
      'collapses past the budget to a sized sentinel — "[Array(5)]", "{…3 keys}", "[Set(2)]", "{Map(3)}". In-band because the caller asked for a depth cap and the value shape has to survive it',
    ],
  },
  'packages/browser/src/registry/stores.ts': {
    StoreGetter: [Declaration.NONE, 'type'],
    StoreSubscribe: [Declaration.NONE, 'type'],
    StoreRegisteredListener: [Declaration.NONE, 'type'],
    StoreLike: [Declaration.NONE, 'type'],
    onStoreRegistered: [Declaration.NONE, 'registration, reads nothing'],
    registerStore: [Declaration.NONE, 'registration, reads nothing'],
    unregisterStore: [Declaration.NONE, 'registration, reads nothing'],
    storeNames: [Declaration.NONE, 'names only, never truncated'],
    subscribableStores: [Declaration.NONE, 'registry projection, never truncated'],
    readStoresRaw: [
      Declaration.NONE,
      'deliberately UNCAPPED — it exists so a scoped read selects before the caps apply',
    ],
    readStores: [
      Declaration.SILENT,
      "convenience wrapper that DROPS readStoresWithTruncation's report. Every read-path caller uses the reporting form",
    ],
    readStoresWithTruncation: [
      Declaration.REPORT,
      'returns { stores, truncation? } keyed by store name, so a 1,000-entity store that came back as 142 says so',
    ],
  },
  'packages/browser/src/transport/transport.ts': {
    CommandOutcome: [Declaration.NONE, 'type'],
    MAX_QUEUE: [Declaration.NONE, 'the bound itself, exported so tests overflow the real one'],
    Transport: [
      Declaration.SIGNAL,
      'a full offline queue evicts its oldest events and then emits TRANSPORT_OVERFLOW { dropped } to the bridge, so the gap is declared on the stream it happened to',
    ],
  },
  'packages/server/src/events/ring-buffer.ts': {
    RingBuffer: [
      Declaration.SIGNAL,
      'eviction is counted and surfaced by bufferHealth() as { total, dropped }, which session health and act summaries read to mark a window truncated',
    ],
  },
  'packages/core/src/toon.ts': {
    ToonElement: [Declaration.NONE, 'type'],
    toToon: [
      Declaration.MARKER,
      'a container whose children are not expanded carries count=N on its own line, so a collapsed subtree states its size',
    ],
    resultToToon: [
      Declaration.MARKER,
      'delegates to toToon; non-element results pass through as JSON',
    ],
    isToonable: [Declaration.NONE, 'predicate'],
  },
});

/**
 * Where each lossy transform's loss is PROVEN — the behavioural half of the invariant.
 *
 * Two of these predate the registry. `Transport` and `RingBuffer` each already had a suite whose
 * whole subject was the declared gap, written when the drop was found by hand; pointing at them
 * beats copying them, and a registry that forced a duplicate would be teaching the wrong lesson. The
 * two `lossy-conformance` files cover the transforms that had no such suite.
 */
export const CONFORMANCE_TESTS = Object.freeze([
  'packages/core/src/lossy-conformance.test.ts',
  'packages/browser/src/security/lossy-conformance.test.ts',
  'packages/browser/src/security/serialization.test.ts',
  'packages/browser/src/transport/transport.overflow-marker.test.ts',
  'packages/server/src/events/ring-buffer.test.ts',
]);

/** Every top-level export name in a TypeScript source, read as text. */
export function exportedNames(source) {
  const names = new Set();
  const declarationPattern =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  let match;
  while ((match = declarationPattern.exec(source)) !== null) names.add(match[1]);

  const namedPattern = /^export\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:from\s+['"][^'"]+['"]\s*)?;?/gm;
  while ((match = namedPattern.exec(source)) !== null) {
    const specifiers = match[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .split(',')
      .map((specifier) => specifier.trim())
      .filter(Boolean);
    for (const specifier of specifiers) {
      const normalized = specifier.replace(/^type\s+/, '');
      const parts = normalized.split(/\s+as\s+/);
      const exported = parts.at(-1);
      if (exported === undefined || !/^[A-Za-z_$][\w$]*$/.test(exported)) {
        throw new Error(`unsupported export specifier: ${specifier}`);
      }
      names.add(exported);
    }
  }

  const namespacePattern = /^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"]\s*;?/gm;
  while ((match = namespacePattern.exec(source)) !== null) names.add(match[1]);

  if (/^export\s+\*\s+from\s+['"][^'"]+['"]\s*;?/m.test(source)) {
    throw new Error('bare export * re-export cannot be classified without resolving its source');
  }

  if (/^export\s+default\b/m.test(source)) names.add('default');

  return [...names];
}

/**
 * Compare the registry against the tree.
 * @returns {Array<{file: string, name?: string, reason: string}>}
 */
export function findDrift(readPath, readSource, conformanceSources) {
  const problems = [];
  const testText = conformanceSources.join('\n');

  for (const [file, entries] of Object.entries(readPath)) {
    const source = readSource(file);
    if (source === null) {
      problems.push({ file, reason: 'listed in the registry but not found on disk' });
      continue;
    }
    const actual = exportedNames(source);
    for (const name of actual) {
      if (!Object.hasOwn(entries, name)) {
        problems.push({
          file,
          name,
          reason:
            'exported from a read-path module but not classified. Add it to READ_PATH: does it drop, truncate or shape-coerce anything an agent reads, and if so how does it say so?',
        });
      }
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (!actual.includes(name)) {
        problems.push({ file, name, reason: 'classified in the registry but no longer exported' });
        continue;
      }
      const [declaration, note] = entry;
      if (!Object.values(Declaration).includes(declaration)) {
        problems.push({ file, name, reason: `unknown declaration style "${declaration}"` });
      }
      if (typeof note !== 'string' || note.length === 0) {
        problems.push({ file, name, reason: 'classified with no reason written down' });
      }
      // A lossy transform nobody tests is a registry entry, not an invariant.
      if (LOSSY.has(declaration) && !testText.includes(name)) {
        problems.push({
          file,
          name,
          reason: `declared ${declaration} but named in no conformance test — add a fixture that guarantees loss and assert the loss is declared`,
        });
      }
    }
  }
  return problems;
}

function readFromDisk(file) {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** In-memory proof that the guard catches real drift — an unproven guard is its own false green. */
function selfTest() {
  const registry = {
    'fake/mod.ts': {
      declared: [Declaration.REPORT, 'returns a report'],
      ghost: [Declaration.NONE, 'no longer exported'],
      noReason: [Declaration.MARKER, ''],
      badStyle: ['whispered', 'not a declaration style'],
      untested: [Declaration.MARKER, 'lossy but named in no test'],
    },
    'fake/missing.ts': { anything: [Declaration.NONE, 'file is not on disk'] },
  };
  const source = [
    'export function declared() {}',
    'export function noReason() {}',
    'export function badStyle() {}',
    'export function untested() {}',
    'export function unclassified() {}',
    'function named() {}',
    'function localAlias() {}',
    'function defaultExport() {}',
    'export { named };',
    'export { localAlias as aliased };',
    'export default defaultExport;',
  ].join('\n');
  const problems = findDrift(registry, (file) => (file === 'fake/mod.ts' ? source : null), [
    'expect(declared()).toBeDefined(); noReason(); badStyle();',
  ]);
  const got = problems.map((p) => `${p.name ?? '-'}:${p.reason.slice(0, 24)}`);
  const expected = [
    ['unclassified', 'a new export must be classified'],
    ['ghost', 'a removed export must be flagged'],
    ['noReason', 'a classification with no reason must be flagged'],
    ['badStyle', 'an unknown declaration style must be flagged'],
    ['untested', 'a lossy export with no conformance test must be flagged'],
    ['named', 'a named export must be classified'],
    ['aliased', 'an aliased export must use its exported name'],
    ['default', 'a default export must be classified'],
    [undefined, 'a registry file missing from disk must be flagged'],
  ];
  const missing = expected.filter(([name]) =>
    name === undefined
      ? !problems.some((p) => p.file === 'fake/missing.ts')
      : !problems.some((p) => p.name === name),
  );
  let starReexportFailed = false;
  try {
    exportedNames("export * from './helpers.js';");
  } catch (error) {
    starReexportFailed = error instanceof Error && error.message.includes('export *');
  }
  if (missing.length > 0 || !starReexportFailed) {
    if (!starReexportFailed) missing.push(['*', 'a bare star re-export must fail loudly']);
    console.error('self-test FAILED — guard missed:', missing.map(([, why]) => why).join('; '));
    process.exit(1);
  }
  console.log(
    'lossy-transform guard self-test passed (%d synthetic problems caught: %s)',
    problems.length,
    got.length,
  );
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const conformance = CONFORMANCE_TESTS.map((file) => readFromDisk(file) ?? '');
  const missingSuite = CONFORMANCE_TESTS.filter((file) => readFromDisk(file) === null);
  const problems = findDrift(READ_PATH, readFromDisk, conformance);
  for (const file of missingSuite) {
    problems.push({
      file,
      reason: 'conformance suite listed in CONFORMANCE_TESTS but not on disk',
    });
  }
  if (problems.length > 0) {
    console.error('Lossy-transform registry drift:\n');
    for (const p of problems) {
      console.error(`  ✗ ${p.file}${p.name === undefined ? '' : ` → ${p.name}`}\n    ${p.reason}`);
    }
    console.error(
      `\n${problems.length} problem(s). The rule: a transform that drops, truncates or shape-coerces` +
        '\ndata an agent reads must report that it did. See scripts/check-lossy-transforms.mjs.',
    );
    process.exit(1);
  }
  const counted = Object.values(READ_PATH).reduce((n, e) => n + Object.keys(e).length, 0);
  console.log(
    'Lossy transforms OK (%d exports classified across %d read-path modules).',
    counted,
    Object.keys(READ_PATH).length,
  );
}

// Only run when invoked directly, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
