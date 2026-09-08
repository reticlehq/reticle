import { chromium } from 'playwright';
import { start, TOOLS, BaselineStore, RecordingStore } from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const deps={sessions:null,baselines:new BaselineStore(),recordings:new RecordingStore()};
const T=(n,a={})=>TOOLS.find(t=>t.name===n).handler(deps,{sessionId:'next-smoke',...a});
let pass=0,fail=0; const chk=(l,o,d='')=>{console.log(`   ${o?'✅':'❌'} ${l}${d?'  — '+d:''}`);o?pass++:fail++;};
const server=await start({port:4400,mcp:false}); deps.sessions=server.bridge.sessions;
const b=await chromium.launch({headless:true}); const p=await b.newPage();
await p.goto('http://localhost:3100/');
await waitForSession(()=>server.bridge.sessions.list(), 'next-smoke');
const sess=server.bridge.sessions.resolve('next-smoke');
const ref=(await T('reticle_query',{by:'testid',value:'add-task'})).elements[0].ref;
console.log('\n=== live control: human pause + prompt + resume + agent end (real browser) ===');
// Reach the toolbar without assuming which way the HUD starts. It used to start collapsed to the
// FAB, so this clicked the FAB unconditionally; now the chat opens at session start and that same
// click COLLAPSES it, after which every control below is missing. Asking what is on screen works
// under either default, so the next person to change one does not have to find this line.
if (!(await p.isVisible('[data-reticle-pause]'))) { await p.click('[data-reticle-fab]'); await sleep(200); }
// HUMAN clicks Pause on the panel
await p.click('[data-reticle-pause]'); await sleep(300);
chk('human Pause → server session state = paused', sess.getState?.()==='paused', `state=${sess.getState?.()}`);
// The HUD's composer is GONE, and with it the only producer of a HUMAN_CONTROL carrying `text`.
// It was two text boxes that looked like the agent's chat and were not, with nothing on screen
// saying which one you were in — there is no wording fix for that, so the panel was deleted rather
// than relabelled. Guidance is typed in the agent's own chat now.
//
// So this spec no longer types anything. `HUMAN_CONTROL.text` survives in the wire contract and the
// server still short-circuits a paused act with it, but nothing emits one, and an e2e battery
// cannot cover a path with no producer. What IS still the live-control loop — pause blocks the
// agent, resume releases it, end is pushed to the panel — is asserted below and unchanged.
const act=await T('reticle_act',{ref,action:'click'});
const js=JSON.stringify(act);
chk('agent reticle_act while paused → paused:true (action NOT performed)', act.paused===true && act.result===undefined, js.slice(0,90));
// HUMAN clicks Resume (same button toggles)
await p.click('[data-reticle-pause]'); await sleep(300);
chk('human Resume → server state = active', sess.getState?.()==='active', `state=${sess.getState?.()}`);
const act2=await T('reticle_act',{ref,action:'click'});
chk('agent reticle_act after resume → executes (not paused)', act2.paused!==true && !!act2.result, JSON.stringify(act2).slice(0,70));
// AGENT ends the session → server pushes PRESENTER → panel shows ended
await T('reticle_session',{action:'end',summary:'12 checks passed'}); await sleep(400);
const panelState=await p.evaluate(()=>document.querySelector('div[data-reticle-overlay]')?.getAttribute('data-reticle-state'));
const banner=await p.evaluate(()=>(document.querySelector('[data-reticle-banner]')?.textContent||'').trim());
chk('agent reticle_end_session → server state ended', sess.getState?.()==='ended', `state=${sess.getState?.()}`);
chk('agent end pushes PRESENTER → panel shows "ended" + banner', panelState==='ended' && /ended/i.test(banner), `panel=${panelState} banner="${banner}"`);
console.log(`\n${fail===0?'✅ LIVE CONTROL VERIFIED':'❌ FAILED'} (${pass} passed, ${fail} failed)`);
await b.close(); await server.close(); process.exit(fail===0?0:1);
