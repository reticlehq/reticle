import { chromium } from 'playwright';
import os from 'node:os'; import path from 'node:path'; import nfs from 'node:fs';
import { start, TOOLS, BaselineStore, RecordingStore, FlowStore, ProjectStore, AnnotationStore, createNodeFileSystem } from '@reticle/server';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0; const chk=(l,o,d='')=>{console.log(`   ${o?'✅':'❌'} ${l}${d?'  — '+d:''}`);o?pass++:fail++;};
const reticleRoot=path.join(os.tmpdir(),`reticle-flow-record-${process.pid}`,'.reticle');
const fsp=createNodeFileSystem();
const now=()=>Date.now();
const flows=new FlowStore(fsp,reticleRoot,{now});
const project=new ProjectStore(fsp,reticleRoot,{now});
const server=await start({port:4400,mcp:false});
const deps={sessions:server.bridge.sessions,baselines:new BaselineStore(),recordings:new RecordingStore(),flows,project,fs:fsp,reticleRoot,now,annotations:new AnnotationStore()};
const T=(n,a={})=>TOOLS.find(t=>t.name===n).handler(deps,{sessionId:'next-smoke',...a});
const b=await chromium.launch({headless:true}); const p=await b.newPage();
await p.goto('http://localhost:3100/',{waitUntil:'networkidle'});
for(let i=0;i<200&&server.bridge.sessions.count()===0;i++) await sleep(50);
const refOf=async(by,value)=>{for(let i=0;i<30;i++){const r=(await T('reticle_query',{by,value})).elements?.[0]?.ref;if(r)return r;await sleep(100);}throw new Error('not found '+value);};
console.log('\n=== record → .reticle/ flow → replay → drift (real browser) ===');
// record + save
await T('reticle_record_start',{recordingName:'addtask'});
await T('reticle_act',{ref:await refOf('testid','add-task'),action:'click'});
await T('reticle_record_stop',{recordingName:'addtask'});
const saved=await T('reticle_flow_save',{flowName:'addtask'});
const flowFile=path.join(reticleRoot,'flows','addtask.json');
chk('flow saved to .reticle/flows/addtask.json on disk', nfs.existsSync(flowFile), flowFile);
const raw=nfs.readFileSync(flowFile,'utf8');
chk('flow anchors on testid (no eXX refs leaked)', raw.includes('add-task') && !/"e\d+"/.test(raw), raw.includes('"testid"')?'has testid anchors':'no testid');
const list=await T('reticle_flow_list',{});
chk('reticle_flow_list returns the saved flow', JSON.stringify(list).includes('addtask'));
// replay happy path
const rep=await T('reticle_flow_replay',{flowName:'addtask'});
chk('reticle_flow_replay re-resolves anchors + runs green', (rep.ok!==false)&&!rep.drift, JSON.stringify(rep).slice(0,90));
// drift: corrupt the testid, replay, expect legible drift with nearest match
nfs.writeFileSync(flowFile, raw.replaceAll('add-task','add-tassk'));
const drift=await T('reticle_flow_replay',{flowName:'addtask'});
const ds=JSON.stringify(drift);
chk('renamed testid → legible drift with a nearest-match', /drift/i.test(ds) && /add-task/.test(ds), ds.slice(0,140));
console.log(`\n${fail===0?'✅ FLOW RECORD→REPLAY VERIFIED':'❌ FAILED'} (${pass} passed, ${fail} failed)`);
await b.close(); await server.close(); nfs.rmSync(path.dirname(reticleRoot),{recursive:true,force:true}); process.exit(fail===0?0:1);
