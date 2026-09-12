import { chromium } from 'playwright';
import os from 'node:os'; import path from 'node:path'; import nfs from 'node:fs';
import { start, TOOLS, BaselineStore, RecordingStore, FlowStore, ProjectStore, AnnotationStore, createNodeFileSystem } from '@reticlehq/server';
import { waitForSession } from '../wait-for-session.mjs';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0; const chk=(l,o,d='')=>{console.log(`   ${o?'✅':'❌'} ${l}${d?'  — '+d:''}`);o?pass++:fail++;};
const reticleRoot=path.join(os.tmpdir(),`reticle-flow-heal-${process.pid}`,'.reticle');
const fsp=createNodeFileSystem(); const now=()=>Date.now(); const flows=new FlowStore(fsp,reticleRoot,{now}); const project=new ProjectStore(fsp,reticleRoot,{now});
const server=await start({port:4400,mcp:false});
const deps={sessions:server.bridge.sessions,baselines:new BaselineStore(),recordings:new RecordingStore(),flows,project,fs:fsp,reticleRoot,now,annotations:new AnnotationStore()};
const T=(n,a={})=>TOOLS.find(t=>t.name===n).handler(deps,{sessionId:'next-smoke',...a});
const b=await chromium.launch({headless:true}); const p=await b.newPage();
await p.goto('http://localhost:3100/');
await waitForSession(()=>server.bridge.sessions.list(), 'next-smoke');
const refOf=async(by,v)=>{for(let i=0;i<30;i++){const r=(await T('reticle_query',{by,value:v})).elements?.[0]?.ref;if(r)return r;await sleep(100);}throw new Error('nf '+v);};
console.log('\n=== self-healing rebind (real browser) ===');
await T('reticle_record',{action:'start',recordingName:'ht'});
await T('reticle_act',{ref:await refOf('testid','add-task'),action:'click'});
// A CONSEQUENCE, because heal refuses a flow that has none: a rebind is only safe if something
// could catch one that pointed at the wrong element, and "the element is there" is exactly what a
// wrong rebind makes true. The page registers its state with useReticleStore, so the item count is
// a source of truth no DOM read can reach.
const annotated=await T('reticle_annotate',{flow:'ht',kind:'success-state',statePath:'items',store:'page'});
// Asserted, not assumed. The first version of this line passed the annotation nested and under the
// wrong key; it was refused, the spec ignored the refusal, and the flow went on being consequence-free
// while looking annotated. A setup step whose failure is invisible is a setup step that will fail.
chk('the flow is given an observable consequence to heal against', annotated.ok!==false, JSON.stringify(annotated).slice(0,120));
await T('reticle_record',{action:'stop',recordingName:'ht'});
await T('reticle_flow_save',{flowName:'ht'});
const file=path.join(reticleRoot,'flows','ht.json');
// corrupt the testid
nfs.writeFileSync(file, nfs.readFileSync(file,'utf8').replaceAll('add-task','add-tassk'));
const bytesBefore=nfs.readFileSync(file,'utf8');
const proposeOnly=await T('reticle_flow_heal',{flowName:'ht',apply:false});
chk('heal(apply:false) proposes a rebind but does NOT write', /add-task/.test(JSON.stringify(proposeOnly)) && nfs.readFileSync(file,'utf8')===bytesBefore, JSON.stringify(proposeOnly).slice(0,120));
const applied=await T('reticle_flow_heal',{flowName:'ht',apply:true});
chk('heal(apply:true) rewrites the anchor back to add-task', nfs.readFileSync(file,'utf8').includes('add-task') && applied.applied===true, JSON.stringify(applied).slice(0,110));
const rep=await T('reticle_flow_replay',{flowName:'ht'});
chk('replay is green again after self-heal', rep.status==='ok'||rep.ok!==false&&!rep.drift, JSON.stringify(rep).slice(0,90));

// The rule the gate exists for, driven rather than asserted in a unit: a flow with NO consequence
// has nothing to check a rebind against, so healing it would produce a flow that passes forever and
// proves nothing — worse than the drift it replaced, which was at least visible.
await T('reticle_record',{action:'start',recordingName:'bare'});
await T('reticle_act',{ref:await refOf('testid','add-task'),action:'click'});
await T('reticle_record',{action:'stop',recordingName:'bare'});
await T('reticle_flow_save',{flowName:'bare'});
const bareFile=path.join(reticleRoot,'flows','bare.json');
nfs.writeFileSync(bareFile, nfs.readFileSync(bareFile,'utf8').replaceAll('add-task','add-tassk'));
const bareBytes=nfs.readFileSync(bareFile,'utf8');
const refused=await T('reticle_flow_heal',{flowName:'bare',apply:true});
chk('REFUSES to heal a flow with no consequence, and leaves the file alone',
  refused.status==='unfalsifiable' && refused.applied===false && refused.proposals.length===1
  && nfs.readFileSync(bareFile,'utf8')===bareBytes, JSON.stringify(refused).slice(0,120));
console.log(`\n${fail===0?'✅ SELF-HEAL VERIFIED':'❌ FAILED'} (${pass} passed, ${fail} failed)`);
await b.close(); await server.close(); nfs.rmSync(path.dirname(reticleRoot),{recursive:true,force:true}); process.exit(fail===0?0:1);
