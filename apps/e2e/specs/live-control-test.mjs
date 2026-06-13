import { chromium } from 'playwright';
import { start, TOOLS, BaselineStore, RecordingStore } from '@syrin/iris-server';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const deps={sessions:null,baselines:new BaselineStore(),recordings:new RecordingStore()};
const T=(n,a={})=>TOOLS.find(t=>t.name===n).handler(deps,{sessionId:'next-smoke',...a});
let pass=0,fail=0; const chk=(l,o,d='')=>{console.log(`   ${o?'✅':'❌'} ${l}${d?'  — '+d:''}`);o?pass++:fail++;};
const server=await start({port:4400,mcp:false}); deps.sessions=server.bridge.sessions;
const b=await chromium.launch({headless:true}); const p=await b.newPage();
await p.goto('http://localhost:3100/',{waitUntil:'networkidle'});
for(let i=0;i<200&&server.bridge.sessions.count()===0;i++) await sleep(50);
const sess=server.bridge.sessions.resolve('next-smoke');
const ref=(await T('iris_query',{by:'testid',value:'add-task'})).elements[0].ref;
console.log('\n=== live control: human pause + prompt + resume + agent end (real browser) ===');
// HUMAN clicks Pause on the panel
await p.click('[data-iris-pause]'); await sleep(300);
chk('human Pause → server session state = paused', sess.getState?.()==='paused', `state=${sess.getState?.()}`);
// HUMAN types guidance + Send
await p.fill('[data-iris-input]','please slow down and check the list'); await p.click('[data-iris-send]'); await sleep(300);
// AGENT's next act is short-circuited with the guidance
const act=await T('iris_act',{ref,action:'click'});
const js=JSON.stringify(act);
chk('agent iris_act while paused → paused:true (action NOT performed)', act.paused===true && act.result===undefined, js.slice(0,90));
chk('agent receives the human guidance on that result', /please slow down/.test(js), (js.match(/please slow down[^"]*/)?.[0]||'(none)'));
// HUMAN clicks Resume (same button toggles)
await p.click('[data-iris-pause]'); await sleep(300);
chk('human Resume → server state = active', sess.getState?.()==='active', `state=${sess.getState?.()}`);
const act2=await T('iris_act',{ref,action:'click'});
chk('agent iris_act after resume → executes (not paused)', act2.paused!==true && !!act2.result, JSON.stringify(act2).slice(0,70));
// AGENT ends the session → server pushes PRESENTER → panel shows ended
await T('iris_end_session',{summary:'12 checks passed'}); await sleep(400);
const panelState=await p.evaluate(()=>document.querySelector('div[data-iris-overlay]')?.getAttribute('data-iris-state'));
const banner=await p.evaluate(()=>(document.querySelector('[data-iris-banner]')?.textContent||'').trim());
chk('agent iris_end_session → server state ended', sess.getState?.()==='ended', `state=${sess.getState?.()}`);
chk('agent end pushes PRESENTER → panel shows "ended" + banner', panelState==='ended' && /ended/i.test(banner), `panel=${panelState} banner="${banner}"`);
console.log(`\n${fail===0?'✅ LIVE CONTROL VERIFIED':'❌ FAILED'} (${pass} passed, ${fail} failed)`);
await b.close(); await server.close(); process.exit(fail===0?0:1);
