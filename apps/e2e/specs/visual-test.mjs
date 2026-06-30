// HONESTY-CRITICAL: prove the N3 visual layer end-to-end — `reticle drive` launches a real browser,
// reticle_screenshot captures a PNG baseline to .reticle/visual/, and reticle_visual_diff perceptually
// compares a fresh capture of the same static page (→ matched) and reports baseline-missing honestly.
import os from 'node:os';
import path from 'node:path';
import nfs from 'node:fs';
import {
  start,
  TOOLS,
  BaselineStore,
  RecordingStore,
  LaunchedRealInputProvider,
  createNodeFileSystem,
} from '@reticlehq/server';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const chk = (l, o, d = '') => {
  console.log(`   ${o ? '✅' : '❌'} ${l}${d ? '  — ' + d : ''}`);
  o ? pass++ : fail++;
};

const reticleRoot = path.join(os.tmpdir(), `reticle-visual-${process.pid}`, '.reticle');
const fsp = createNodeFileSystem();
const server = await start({ port: 4400, mcp: false });
const provider = new LaunchedRealInputProvider({ driveUrl: 'http://localhost:3100/', headless: true });
await provider.navigate(); // launches Chromium + goto → page SDK connects to the bridge
const deps = {
  sessions: server.bridge.sessions,
  baselines: new BaselineStore(),
  recordings: new RecordingStore(),
  realInput: provider,
  fs: fsp,
  reticleRoot,
  now: () => Date.now(),
};
const T = (n, a = {}) => TOOLS.find((t) => t.name === n).handler(deps, { sessionId: 'next-smoke', ...a });
for (let i = 0; i < 200 && server.bridge.sessions.count() === 0; i++) await sleep(50);

console.log('\n=== N3 VISUAL: reticle drive → screenshot → visual_diff (real browser) ===');
chk('reticle drive launched a browser + the app SDK connected', server.bridge.sessions.count() > 0);

const shot = await T('reticle_screenshot', { name: 'home', fullPage: true });
chk('reticle_screenshot saved a PNG baseline to .reticle/visual/home.png', shot.saved === true && nfs.existsSync(shot.path), `${shot.bytes} bytes`);
chk('the saved file is a real PNG (magic header)', nfs.readFileSync(shot.path)[1] === 0x50 && nfs.readFileSync(shot.path)[2] === 0x4e);

const same = await T('reticle_visual_diff', { baseline: 'home', fullPage: true, maxRatio: 0.01 });
chk('reticle_visual_diff vs a fresh capture of the same page matches', same.matched === true, `ratio=${same.ratio}, changed=${same.changedPixels}`);
chk('reticle_visual_diff wrote an overlay diff PNG', typeof same.diffPath === 'string' && nfs.existsSync(same.diffPath));

const missing = await T('reticle_visual_diff', { baseline: 'never-saved' });
chk('a missing baseline is reported honestly (baseline-missing)', missing.ok === false && missing.reason === 'baseline-missing', JSON.stringify(missing).slice(0, 80));

console.log(`\n${fail === 0 ? '✅ N3 VISUAL VERIFIED' : '❌ FAILED'} (${pass} passed, ${fail} failed)`);
await provider.dispose();
await server.close();
nfs.rmSync(path.dirname(reticleRoot), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
