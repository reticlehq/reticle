// HONESTY-CRITICAL: prove 0.3.7 cross-run memory works through the FULL path — a real browser
// session + real FlowStore/ProjectStore on real disk. Record a flow, replay it twice, and verify
// .reticle/project.json accumulates flow_replay run records AND reticle_project returns a diff-vs-last.
import { chromium } from 'playwright';
import os from 'node:os'; import path from 'node:path'; import nfs from 'node:fs';
import { start, TOOLS, BaselineStore, RecordingStore, FlowStore, ProjectStore, AnnotationStore, createNodeFileSystem } from '@reticle/server';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0; const chk=(l,o,d='')=>{console.log(`   ${o?'✅':'❌'} ${l}${d?'  — '+d:''}`);o?pass++:fail++;};
const reticleRoot=path.join(os.tmpdir(),`reticle-projhist-${process.pid}`,'.reticle');
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

console.log('\n=== 0.3.7 RUNHISTORY: replay → .reticle/project.json → reticle_project diff (real browser) ===');

// Record + save a one-step flow.
await T('reticle_record_start',{recordingName:'addtask'});
await T('reticle_act',{ref:await refOf('testid','add-task'),action:'click'});
await T('reticle_record_stop',{recordingName:'addtask'});
await T('reticle_flow_save',{flowName:'addtask'});

// Replay twice — each replay should auto-record a run.
await T('reticle_flow_replay',{flowName:'addtask'});
await T('reticle_flow_replay',{flowName:'addtask'});

// 1) project.json exists on disk and holds flow_replay records.
const projFile=path.join(reticleRoot,'project.json');
chk('.reticle/project.json written to disk', nfs.existsSync(projFile), projFile);
const onDisk=JSON.parse(nfs.readFileSync(projFile,'utf8'));
chk('two flow_replay runs recorded', onDisk.runs.filter(r=>r.kind==='flow_replay'&&r.name==='addtask').length===2, `runs=${onDisk.runs.length}`);
chk('each run carries status + driftSteps evidence + at', onDisk.runs.every(r=>r.status&&r.evidence&&typeof r.at==='number'), JSON.stringify(onDisk.runs[0]).slice(0,120));

// 2) reticle_project { name } returns scoped history + lastRun + diff-vs-last.
const proj=await T('reticle_project',{name:'addtask'});
chk('reticle_project returns scoped runs', Array.isArray(proj.runs)&&proj.runs.length===2, `runs=${proj.runs?.length}`);
chk('reticle_project returns lastRun', proj.lastRun&&proj.lastRun.name==='addtask', JSON.stringify(proj.lastRun)?.slice(0,80));
chk('reticle_project returns a diff-vs-last block', proj.diff&&typeof proj.diff.regressed==='boolean', JSON.stringify(proj.diff)?.slice(0,100));

// 3) reticle_run_record appends a manual run that lastRun then sees.
await T('reticle_run_record',{name:'addtask',status:'pass',summary:'manual smoke'});
const after=await T('reticle_project',{name:'addtask'});
chk('reticle_run_record appends a manual run', after.lastRun?.kind==='manual'&&after.lastRun?.summary==='manual smoke', JSON.stringify(after.lastRun)?.slice(0,100));

console.log(`\n${fail===0?'✅ RUNHISTORY VERIFIED':'❌ FAILED'} (${pass} passed, ${fail} failed)`);
await b.close(); await server.close(); nfs.rmSync(path.dirname(reticleRoot),{recursive:true,force:true}); process.exit(fail===0?0:1);
