// Source localization (Reticle-only on the component hierarchy): "which component renders this element,
// and where is it defined?" — the answer an agent needs to FIX a bug, not just locate a pixel.
//
// Reticle walks the React fiber from a DOM node up to the root and returns the COMPONENT STACK
// (the render hierarchy: nearest component → … → App) plus the source file:line. The component stack
// is fiber-derived and unreachable from outside the runtime. Playwright/DevTools see only the DOM:
// a CSS selector / role+name. (Honest caveat: the babel plugin also stamps a `data-reticle-source`
// attribute, so a DOM tool CAN read the raw file:line for a stamped host element — but it still
// cannot produce the component identity or the render stack. So: source line = parity-where-stamped;
// component stack = Reticle-only.)
import { writeFileSync } from 'node:fs';
import { ReticleAdapter } from './adapters.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const parse = (t) => {
  try {
    return JSON.parse(t || '{}');
  } catch {
    return {};
  }
};

// Shell elements present right after login (no navigation needed).
const TARGETS = ['nav-deployments', 'nav-compose', 'brand', 'session-pill'];

const a = new ReticleAdapter(URL);
await a.start();
const rows = [];
try {
  await a.login();
  for (const testid of TARGETS) {
    const q = await a._refByTestid(testid);
    if (!q.ref) {
      rows.push({ testid, ref: null, componentStack: null, source: null });
      continue;
    }
    const ins = parse((await a.c.callTool('reticle_inspect', { ref: q.ref })).text);
    const comp = ins.component ?? {};
    rows.push({
      testid,
      ref: q.ref,
      componentStack: comp.componentStack ?? null,
      source: comp.source ?? null,
    });
  }
} finally {
  await a.stop();
}

const localized = rows.filter(
  (r) => Array.isArray(r.componentStack) && r.componentStack.length > 0,
);
const withSource = rows.filter((r) => r.source && r.source.file);
const summary = {
  dimension: 'Source localization — component render stack + source (Reticle-only on the stack)',
  question: 'Which component renders this element, and where is it defined?',
  reticle: {
    component_stack_resolved: `${localized.length}/${rows.length}`,
    source_resolved: `${withSource.length}/${rows.length}`,
    rows,
  },
  competitor_ceiling: {
    component_stack: '0 — the React render hierarchy is not in the DOM (no fiber from outside)',
    source:
      'file:line only IF the element carries a data-reticle-source attr (DOM-readable); else none',
    locator: 'a CSS selector / role+name — not a source location',
  },
  note: 'The component stack (e.g. ["DeployTable","Deployments","App"]) is fiber-derived and Reticle-only. Raw source file:line is parity where the babel plugin stamped data-reticle-source. For an agent that must edit the code, Reticle collapses find-the-component to one call.',
};
writeFileSync('bench/raw/source-localize.json', JSON.stringify(summary, null, 2));
for (const r of rows) console.log(JSON.stringify(r));
console.log(
  `\n=== source-localize: Reticle component-stack ${localized.length}/${rows.length}, source ${withSource.length}/${rows.length}; competitor stack 0/${rows.length} (fiber unreachable) ===`,
);
process.exit(0);
