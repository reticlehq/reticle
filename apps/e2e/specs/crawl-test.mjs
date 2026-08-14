// HONESTY-CRITICAL: prove the autonomous crawler runs end-to-end against a real app — it
// discovers interactive controls, clicks them (bounded), and returns a structured anomaly report
// WITHOUT a script. Bounded (maxSteps) so it always terminates.
import { chromium } from 'playwright';
import { start, TOOLS } from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const chk = (l, o, d = '') => {
  console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`);
  o ? pass++ : fail++;
};

const server = await start({ port: 4400, mcp: false });
const deps = {
  sessions: server.bridge.sessions,
  project: { recordRoutes: async () => {} },
};
const T = (n, a = {}) => TOOLS.find((t) => t.name === n).handler(deps, { sessionId: 'next-smoke', ...a });
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://localhost:3100/');
await waitForSession(()=>server.bridge.sessions.list(), 'next-smoke');

console.log('\n=== EXPLORE: reticle_crawl autonomously drives the app (real browser) ===');
chk('app SDK connected', server.bridge.sessions.list().some(s=>s.sessionId==='next-smoke'));

const report = await T('reticle_crawl', { maxSteps: 6, settleMs: 150 });
chk('reticle_crawl discovered interactive controls', report.interactiveFound > 0, `found=${report.interactiveFound}`);
chk('reticle_crawl clicked controls (bounded) and terminated', report.stepsRun > 0 && report.stepsRun <= 6, `steps=${report.stepsRun}`);
chk('reticle_crawl returned a structured anomaly report', Array.isArray(report.anomalies) && typeof report.counts === 'object', JSON.stringify(report.counts));
chk('every visited control is named', Array.isArray(report.visited) && report.visited.length === report.stepsRun);

console.log(`\n${fail === 0 ? '✅ CRAWL VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed) — anomalies: ${report.anomalies.length}`);
await b.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
