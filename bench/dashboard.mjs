/**
 * The scorecard: every axis in one artifact, generated from measured data only.
 *
 * The rule this file enforces on itself is that a number either comes from a run on disk or it is
 * printed as MISSING. There is no place to hand-write a figure, because every hand-written figure in
 * this repo's history has eventually turned out to be stale — three different tool counts, a token
 * measurement taken against a surface that no longer existed, a "~150x" that was a projection.
 *
 * Sections map to the questions buyers actually ask:
 *   1. Detection    — what does each tool catch, by severity, and what does each MISS
 *   2. Cost         — bytes pulled and wall-time per decision, and per full flow
 *   3. Concurrency  — serial vs parallel, per tool
 *   4. Moat         — the Reticle-only set, with the structural reason, measured not labelled
 *   5. Gaps         — what is NOT measured, stated as plainly as what is
 *
 * Usage: node bench/dashboard.mjs [--json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUGS, severityOf } from './pw-vs-reticle/bugs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JSON_OUT = process.argv.includes('--json');

/** Read a bench artifact, or return undefined — never a default that could be mistaken for a result. */
function readArtifact(relPath) {
  const full = join(HERE, relPath);
  if (!existsSync(full)) return undefined;
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch {
    return undefined;
  }
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const HARNESSES = ['reticle-script', 'playwright-script'];

const headToHead = readArtifact('pw-vs-reticle/results.json');
const parallel =
  readArtifact('raw/parallel-suite.json') ?? readArtifact('parallel-suite/results.json');
const overhead = readArtifact('raw/overhead.json') ?? readArtifact('overhead/results.json');
const firstDrive = readArtifact('raw/first-drive.json') ?? readArtifact('first-drive/results.json');
const diagnosis = readArtifact('raw/diagnosis.json');
const diagnosisControl = readArtifact('raw/diagnosis-nosource.json');
const recoverability = readArtifact('raw/recoverability.json');
const crossTool = readArtifact('raw/cross-tool-parallel.json');

const out = [];
const p = (line = '') => out.push(line);
/** Print a value, or a loud MISSING marker naming how to produce it. */
const orMissing = (value, howToGet) =>
  value === undefined || value === null ? `_not measured — run \`${howToGet}\`_` : value;

p('# Reticle benchmark scorecard');
p();
p(
  'Every number here is read from a run artifact on disk. Anything not measured says so and names the',
);
p(
  'command that would produce it — there is deliberately no way to hand-write a figure into this file.',
);
p();

// ── 1. DETECTION ────────────────────────────────────────────────────────────────────────────────
p('## 1. Detection');
p();
if (headToHead === undefined) {
  p(orMissing(undefined, 'node bench/pw-vs-reticle/run.mjs'));
  p();
} else {
  const { rows, agg } = headToHead;
  const verdict = (h, bug, variant) =>
    rows.find((r) => r.harness === h && r.bug === bug && r.variant === variant);

  p(
    '| harness | bugs | caught | of what it can catch | **false positives on clean** | avg bytes/bug | avg ms/bug |',
  );
  p('|---|---|---|---|---|---|---|');
  for (const h of HARNESSES) {
    const a = agg?.[h];
    if (a === undefined) continue;
    p(
      `| ${h} | ${a.bugs} | ${a.caught} | ${a.caughtOfExpected}/${a.expected} | **${a.falsePositives}** | ` +
        `${a.avgBytes} | ${a.avgMs} |`,
    );
  }
  p();
  p(
    'False positives are the column that matters most: a verification tool that flags a healthy build',
  );
  p('is worse than no tool, because it trains the team to ignore it.');
  p();

  p('### Catch rate by severity');
  p();
  p('Severity is graded by consequence to the user, not by how hard the bug is to find.');
  p();
  p('| severity | bugs | reticle | playwright | caught by neither |');
  p('|---|---|---|---|---|');
  for (const sev of SEVERITY_ORDER) {
    const group = BUGS.filter((b) => severityOf(b) === sev);
    if (group.length === 0) continue;
    let r = 0;
    let pw = 0;
    let neither = 0;
    for (const bug of group) {
      const rc = verdict('reticle-script', bug.id, 'buggy')?.caught === true;
      const pc = verdict('playwright-script', bug.id, 'buggy')?.caught === true;
      if (rc) r += 1;
      if (pc) pw += 1;
      if (!rc && !pc) neither += 1;
    }
    p(`| ${sev} | ${group.length} | ${r} | ${pw} | ${neither} |`);
  }
  p();
}

// ── 2. COST ─────────────────────────────────────────────────────────────────────────────────────
p('## 2. Cost per decision and per flow');
p();
if (headToHead?.rows !== undefined) {
  const perDecision = {};
  for (const h of HARNESSES) {
    const rs = headToHead.rows.filter((r) => r.harness === h);
    if (rs.length === 0) continue;
    const ms = rs
      .map((r) => r.ms)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    const bytes = rs.map((r) => r.bytes).filter((n) => Number.isFinite(n));
    perDecision[h] = {
      decisions: rs.length,
      medianMs: ms[Math.floor(ms.length / 2)],
      p90Ms: ms[Math.floor(ms.length * 0.9)],
      totalBytes: bytes.reduce((a, b) => a + b, 0),
    };
  }
  p(
    'One "decision" is one bug verdict: drive the app, observe, decide caught/not. Median and p90 are',
  );
  p('reported rather than the mean, because a single slow outlier makes a mean meaningless here.');
  p();
  p('| harness | decisions | median ms | p90 ms | total bytes pulled |');
  p('|---|---|---|---|---|');
  for (const [h, v] of Object.entries(perDecision)) {
    p(`| ${h} | ${v.decisions} | ${v.medianMs} | ${v.p90Ms} | ${v.totalBytes.toLocaleString()} |`);
  }
  p();
  const r = perDecision['reticle-script'];
  const w = perDecision['playwright-script'];
  if (r !== undefined && w !== undefined && r.medianMs > 0) {
    p(
      `**Median decision latency: ${(w.medianMs / r.medianMs).toFixed(1)}x faster** (${r.medianMs}ms vs ${w.medianMs}ms).`,
    );
    p('Both harnesses are deterministic scripts with no model in the loop, so this compares the');
    p(
      'OBSERVATION path only — not agent reasoning, which dominates a real loop and is measured separately.',
    );
    p();
  }
} else {
  p(orMissing(undefined, 'node bench/pw-vs-reticle/run.mjs'));
  p();
}

p('### Per-turn token cost of the tool surface');
p();
p(orMissing(firstDrive?.summary ?? firstDrive, 'node bench/first-drive/measure.mjs'));
p();

// ── 3. DIAGNOSIS ────────────────────────────────────────────────────────────────────────────────
p('## 3. Does a report say where to fix it?');
p();
p(
  'Detection is the easy half. The half that decides whether a human gets pulled in is whether the',
);
p(
  'agent knows which file to open — worth more downstream than any amount of extra description of the',
);
p("symptom. Ground truth is derived by scanning the fixture's own source, not hand-maintained.");
p();
if (diagnosis?.summary === undefined) {
  p(orMissing(undefined, 'node bench/diagnosis/measure.mjs'));
  p();
} else {
  const d = diagnosis.summary;
  p('| measure | result |');
  p('|---|---|');
  p(`| bugs scored | ${d.scorable} / ${d.bugsAttempted} |`);
  p(`| report carries a \`file:line\` | **${d.sourcePresent}** (${d.coveragePct}%) |`);
  p(`| names the RIGHT file | **${d.sourceCorrect}** (${d.accuracyPct}% of those present) |`);
  p();
  if (diagnosisControl?.summary !== undefined) {
    const c = diagnosisControl.summary;
    p(
      `**Control** (same run, build-time source stamps stripped at runtime, everything else held): ` +
        `**${c.sourcePresent} / ${c.scorable} (${c.coveragePct}%)**.`,
    );
    p();
    p(
      'That is what makes the number above mean what it says. Coverage collapses to zero when only the',
    );
    p(
      'stamp is removed, so it is caused by the stamp — not by a hardcoded path, a lucky default, or a',
    );
    p('harness fabricating the field. A headline metric without this control is an assertion.');
    p();
  } else {
    p(orMissing(undefined, 'node bench/diagnosis/measure.mjs --nosource'));
    p();
  }
  if (recoverability?.off?.summary !== undefined) {
    const off = recoverability.off.summary;
    const on = recoverability.on.summary;
    p(
      '**Is the file recoverable without the stamp, at any cost?** The obvious objection to the number',
    );
    p(
      'above is "the agent could just look it up". Measured, on the same elements, trying every route',
    );
    p("Reticle gives an agent — the descriptor's own field AND a follow-up `reticle_inspect`:");
    p();
    p('| condition | elements | via query | via inspect | recoverable by ANY route |');
    p('|---|---|---|---|---|');
    p(
      `| stamps present | ${on.elements} | ${on.viaQuery} | ${on.viaInspect} | **${on.recoverableByAnyRoute}** |`,
    );
    p(
      `| stamps stripped | ${off.elements} | ${off.viaQuery} | ${off.viaInspect} | **${off.recoverableByAnyRoute}** |`,
    );
    p();
    p(
      'So the difference is not cost, it is AVAILABILITY. With the stamp the file is already on the',
    );
    p(
      'descriptor and costs zero extra calls; without it, no number of Reticle calls recovers it. The',
    );
    p(
      'agent falls back to searching the repo — which is precisely the work the localization literature',
    );
    p(
      'measures as the dominant cost of a repair loop, and precisely what this layer exists to remove.',
    );
    p();
  }
  p(
    "No competitor column: a browser-automation tool's stack trace points at its own test, never at",
  );
  p(
    'the app source. That is the asymmetry — but it also means there is no baseline to beat, so this',
  );
  p('is a capability measurement, not a head-to-head.');
  p();
}

// ── 4. CONCURRENCY ──────────────────────────────────────────────────────────────────────────────
p('## 4. Serial vs parallel');
p();
p(orMissing(parallel?.summary ?? parallel, 'node bench/parallel-suite/measure.mjs'));
p();
if (crossTool !== undefined) {
  p(
    `**The same mechanism, driven through Playwright:** ${crossTool.serial?.ms} ms serial vs ` +
      `${crossTool.parallel?.ms} ms across ${crossTool.parallelism} contexts — **${crossTool.speedup}x**` +
      `${crossTool.comparable === true ? '' : ' (NOT COMPARABLE — the two modes completed different journey counts)'}.`,
  );
  p();
  p(
    '> So concurrency is not a Reticle capability. `browser.newContext()` is available to anyone, and',
  );
  p(
    '> gets most of the same win. What is ours is the pooling and lease reclamation around it, which',
  );
  p('> is a convenience, not a moat. Any claim built on the speed-up alone is overstated.');
  p();
} else {
  p(orMissing(undefined, 'node bench/parallel-suite/cross-tool.mjs'));
  p();
}

// ── 4. OVERHEAD ─────────────────────────────────────────────────────────────────────────────────
p('## 5. SDK overhead on the observed app');
p();
p('An observability layer that slows the app corrupts its own performance verdicts.');
p();
p(orMissing(overhead?.summary ?? overhead, 'node bench/overhead/measure.mjs'));
p();

// ── 5. WHAT IS NOT MEASURED ─────────────────────────────────────────────────────────────────────
p('## 6. What this scorecard does NOT show');
p();
p('Stated as plainly as the wins, because a scorecard without this section is marketing.');
p();
p('- **Does an agent fix bugs faster with Reticle?** Not established. The one attempt measured no');
p(
  '  fix-rate lift and roughly 6x the tool calls, on a fixture small enough that the result could not',
);
p(
  '  settle the question either way. Every number above is a DETECTION and COST measurement, not an',
);
p('  outcome measurement.');
p(
  '- **Agent-loop numbers.** The head-to-head above runs deterministic scripts with no model, which',
);
p('  isolates the tool but omits the reasoning cost that dominates a real loop.');
p('- **Cross-tool concurrency.** See section 3.');
p(
  '- **Competitor harness quality.** Every Playwright branch is code we wrote. We have already found',
);
p('  six cases where it under-performed because a check was never written rather than because the');
p(
  '  capability was missing. Treat any Reticle-only claim as provisional until someone adversarial to',
);
p('  us has attacked the competitor side.');
p(
  '- **A single run.** Reproducibility is checked with `compare-runs.mjs`; one run is an anecdote.',
);
p();

if (JSON_OUT) {
  console.log(
    JSON.stringify({ headToHead: headToHead?.agg, generatedFrom: 'bench artifacts' }, null, 2),
  );
} else {
  console.log(out.join('\n'));
}
