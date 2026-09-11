/**
 * Ground truth for "where does an agent have to go to fix this?" — derived, never hand-written.
 *
 * The detection benchmark answers "did the tool notice?". That is the easy half. The half that
 * decides whether a dev has to get involved is: once the tool notices, does the agent know where to
 * go? A verdict that says "the button does nothing" still costs a full exploration loop. A verdict
 * that says "the button does nothing, and it is rendered at components/Topbar.tsx:31" costs one open.
 *
 * To score that, the benchmark needs to know the right answer independently of what Reticle emits.
 * Every anchor here is derived by scanning the fixture's source for `data-testid`, so the ground truth
 * cannot drift from the app the way a hand-maintained table would — and a testid that stops existing
 * becomes a loud failure rather than a silently-passing row.
 *
 * WHICH ANCHOR IS "RIGHT" depends on the bug, and this file is deliberate about the distinction:
 *
 *   - trigger  — the control the harness activated to provoke the failure (check.steps, prep.fill,
 *                or the last setup step). For a network/state bug this is the honest target: the
 *                handler that fired the request lives with the control that was clicked.
 *   - subject  — the element the assertion is ABOUT (check.testid and friends). For a visual bug
 *                this is the honest target: the thing that rendered wrong.
 *
 * Both are reported. A source pointer that lands on either is scored a hit, because either one puts
 * the agent in the right file. Scoring only one would let us pick whichever flatters the result.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SRC = join(HERE, '..', '..', 'apps', 'bench-app', 'src');
const REPO = join(HERE, '..', '..');

/**
 * The fixture writes testids four ways, and an index that only understood the first would quietly
 * resolve 68 of 85 bugs and report the other 17 as "the app does not render this" — which would be a
 * measurement artifact dressed up as a coverage gap.
 *
 *   literal      data-testid="login-submit"
 *   constant     data-testid={SEARCH_INPUT_TESTID}     (const declared in the same file)
 *   imperative   el.setAttribute('data-testid', SHADOW_LABEL_TESTID)
 *   templated    data-testid={`nav-${id}`}             (prefix only — the suffix is data)
 */
const LITERAL_RE = /data-testid="([a-zA-Z0-9-]+)"/g;
const CONST_REF_RE = /data-testid=\{([A-Z][A-Z0-9_]*)\}/g;
const SET_ATTR_RE = /setAttribute\(\s*['"]data-testid['"]\s*,\s*([A-Z][A-Z0-9_]*)\s*\)/g;
const TEMPLATE_RE = /data-testid=\{`([a-z0-9-]+)-\$\{/g;
/** `[export] const NAME = 'value'` — how the fixture declares the constants the forms above reference. */
const CONST_DECL_RE = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*['"]([a-zA-Z0-9-]+)['"]/;
/**
 * `testid: 'fault-500'` inside a data array the view maps over. The row is the source of truth for
 * that control even though no JSX line names it, so the declaration line is the site.
 */
const DATA_ROW_RE = /\btestid:\s*['"]([a-zA-Z0-9-]+)['"]/g;

/** Every .tsx/.ts file under the fixture's src, recursively. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * testid -> {file, line}. Built once by scanning the fixture.
 *
 * A testid rendered in more than one file is recorded with every site rather than the first, because
 * silently keeping the first would make a wrong pointer look correct half the time.
 */
function buildIndex() {
  const index = new Map();
  const prefixes = [];
  for (const file of sourceFiles(APP_SRC)) {
    // The injector describes bugs in terms of testids it does not render. Indexing it would let a
    // pointer at the injector count as "found the component", which is the opposite of the truth.
    if (file.endsWith('reticle-bug-injector.ts')) continue;
    const rel = relative(REPO, file);
    const lines = readFileSync(file, 'utf8').split('\n');

    // Constants are resolved per-file first, because the reference and the declaration are usually
    // tens of lines apart and the reference is the line the agent actually wants.
    const consts = new Map();
    for (const text of lines) {
      const d = CONST_DECL_RE.exec(text);
      if (d !== null) consts.set(d[1], d[2]);
    }

    const record = (id, line) => {
      const site = { file: rel, line };
      const prior = index.get(id);
      if (prior === undefined) index.set(id, [site]);
      else prior.push(site);
    };

    lines.forEach((text, i) => {
      const line = i + 1;
      for (const re of [LITERAL_RE, DATA_ROW_RE]) {
        for (const m of text.matchAll(re)) record(m[1], line);
      }
      for (const re of [CONST_REF_RE, SET_ATTR_RE]) {
        for (const m of text.matchAll(re)) {
          const value = consts.get(m[1]);
          if (value !== undefined) record(value, line);
        }
      }
      for (const m of text.matchAll(TEMPLATE_RE)) prefixes.push({ prefix: m[1], file: rel, line });
    });
  }
  return { index, prefixes };
}

const { index: TESTID_INDEX, prefixes: TESTID_PREFIXES } = buildIndex();

export { TESTID_INDEX };

/**
 * Where a testid is rendered. Exact match wins; a templated site (`nav-${id}`) matches by prefix,
 * since the suffix comes from data rather than source and no line can be more specific than the map
 * that produced it.
 */
export function sitesFor(testid) {
  const exact = TESTID_INDEX.get(testid);
  if (exact !== undefined) return exact;
  const byPrefix = TESTID_PREFIXES.filter((p) => testid.startsWith(`${p.prefix}-`));
  return byPrefix.length > 0 ? byPrefix.map(({ file, line }) => ({ file, line })) : undefined;
}

/** The control activated to provoke the failure, most-proximate first. */
export function triggerAnchors(bug) {
  const c = bug.check ?? {};
  const ids = [];
  if (Array.isArray(c.steps)) ids.push(...c.steps);
  if (typeof c.prep?.fill === 'string') ids.push(c.prep.fill);
  // The last setup step is what put the app in the failing view; it is the fallback trigger for bugs
  // that assert on load rather than after an action.
  if (ids.length === 0 && Array.isArray(bug.setup) && bug.setup.length > 0) {
    ids.push(bug.setup[bug.setup.length - 1]);
  }
  return [...new Set(ids)];
}

/** The element the assertion is about. */
export function subjectAnchors(bug) {
  const c = bug.check ?? {};
  const ids = [c.testid, c.deepTestid, c.churnTestid, c.stableTestid].filter(
    (v) => typeof v === 'string',
  );
  return [...new Set(ids)];
}

/**
 * Resolve a bug to the source sites an agent would legitimately need to open.
 *
 * `unresolved` is returned rather than dropped: a testid that the fixture no longer renders means the
 * registry and the app have drifted, and that has to surface as a problem instead of shrinking the
 * denominator quietly.
 */
export function groundTruth(bug) {
  const trigger = triggerAnchors(bug);
  const subject = subjectAnchors(bug);
  const sites = [];
  const unresolved = [];
  for (const [role, ids] of [
    ['trigger', trigger],
    ['subject', subject],
  ]) {
    for (const id of ids) {
      const found = sitesFor(id);
      if (found === undefined) unresolved.push({ role, testid: id });
      else for (const site of found) sites.push({ role, testid: id, ...site });
    }
  }
  return { bug: bug.id, sites, unresolved };
}

/** The set of files any of the ground-truth anchors live in. */
export function groundTruthFiles(bug) {
  return [...new Set(groundTruth(bug).sites.map((s) => s.file))];
}
