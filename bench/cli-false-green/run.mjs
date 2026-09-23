#!/usr/bin/env node
// Does a sealed verdict catch what a cheaper check misses?
//
//   node bench/cli-false-green/run.mjs [--json]
//
// A checkpoint on the CLI realm, in the shape the web scorecard already uses:
// DETERMINISTIC, with no model in the loop. A fix-loop benchmark measures an agent and a checker
// at once and cannot say which moved; this injects a known defect and asks each checker the one
// question that matters.
//
// Three checkers over one corpus:
//
//   exit-code   what CI does today. Pass iff the process exited 0.
//   discipline  the verify-cli-run skill with no package: declare the path, diff the filesystem,
//               refuse the exit code as evidence.
//   cli-realm   the adapter, adjudicated by the specification's own `adjudicate`.
//
// A checker CATCHES a defect when it declines to pass on the broken build, and produces a FALSE
// GREEN when it passes one. It produces a FALSE POSITIVE when it declines on a build that is
// working -- which costs more than a miss, because a check that cries wolf stops being read.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUGS, EXPECTED_PATH } from './bugs.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { CliRealm, NodeSupervisor, nodeWorkspace } = await import(
  `file://${join(REPO, 'adapters/realm/cli/dist/index.js')}`
);
const { adjudicate, Declaration, assertionsHeldUnder, Verdict } = await import(
  `file://${join(REPO, 'open-verification/dist/index.js')}`
);

/** The tool under test: correct except for the one behaviour injected into it. */
function toolFor(bug, root) {
  const out = join(root, EXPECTED_PATH);
  return [
    '-e',
    `const fs = require('node:fs'); const cp = require('node:child_process');
     const OUT = ${JSON.stringify(out)};
     const say = (m) => process.stdout.write(m + '\\n');
     ${bug.script}`,
  ];
}

function workspaceFor(bug) {
  const root = mkdtempSync(join(tmpdir(), `cfg-${bug.id}-`));
  for (const [path, body] of Object.entries(bug.seed ?? {})) {
    writeFileSync(join(root, path), body.replace(/\\n/g, '\n'));
  }
  return root;
}

/**
 * What every checker is asked, so the comparison is about the CHECKER and not the question.
 *
 * "Running this produced out.txt, with content, and it was not already there." Any checker that
 * cannot express part of that expresses what it can -- which is the finding, not a handicap.
 */
const CLAIM = 'running the tool produces out.txt with real content';

/**
 * The needle the adapter's arm matches on, and why it is not just `out.txt`.
 *
 * `valueContains` is an unanchored substring over the rendered observation value, which the
 * specification defines as `JSON.stringify` -- so a bare `out.txt` is satisfied by `out.txt.bak`,
 * and the arm was scoring a PASS on a build that wrote somewhere else entirely. The closing quote
 * is what makes the claim mean the path it names. Every other arm already checks exactly this, so
 * the loose needle was the measurement under-stating the claim rather than the adapter meeting it.
 *
 * "With real content" is carried by the summary, not by this: `cli.fs.written` is no longer said
 * about a zero-byte file (see CliSummary.FS_WRITTEN_EMPTY).
 */
const EXPECTED_NEEDLE = `/${EXPECTED_PATH}"`;

const CHECKERS = {
  /** What almost every CI pipeline does. Pass iff the process exited zero. */
  'exit-code': ({ exit }) => exit?.code === 0 && exit?.wasSignalled !== true,

  /**
   * The Phase −1 skill, with no package at all: snapshot, run, diff, and refuse the exit code.
   *
   * Deliberately given the SAME filesystem evidence the adapter gets, so the comparison isolates
   * the one thing that differs -- whether the rules are the checker's to forget.
   */
  discipline: ({ before, after }) => {
    const path = join(after.root, EXPECTED_PATH);
    if (!existsSync(path)) return false;
    if (readFileSync(path, 'utf8').length === 0) return false;
    // The before-state, which is what the skill's step 3 asks for.
    return before.existed !== true || before.content !== readFileSync(path, 'utf8');
  },

  /** The adapter, adjudicated by the specification. Pass iff the verdict is `yes`. */
  'cli-realm': ({ verdict }) => verdict === Verdict.YES,
};

const rows = [];
for (const bug of BUGS) {
  const root = workspaceFor(bug);
  const outPath = join(root, EXPECTED_PATH);
  const before = {
    root,
    existed: existsSync(outPath),
    content: existsSync(outPath) ? readFileSync(outPath, 'utf8') : undefined,
  };

  const supervisor = new NodeSupervisor({
    executable: process.execPath,
    workspaceRoot: root,
    tool: { id: 'bench-tool', version: '1', workspace: root },
    now: () => Date.now(),
    ...(bug.settleMs === undefined ? {} : { settleMs: bug.settleMs }),
  });
  const realm = new CliRealm({
    supervisor,
    manifest: {
      workspaceRoot: root,
      commands: [
        { name: 'build', meaning: 'produce the output', mutating: true, argv: toolFor(bug, root) },
      ],
    },
    workspace: nodeWorkspace([root]),
    now: () => Date.now(),
  });

  const window = realm.openWindow(30_000);
  const heldBefore = realm.existedBefore(window, outPath);
  await realm.perform({ id: bug.id, actor: 'bench', capability: 'build', at: Date.now() });
  const closed = realm.closeWindow(window);
  const observed = await realm.observe(closed);
  const coverage = await realm.coverage(closed);
  const decided = adjudicate({
    claim: {
      id: 'c1',
      statement: CLAIM,
      declaredAt: Declaration.BEFORE_ACTION,
      assertions: [
        {
          id: 'a1',
          predicate: {
            kind: 'present',
            match: {
              channel: 'x-artifact',
              summary: 'cli.fs.written',
              valueContains: EXPECTED_NEEDLE,
            },
          },
          reads: `${EXPECTED_PATH} was written`,
          channels: ['x-artifact'],
        },
      ],
    },
    window: closed,
    channels: realm.channels(),
    evidence: observed
      .filter((o) => o.channel === 'x-artifact')
      .map((o) => ({
        observation: o,
        provenance: {
          class: 'observed',
          source: '@reticlehq/cli-realm',
          method: 'filesystem snapshot, before and after',
          subject: realm.identity(),
          at: Date.now(),
        },
        independence: 'independent',
        grade: 'consequence',
      })),
    coverage,
    anomalies: await realm.detect(closed, observed),
    assertionsHeld: assertionsHeldUnder(
      [
        {
          predicate: {
            kind: 'present',
            match: {
              channel: 'x-artifact',
              summary: 'cli.fs.written',
              valueContains: EXPECTED_NEEDLE,
            },
          },
          channels: ['x-artifact'],
        },
      ],
      observed,
      coverage,
    ),
    consequenceHeldBefore: heldBefore,
  });

  const exit = observed.find((o) => o.summary === 'cli.exit.code');
  const killed = observed.find((o) => o.summary === 'cli.terminated.signal');
  const input = {
    exit: { code: exit?.value, wasSignalled: killed !== undefined },
    before,
    after: { root },
    verdict: decided.verdict,
  };

  rows.push({
    id: bug.id,
    isBug: bug.isBug,
    results: Object.fromEntries(
      Object.entries(CHECKERS).map(([name, check]) => [name, check(input)]),
    ),
    ground: decided.ground,
  });
  rmSync(root, { recursive: true, force: true });
}

const names = Object.keys(CHECKERS);
const score = (name) => {
  const bugs = rows.filter((r) => r.isBug);
  const clean = rows.filter((r) => !r.isBug);
  return {
    caught: bugs.filter((r) => !r.results[name]).length,
    falseGreens: bugs.filter((r) => r.results[name]).length,
    falsePositives: clean.filter((r) => !r.results[name]).length,
    total: bugs.length,
    cleanTotal: clean.length,
  };
};

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify({ rows, scores: Object.fromEntries(names.map((n) => [n, score(n)])) }, null, 2),
  );
} else {
  const width = Math.max(...rows.map((r) => r.id.length)) + 2;
  console.error(`${'defect'.padEnd(width)}${names.map((n) => n.padEnd(13)).join('')}`);
  for (const row of rows) {
    const marks = names.map((n) => {
      const passed = row.results[n];
      const right = row.isBug ? !passed : passed;
      return `${right ? ' ' : '!'}${passed ? 'PASS' : 'decline'}`.padEnd(13);
    });
    console.error(`${row.id.padEnd(width)}${marks.join('')}`);
  }
  console.error(`\n${''.padEnd(width)}${names.map((n) => n.padEnd(13)).join('')}`);
  for (const metric of ['caught', 'falseGreens', 'falsePositives']) {
    const label =
      metric === 'falseGreens'
        ? 'FALSE GREENS'
        : metric === 'caught'
          ? 'caught'
          : 'false positives';
    console.error(
      `${label.padEnd(width)}${names.map((n) => String(score(n)[metric]).padEnd(13)).join('')}`,
    );
  }
  console.error(
    `\ndenominator: ${score(names[0]).total} defects, ${score(names[0]).cleanTotal} controls`,
  );
}
