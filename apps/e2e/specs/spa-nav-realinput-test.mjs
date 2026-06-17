// REGRESSION (field bug #1): real input must SURVIVE SPA navigation. Before the fix, session.url
// froze at the hello "/" so CDP correlation broke after a client-side pushState and acts fell back
// to synthetic. After the fix the server consumes route.change and session.url tracks the live URL.
import { chromium } from 'playwright';
import { start, TOOLS, BaselineStore, RecordingStore, CdpRealInputProvider } from '@syrin/iris-server';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0; const chk=(l,o,d='')=>{console.log(`   ${o?'✅':'❌'} ${l}${d?'  — '+d:''}`);o?pass++:fail++;};
const browser=await chromium.launch({headless:true,args:['--remote-debugging-port=9222']});
const page=await browser.newPage();
await page.goto('http://localhost:3100/',{waitUntil:'networkidle'});
const server=await start({port:4400,mcp:false});
const provider=new CdpRealInputProvider({cdpUrl:'http://localhost:9222'});
const deps={sessions:server.bridge.sessions,baselines:new BaselineStore(),recordings:new RecordingStore(),realInput:provider};
const SID='next-smoke';
const T=(n,a={})=>TOOLS.find(t=>t.name===n).handler(deps,{sessionId:SID,...a});
for(let i=0;i<150&&server.bridge.sessions.count()===0;i++) await sleep(50);
const sess=server.bridge.sessions.resolve(SID);
const refOf=async()=>{for(let i=0;i<30;i++){const r=(await T('iris_query',{by:'testid',value:'add-task'})).elements?.[0]?.ref;if(r)return r;await sleep(100);}throw new Error('no add-task');};
console.log('\n=== bug #1: real input survives SPA navigation (real Chromium + CDP) ===');
// baseline on "/"
let ref=await refOf();
const a1=await T('iris_act',{ref,action:'click',args:{native:true}});
chk('pre-nav: iris_act is REAL', a1.inputMode==='real', `inputMode=${a1.inputMode} url=${sess.url}`);
chk('pre-nav: realInputAvailable true', (await provider.isAvailableFor(sess.url))===true);
// CLIENT-SIDE NAV (pushState) — no full reload; SDK stays connected and emits route.change
await page.evaluate(()=>history.pushState({},'','/workspace?script=42'));
for(let i=0;i<40&&!/\/workspace\?script=42/.test(sess.url);i++) await sleep(50); // wait for route.change → server
chk('after pushState: session.url tracks the SPA route (THE FIX)', /\/workspace\?script=42$/.test(sess.url), `url=${sess.url}`);
chk('after pushState: page.url matches session.url', page.url()===sess.url, `cdp=${page.url()}`);
let available=false;
for(let i=0;i<40&&!available;i++){available=await provider.isAvailableFor(sess.url);if(!available)await sleep(50);}
chk('after pushState: realInputAvailable STILL true', available);
// real input must STILL engage post-nav (the button is still mounted; pushState didn't re-render)
ref=await refOf();
const a2=await T('iris_act',{ref,action:'click',args:{native:true}});
chk('after pushState: iris_act is STILL REAL (was synthetic before the fix)', a2.inputMode==='real', `inputMode=${a2.inputMode}`);
console.log(`\n${fail===0?'✅ BUG #1 FIXED':'❌ STILL BROKEN'} (${pass} passed, ${fail} failed)`);
await browser.close(); await server.close(); process.exit(fail===0?0:1);
