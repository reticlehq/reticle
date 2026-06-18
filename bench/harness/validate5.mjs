// Validate adapters on scenario #5 (console-error, intact UI) across all 3 tools.
import { writeFileSync } from 'node:fs';
import { makeAdapter } from './adapters.mjs';

const URL = 'http://localhost:4312/';
const SIGNAL = /Render crash in <ChartWidget>/;

async function runTool(tool) {
  const a = makeAdapter(tool, URL);
  const cycle = [];
  try {
    await a.start();
    await a.login();
    // navigate to Diagnostics
    if (tool === 'devtools')
      cycle.push(await a.clickByName(/button "Diagnostics"|Diagnostics/, 'nav-diagnostics'));
    else cycle.push(await a.clickTestid('nav-diagnostics', 'Diagnostics nav'));
    // click buggy widget
    if (tool === 'devtools')
      cycle.push(await a.clickByName(/buggy|chart widget|crash/i, 'fault-buggy'));
    else cycle.push(await a.clickTestid('fault-buggy', 'buggy widget'));
    // discovery snapshot (looks fine — false-negative trap)
    const snap = await a.snapshot();
    cycle.push(snap);
    // discriminator: console errors
    const con = await a.console();
    cycle.push(con);
    const allText = cycle.map((c) => c.text ?? '').join('\n');
    const detected = SIGNAL.test(allText);
    const snapDetected = SIGNAL.test(snap.text ?? '');
    const conDetected = SIGNAL.test(con.text ?? '');
    return {
      tool: a.name,
      cycle: cycle.map(({ text, ...r }) => r),
      detected,
      snapDetected,
      conDetected,
      conText: (con.text ?? '').slice(0, 240),
    };
  } catch (e) {
    return {
      tool: a.name,
      error: String(e).slice(0, 300),
      stderr: (a.c?.stderr ?? []).join('').slice(0, 300),
    };
  } finally {
    await a.stop();
  }
}

const which = process.argv[2];
const tools = which ? [which] : ['playwright', 'devtools', 'iris'];
const out = [];
for (const t of tools) {
  const r = await runTool(t);
  out.push(r);
  console.log(JSON.stringify(r));
}
writeFileSync('bench/raw/validate5.json', JSON.stringify(out, null, 2));
process.exit(0);
