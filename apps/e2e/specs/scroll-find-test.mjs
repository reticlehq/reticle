// HONESTY-CRITICAL: prove N5 scroll-to-find against a REAL windowed list — next-smoke renders only
// the visible window of 500 rows, so a plain reticle_query for an off-screen row finds nothing;
// reticle_scroll_to must scroll the container until that row mounts, then return it.
import { chromium } from 'playwright';
import { start, TOOLS } from '@reticle/server';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const chk = (l, o, d = '') => {
  console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`);
  o ? pass++ : fail++;
};

const server = await start({ port: 4400, mcp: false });
const deps = { sessions: server.bridge.sessions };
const T = (n, a = {}) => TOOLS.find((t) => t.name === n).handler(deps, { sessionId: 'next-smoke', ...a });
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://localhost:3100/', { waitUntil: 'networkidle' });
for (let i = 0; i < 200 && server.bridge.sessions.count() === 0; i++) await sleep(50);

console.log('\n=== N5 SCROLLFIND: reticle_scroll_to reveals a virtualized off-screen row ===');
chk('app SDK connected', server.bridge.sessions.count() > 0);

const TARGET = 'row-40';
const before = await T('reticle_query', { by: 'testid', value: TARGET });
chk('the off-screen row is NOT rendered initially (virtualized)', (before.elements?.length ?? 0) === 0);

const container = (await T('reticle_query', { by: 'testid', value: 'virtual-list' })).elements?.[0]?.ref;
chk('found the list container ref', typeof container === 'string', container);

const found = await T('reticle_scroll_to', { by: 'testid', value: TARGET, container, maxScrolls: 40 });
chk('reticle_scroll_to revealed the row by scrolling', found.found === true, `scrolls=${found.scrolls}`);
chk('it returned the mounted element ref', typeof found.element?.ref === 'string', JSON.stringify(found.element).slice(0, 80));

// 500 rows × 28px ≈ 14000px; ~158px/scroll ⇒ ~90 scrolls to the bottom. 120 lets it reach the end.
const missing = await T('reticle_scroll_to', { by: 'testid', value: 'row-99999', container, maxScrolls: 120 });
chk('a row that does not exist is exhausted at the list end', missing.found === false && missing.exhausted === true, `scrolls=${missing.scrolls}, exhausted=${missing.exhausted}`);

console.log(`\n${fail === 0 ? '✅ N5 SCROLLFIND VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`);
await b.close();
await server.close();
process.exit(fail === 0 ? 0 : 1);
