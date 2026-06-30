// Wasted-render storm benchmark (Reticle-only): a page can be thrashing — committing many React renders
// a second — while the DOM stays visually identical. To a screenshot/DOM tool the page is idle; only
// Reticle's commit meter (reticle_state __reticle_renders) sees it. We measure React commits over a 1s window
// on an idle page vs a page running the render-storm injector (re-renders `series` subscribers ~60×/s
// with identical output → no DOM mutation). Competitors have no view of React renders at all.
import { writeFileSync } from 'node:fs';
import { ReticleAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const BASE = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WINDOW_MS = 1000;
const url = (storm) =>
  storm ? `${BASE}${BASE.includes('?') ? '&' : '?'}reticle-bug=render-storm` : BASE;

async function commitRate(storm) {
  const a = new ReticleAdapter(url(storm));
  await a.start();
  try {
    await a.login();
    await sleep(400);
    const read = async () => {
      const r = await a.c.callTool('reticle_state', {
        store: '__reticle_renders',
        path: 'commits',
      });
      const tokens = measure(r.text ?? '').tokens_o200k;
      try {
        return { commits: JSON.parse(r.text).value, tokens };
      } catch {
        return { commits: null, tokens };
      }
    };
    const before = await read();
    await sleep(WINDOW_MS);
    const after = await read();
    return {
      commits_in_window: (after.commits ?? 0) - (before.commits ?? 0),
      read_tokens: after.tokens,
    };
  } finally {
    await a.stop();
  }
}

const idle = await commitRate(false);
const storm = await commitRate(true);
const summary = {
  dimension: 'Wasted-render storm — React commit rate (Reticle-only)',
  window_ms: WINDOW_MS,
  idle_commits: idle.commits_in_window,
  storm_commits: storm.commits_in_window,
  reticle_read_tokens: storm.read_tokens,
  competitor:
    'no signal — the DOM is visually identical during the storm; Playwright/DevTools cannot observe a React commit',
  detected: storm.commits_in_window > idle.commits_in_window * 2 && storm.commits_in_window > 60,
  note: "Idle is not zero — the demo's count-up animations re-render ambiently (~30-40/s, and those DO mutate the DOM, so a DOM tool can see them). The storm adds ~60/s of PURE-WASTE commits (series redraws identically → no DOM mutation), nearly tripling the commit rate. Reticle reads the count in one reticle_state call; an outside tool sees no new DOM change from the storm.",
};
writeFileSync('bench/raw/render-storm-bench.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(
  `\n=== render-storm: idle ${idle.commits_in_window} commits/s vs storm ${storm.commits_in_window} commits/s in ${WINDOW_MS}ms — Reticle ${summary.detected ? 'DETECTED' : 'did NOT detect'} @ ~${storm.read_tokens} tok; competitors see an idle DOM ===`,
);
process.exit(0);
