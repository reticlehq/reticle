// The client matrix: validate a submitted record, and generate MATRIX.md from everything submitted.
//
//   node apps/e2e/matrix.mjs --validate docs/matrix/<version>/<client>-<host>.json
//   node apps/e2e/matrix.mjs                 # regenerate docs/matrix/MATRIX.md
//   node apps/e2e/matrix.mjs --self-check    # prove the validator rejects what it should
//
// Modelled on CNCF's Kubernetes conformance flow, and for the same reason: a vendor does not CLAIM
// conformance, it runs a suite and submits the machine-generated output as a PR, which a bot checks
// before a human looks. Self-reported pass/fail cannot gate anything — it is unfalsifiable, it rots
// the moment somebody is in a hurry, and it puts the maintainer back in the loop as the person who
// has to decide whether to believe a paragraph.
//
// So a record here is EVIDENCE, not an assertion. Two halves, and the split is the honest part:
//
//   MACHINE (client-compat.mjs)  the entry init wrote is where the client documents it, parses under
//                                that client's own key, and the command inside it starts and
//                                advertises tools. Reproducible by anyone, no client installed.
//   HUMAN                        the client actually READS it: tools visible in that client's UI,
//                                and the link survives a daemon restart. Nothing short of running
//                                the real client shows this, and most of them are GUI apps.
//
// A record that carries only the machine half is `runnable-unverified`, and the matrix says so
// rather than rounding it up to a tick.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MATRIX_DIR = join(ROOT, 'docs/matrix');
const OUT = join(MATRIX_DIR, 'MATRIX.md');

/** The verdicts a record may carry. Closed, so a new one cannot arrive without a decision. */
export const Verdict = {
  /** The client reads it and the tools are usable. A human saw this. */
  WORKS: 'works',
  /** Machine-checkable half passed; nobody has run the real client. NOT a tick. */
  RUNNABLE_UNVERIFIED: 'runnable-unverified',
  /** init cannot write this client's config; the user pastes a block. */
  MANUAL_SNIPPET: 'manual-snippet',
  /** Someone ran it and it did not work. The most valuable record of the four. */
  BROKEN: 'broken',
};

const REQUIRED = ['reticle', 'client', 'host', 'checks', 'verdict'];

/**
 * Validate a submitted record.
 *
 * Deliberately strict about PROVENANCE rather than about outcome: a `broken` record is as welcome as
 * a `works` one and passes exactly the same checks. What is refused is a record that cannot be
 * placed — no version, no client, no host, no evidence — because a matrix cell nobody can trace back
 * to a machine and a commit is decoration.
 */
export function validateRecord(record) {
  const problems = [];
  for (const key of REQUIRED) {
    if (record?.[key] === undefined) problems.push(`missing '${key}'`);
  }
  if (problems.length > 0) return problems;

  if (typeof record.reticle.version !== 'string' || record.reticle.version === '') {
    problems.push('reticle.version must be a non-empty string');
  }
  if (typeof record.client.id !== 'string' || record.client.id === '') {
    problems.push('client.id must be a non-empty string');
  }
  if (!Object.values(Verdict).includes(record.verdict)) {
    problems.push(`verdict '${String(record.verdict)}' is not one of: ${Object.values(Verdict).join(', ')}`);
  }
  if (typeof record.host?.os !== 'string' || record.host.os === '') {
    problems.push('host.os must be a non-empty string — a cell nobody can place is decoration');
  }
  // The claim that needs evidence. `works` means a human saw the tools in that client; saying so
  // without the number is exactly the self-report this flow exists to replace.
  if (record.verdict === Verdict.WORKS) {
    const tools = record.checks?.toolsVisible;
    if (typeof tools !== 'number' || tools <= 0) {
      problems.push("verdict 'works' requires checks.toolsVisible > 0 — how many tools the client listed");
    }
  }
  // A failure with no error text cannot be acted on, and is the record most worth getting right.
  if (record.verdict === Verdict.BROKEN) {
    const text = record.checks?.clientError;
    if (typeof text !== 'string' || text.trim() === '') {
      problems.push("verdict 'broken' requires checks.clientError — the client's own words, verbatim");
    }
  }
  return problems;
}

function loadRecords() {
  if (!existsSync(MATRIX_DIR)) return [];
  const found = [];
  for (const version of readdirSync(MATRIX_DIR)) {
    const dir = join(MATRIX_DIR, version);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        found.push({ version, file, record: JSON.parse(readFileSync(join(dir, file), 'utf8')) });
      } catch {
        found.push({ version, file, record: null });
      }
    }
  }
  return found;
}

const MARK = {
  [Verdict.WORKS]: '✅',
  [Verdict.RUNNABLE_UNVERIFIED]: '◐',
  [Verdict.MANUAL_SNIPPET]: '✎',
  [Verdict.BROKEN]: '❌',
};

function render(entries) {
  const versions = [...new Set(entries.map((e) => e.version))].sort().reverse();
  const lines = [
    '# Client matrix',
    '',
    '> Which MCP clients Reticle is known to work in, and on whose machine that was measured.',
    '> Generated by `node apps/e2e/matrix.mjs`. Do not edit by hand.',
    '',
    '| | meaning |',
    '| --- | --- |',
    `| ${MARK[Verdict.WORKS]} | a human ran the real client and the tools were usable |`,
    `| ${MARK[Verdict.RUNNABLE_UNVERIFIED]} | \`init\` wrote a runnable entry where the client documents it, but **nobody has run that client** |`,
    `| ${MARK[Verdict.MANUAL_SNIPPET]} | \`init\` will not write this format (TOML); the user pastes a block |`,
    `| ${MARK[Verdict.BROKEN]} | somebody ran it and it did not work; the most useful row here |`,
    '',
    '**◐ is not a tick.** It means the half a machine can check passed. Only ✅ means somebody saw',
    'Reticle working in that client.',
    '',
  ];

  if (entries.length === 0) {
    lines.push('_No records submitted yet._', '');
    return lines.join('\n');
  }

  for (const version of versions) {
    const forVersion = entries.filter((e) => e.version === version);
    lines.push(`## ${version}`, '', '| client | verdict | tools | os | submitted by |', '| --- | --- | --- | --- | --- |');
    for (const { record } of forVersion.sort((a, b) =>
      String(a.record?.client?.id).localeCompare(String(b.record?.client?.id)),
    )) {
      if (record === null) continue;
      const mark = MARK[record.verdict] ?? '?';
      lines.push(
        `| ${record.client.id}${record.client.version ? ` ${record.client.version}` : ''} ` +
          `| ${mark} ${record.verdict} | ${record.checks?.toolsVisible ?? 'n/a'} | ${record.host?.os ?? 'n/a'} ` +
          `| ${record.by ?? 'n/a'} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── self-check ────────────────────────────────────────────────────────────────────────────────
// The validator is the only thing standing between "submitted evidence" and "somebody typed a tick",
// so it has to be shown refusing the shapes that matter.
function selfCheck() {
  const assert = (cond, msg) => {
    if (!cond) {
      console.error(`self-check FAILED: ${msg}`);
      process.exit(1);
    }
  };
  const base = {
    reticle: { version: '9.9.9', commit: 'abc123' },
    client: { id: 'cursor', version: '1.0' },
    host: { os: 'darwin', node: '22' },
    checks: {},
    verdict: Verdict.RUNNABLE_UNVERIFIED,
    by: 'someone',
  };
  assert(validateRecord(base).length === 0, 'a well-formed record must validate');
  assert(validateRecord({}).length > 0, 'an empty record must be rejected');
  assert(
    validateRecord({ ...base, verdict: 'great' }).length > 0,
    'an unknown verdict must be rejected — the list is closed on purpose',
  );
  assert(
    validateRecord({ ...base, verdict: Verdict.WORKS }).length > 0,
    "'works' with no toolsVisible must be rejected — that is the self-report this replaces",
  );
  assert(
    validateRecord({ ...base, verdict: Verdict.WORKS, checks: { toolsVisible: 17 } }).length === 0,
    "'works' WITH evidence must pass",
  );
  assert(
    validateRecord({ ...base, verdict: Verdict.BROKEN }).length > 0,
    "'broken' with no clientError must be rejected — a failure nobody can act on",
  );
  assert(
    validateRecord({ ...base, verdict: Verdict.BROKEN, checks: { clientError: 'ENOENT npx' } })
      .length === 0,
    "'broken' WITH the client's own words must pass",
  );
  assert(
    validateRecord({ ...base, host: {} }).length > 0,
    'a record with no host cannot be placed and must be rejected',
  );
  console.log('matrix self-check: ok (the validator refuses unplaceable and unevidenced records)');
}

if (process.argv.includes('--self-check')) {
  selfCheck();
} else if (process.argv.includes('--validate')) {
  const path = process.argv[process.argv.indexOf('--validate') + 1];
  if (path === undefined) {
    console.error('usage: --validate <record.json>');
    process.exit(1);
  }
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`${path}: not valid JSON — ${String(err).slice(0, 120)}`);
    process.exit(1);
  }
  const problems = validateRecord(record);
  if (problems.length > 0) {
    console.error(`${path} is not a submittable record:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`${path}: valid (${record.client.id} → ${record.verdict})`);
} else {
  const entries = loadRecords();
  mkdirSync(MATRIX_DIR, { recursive: true });
  writeFileSync(OUT, render(entries));
  console.log(`wrote ${OUT} — ${entries.length} record(s)`);
}
