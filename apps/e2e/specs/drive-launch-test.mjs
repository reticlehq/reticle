// HONESTY-CRITICAL: prove `reticle drive` LAUNCHES its own browser, navigates to the app, and drives
// the hover-gated smart-sentence with inputMode:"real" — headless, no manual CDP flags.
import { start, TOOLS, BaselineStore, RecordingStore, LaunchedRealInputProvider } from '@reticlehq/server';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0; const chk=(l,o,d='')=>{console.log(`   ${o?'✅':'❌'} ${l}${d?'  — '+d:''}`);o?pass++:fail++;};
const server=await start({port:4400,mcp:false});
const provider=new LaunchedRealInputProvider({driveUrl:'http://localhost:3100/',headless:true});
await provider.navigate(); // launches Chromium + goto → page SDK connects to the bridge
const deps={sessions:server.bridge.sessions,baselines:new BaselineStore(),recordings:new RecordingStore(),realInput:provider};
const T=(n,a={})=>TOOLS.find(t=>t.name===n).handler(deps,{sessionId:'next-smoke',...a});
for(let i=0;i<200&&server.bridge.sessions.count()===0;i++) await sleep(50);
console.log('\n=== reticle drive (launched browser) vs smart-sentence, headless ===');
chk('reticle drive launched a browser + the app SDK connected', server.bridge.sessions.count()>0, `sessions=${server.bridge.sessions.count()}`);
const sess=server.bridge.sessions.resolve('next-smoke');
const refOf=async(by,value)=>{for(let i=0;i<30;i++){const r=(await T('reticle_query',{by,value})).elements?.[0]?.ref;if(r)return r;await sleep(100);}throw new Error('not found '+value);};
const ref=await refOf('testid','smart-sentence');
const before=sess.eventsSince(0).filter(e=>e.type==='signal'&&e.data?.name==='hover:enter').length;
const hov=await T('reticle_act',{ref,action:'hover'});
chk('reticle_act{hover} reports inputMode:"real" via the launched browser', hov.inputMode==='real', `inputMode=${hov.inputMode}`);
await sleep(750);
const enter=sess.eventsSince(0).filter(e=>e.type==='signal'&&e.data?.name==='hover:enter').length;
chk('native onMouseEnter fires (hover:enter signal)', enter>before, `enter ${before}->${enter}`);
const words=(await T('reticle_query',{by:'testid',value:'word:0'})).elements?.length??0;
chk('hover-gated words mount headless (no foreground tab needed)', words>0, `word:0=${words}`);
console.log(`\n${fail===0?'✅ P2 RETICLE DRIVE VERIFIED':'❌ FAILED'} (${pass} passed, ${fail} failed)`);
await provider.dispose(); await server.close(); process.exit(fail===0?0:1);
