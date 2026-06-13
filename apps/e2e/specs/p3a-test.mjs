import { chromium } from 'playwright';
import os from 'node:os'; import path from 'node:path'; import nfs from 'node:fs';
import { start, TOOLS, BaselineStore, RecordingStore, FlowStore, AnnotationStore, createNodeFileSystem } from '@iris/server';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0; const chk=(l,o,d='')=>{console.log(`   ${o?'✅':'❌'} ${l}${d?'  — '+d:''}`);o?pass++:fail++;};
const irisRoot=path.join(os.tmpdir(),`iris-p3a-${process.pid}`,'.iris');
const fsp=createNodeFileSystem();
const flows=new FlowStore(fsp,irisRoot,{now:()=>Date.now()});
const server=await start({port:4400,mcp:false});
const deps={sessions:server.bridge.sessions,baselines:new BaselineStore(),recordings:new RecordingStore(),flows,fs:fsp,irisRoot,annotations:new AnnotationStore()};
const T=(n,a={})=>TOOLS.find(t=>t.name===n).handler(deps,{sessionId:'next-smoke',...a});
const b=await chromium.launch({headless:true}); const p=await b.newPage();
await p.goto('http://localhost:3100/',{waitUntil:'networkidle'});
for(let i=0;i<200&&server.bridge.sessions.count()===0;i++) await sleep(50);
const refOf=async(by,value)=>{for(let i=0;i<30;i++){const r=(await T('iris_query',{by,value})).elements?.[0]?.ref;if(r)return r;await sleep(100);}throw new Error('not found '+value);};
console.log('\n=== M8 Stage A: record → .iris/ flow → replay → drift (real browser) ===');
// record + save
await T('iris_record_start',{name:'addtask'});
await T('iris_act',{ref:await refOf('testid','add-task'),action:'click'});
await T('iris_record_stop',{name:'addtask'});
const saved=await T('iris_flow_save',{name:'addtask'});
const flowFile=path.join(irisRoot,'flows','addtask.json');
chk('flow saved to .iris/flows/addtask.json on disk', nfs.existsSync(flowFile), flowFile);
const raw=nfs.readFileSync(flowFile,'utf8');
chk('flow anchors on testid (no eXX refs leaked)', raw.includes('add-task') && !/"e\d+"/.test(raw), raw.includes('"testid"')?'has testid anchors':'no testid');
const list=await T('iris_flow_list',{});
chk('iris_flow_list returns the saved flow', JSON.stringify(list).includes('addtask'));
// replay happy path
const rep=await T('iris_flow_replay',{name:'addtask'});
chk('iris_flow_replay re-resolves anchors + runs green', (rep.ok!==false)&&!rep.drift, JSON.stringify(rep).slice(0,90));
// drift: corrupt the testid, replay, expect legible drift with nearest match
nfs.writeFileSync(flowFile, raw.replaceAll('add-task','add-tassk'));
const drift=await T('iris_flow_replay',{name:'addtask'});
const ds=JSON.stringify(drift);
chk('renamed testid → legible drift with a nearest-match', /drift/i.test(ds) && /add-task/.test(ds), ds.slice(0,140));
console.log(`\n${fail===0?'✅ M8 STAGE A VERIFIED':'❌ FAILED'} (${pass} passed, ${fail} failed)`);
await b.close(); await server.close(); nfs.rmSync(path.dirname(irisRoot),{recursive:true,force:true}); process.exit(fail===0?0:1);
