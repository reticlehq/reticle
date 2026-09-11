/**
 * The moat analysis, generated from MEASURED results — never from the registry's intentions.
 *
 * The question this answers is the one a skeptical buyer actually asks: "what can this catch that my
 * existing Playwright suite can't, and WHY can't Playwright be made to catch it?" A category label is
 * not an answer. An answer has to survive two challenges:
 *
 *   1. Did Reticle actually catch it, and Playwright actually miss it, in a run? (measured, not labelled)
 *   2. Is the miss STRUCTURAL, or did we just not write the check? Every "structural" claim below names
 *      the specific thing a browser-automation tool cannot reach from outside the page.
 *
 * Challenge 2 is the one that matters, because it is the one we have already failed. An earlier version
 * of this suite scored six bugs as reticle-only on the strength of Playwright branches that returned
 * `caught = false` with an excuse, while the APIs to catch them (request.postData, PerformanceObserver)
 * existed and simply were not called. Two of those six turned out to be catchable and are now scored
 * 'both'. So a moat claim here is only as good as the adversarial pass on the competitor's harness, and
 * that caveat is printed with the results rather than left in a commit message.
 *
 * Usage: node bench/pw-vs-reticle/moat.mjs [results.json]
 */
import { readFileSync } from 'node:fs';
import { BUGS, severityOf } from './bugs.mjs';

const RESULTS = process.argv[2] ?? new URL('./results.json', import.meta.url).pathname;

/**
 * Why a browser-automation tool cannot reach a class, stated as the concrete missing capability.
 * "Playwright can't do X" is only credible when X names something outside the browser's observable
 * surface — so each entry has to survive the question "could they add it?"
 */
const STRUCTURAL_REASON = {
  state:
    "the app's store is a JS object inside the page. Playwright can evaluate() into the page, but it " +
    'has no idea which object is the store, what shape it has, or when it changed — the app has to ' +
    'tell someone. Reticle is told at registration.',
  'business-logic':
    'the correct VALUE is only knowable from app state (a total, a checksum, a derived count). The DOM ' +
    'shows a rendered string; comparing it to truth requires reading truth.',
  signal:
    'a declared domain signal has no DOM representation at all. Nothing renders when it fails to fire.',
  'net-hang':
    'a request that never resolves looks identical to one that was never made, unless you can see the ' +
    'in-flight set. A client-side hang sends nothing to the wire, so a proxy/CDP view sees nothing.',
  'net-status':
    'the fault is CLIENT-side — the app receives a 500 the wire never carried. A request/response ' +
    'observer sees the real 200 and nothing wrong.',
  streams:
    'SSE/WebSocket FRAMES delivered vs rendered. Playwright exposes WS frames (so those are scored as ' +
    'parity), but comparing frames received against DOM produced needs both halves at once.',
  perf:
    'layout-shift and long-task are PerformanceObserver metrics. Playwright CAN read them — these are ' +
    'scored on measurement, and where it does read them the bug is scored as parity.',
  'deep-dom':
    'content inside an open shadow root or a same-origin frame. Playwright pierces shadow roots in its ' +
    'locators, so most of this class is parity; only the store-vs-frame comparison is not.',
};

/**
 * Why the competitor wins, where it does. Published with the same specificity as our own wins, because
 * a loss without a reason reads as an oversight we will fix, and some of these are structural.
 */
const LOSS_REASON = {
  'ui-paint':
    'a paint-level regression leaves every COMPUTED style identical — a global CSS filter re-tints ' +
    'pixels without touching any property an in-page read can see. Only a screenshot is ground truth. ' +
    'This is a permanent limit of reading the program instead of the picture.',
  'net-status':
    'Reticle reads `init.body` inside its own fetch wrapper, so it sees what the page HANDED to fetch, ' +
    'not what left the machine. Whoever patches fetch last is outermost, and that ordering is decided ' +
    'by app bootstrap, not by us — so an axios/Sentry/auth interceptor initialised after connect(), a ' +
    'service worker (which never produces a window.fetch frame at all), or sendBeacon can all rewrite a ' +
    'request invisibly. A CDP or proxy observer sees the wire and catches it. This is a real limit of ' +
    'in-page instrumentation, not a fixture artifact. The drive path now reads the wire (CDP ' +
    'network-detail capture), so seeing this loss again means that capture regressed; attach-mode ' +
    'sessions remain exposed, since wire capture cannot help them at all.',
};

const rows = JSON.parse(readFileSync(RESULTS, 'utf8')).rows;
const verdict = (harness, bug, variant) =>
  rows.find((r) => r.harness === harness && r.bug === bug && r.variant === variant);

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'none'];

/** A bug is a MEASURED moat case when reticle caught it, playwright did not, and neither tripped clean. */
const measured = {
  moat: [],
  parity: [],
  competitorOnly: [],
  bothMissed: [],
  unclean: [],
  traps: [],
};

for (const bug of BUGS) {
  const rBuggy = verdict('reticle-script', bug.id, 'buggy');
  const pBuggy = verdict('playwright-script', bug.id, 'buggy');
  const rClean = verdict('reticle-script', bug.id, 'clean');
  const pClean = verdict('playwright-script', bug.id, 'clean');
  if (rBuggy === undefined || pBuggy === undefined) continue;
  const entry = {
    id: bug.id,
    category: bug.category,
    severity: severityOf(bug),
    label: bug.expect,
    intent: bug.intent,
    reticleNote: rBuggy.note,
    playwrightNote: pBuggy.note,
  };
  // A bug that trips the CLEAN build tells us nothing about either tool.
  if (rClean?.caught === true || pClean?.caught === true) {
    measured.unclean.push(entry);
    continue;
  }
  // A TRAP is a bug-shaped thing that is not a bug — a live timestamp, an ambient animation. The
  // correct outcome is that NEITHER tool fires. Counting those as "missed by both" would file the two
  // tools' best behaviour under open coverage gaps, and would quietly reward a tool for firing on them.
  if (bug.trap === true) {
    measured.traps.push({
      ...entry,
      heldFor: [...(rBuggy.caught ? [] : ['reticle']), ...(pBuggy.caught ? [] : ['playwright'])],
    });
    continue;
  }
  if (rBuggy.caught && !pBuggy.caught) measured.moat.push(entry);
  else if (rBuggy.caught && pBuggy.caught) measured.parity.push(entry);
  else if (!rBuggy.caught && pBuggy.caught) measured.competitorOnly.push(entry);
  else measured.bothMissed.push(entry);
}

const bySeverity = (a, b) =>
  SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);

const lines = [];
lines.push('# What Reticle catches that a Playwright script does not');
lines.push('');
lines.push(
  'Generated from a measured run. Every row below is a bug where **Reticle caught it, the',
);
lines.push(
  'Playwright script did not, and neither tool flagged the clean build**. Labels in the registry',
);
lines.push('are ignored here — only the run counts.');
lines.push('');
lines.push(
  '> **Read this with the caveat it deserves.** An earlier version of this suite scored six bugs',
);
lines.push(
  '> as Reticle-only because the Playwright branch returned "not supported" while the APIs to',
);
lines.push(
  '> catch them existed and simply were not called. Two of those six are now scored as parity.',
);
lines.push("> A moat claim is only as strong as the adversarial pass on the COMPETITOR's harness.");
lines.push('');
lines.push(
  `## Measured: ${measured.moat.length} Reticle-only · ${measured.parity.length} parity · ` +
    `${measured.competitorOnly.length} Playwright-only · ${measured.bothMissed.length} missed by both`,
);
lines.push('');

for (const sev of SEVERITY_ORDER) {
  const group = measured.moat.filter((m) => m.severity === sev).sort(bySeverity);
  if (group.length === 0) continue;
  lines.push(`### ${sev.toUpperCase()} severity (${group.length})`);
  lines.push('');
  lines.push('| bug | what breaks | why a script outside the page cannot see it |');
  lines.push('|---|---|---|');
  for (const m of group) {
    const why =
      STRUCTURAL_REASON[m.category] ?? '(no structural claim recorded — treat as unproven)';
    lines.push(`| \`${m.id}\` | ${m.intent} | ${why} |`);
  }
  lines.push('');
}

if (measured.competitorOnly.length > 0) {
  lines.push('## Caught by Playwright, missed by Reticle');
  lines.push('');
  lines.push('Published deliberately. A benchmark that never reports a loss is not measuring.');
  lines.push('');
  for (const m of measured.competitorOnly) {
    lines.push(`- \`${m.id}\` (${m.severity}) — ${m.intent}`);
    lines.push(`  - reticle observed: ${m.reticleNote}`);
    const why = LOSS_REASON[m.category];
    lines.push(
      `  - **why we lose:** ${why ?? '(no structural reason recorded — treat as a gap to close, not a limit)'}`,
    );
  }
  lines.push('');
}

if (measured.traps.length > 0) {
  lines.push('## False-positive traps (not firing is the PASS)');
  lines.push('');
  lines.push('Bug-shaped things that are not bugs: a live-updating timestamp, an infinite ambient');
  lines.push(
    'animation. A tool that flags these is unusable on a real app, so silence is the correct',
  );
  lines.push('result and these are excluded from every catch count above.');
  lines.push('');
  for (const m of measured.traps) {
    const held =
      m.heldFor.length === 2
        ? 'both held'
        : m.heldFor.length === 0
          ? 'BOTH FIRED — false positive'
          : `${m.heldFor.join('/')} held, the other FIRED`;
    lines.push(`- \`${m.id}\` — ${m.intent} — **${held}**`);
  }
  lines.push('');
}

if (measured.bothMissed.length > 0) {
  lines.push('## Missed by both');
  lines.push('');
  lines.push('Neither tool caught these. They are open coverage gaps, not wins for anyone.');
  lines.push('');
  for (const m of measured.bothMissed) lines.push(`- \`${m.id}\` (${m.severity}) — ${m.intent}`);
  lines.push('');
}

if (measured.unclean.length > 0) {
  lines.push('## Excluded: tripped the clean build');
  lines.push('');
  lines.push(
    'A check that fires on a healthy build proves nothing about either tool, so these are',
  );
  lines.push('excluded from every count above rather than being counted as catches.');
  lines.push('');
  for (const m of measured.unclean) lines.push(`- \`${m.id}\` (${m.severity})`);
  lines.push('');
}

console.log(lines.join('\n'));
