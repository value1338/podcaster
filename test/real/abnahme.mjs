import * as fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile), hash=b=>createHash('sha256').update(b).digest('hex');
const check=(v,code)=>{if(!v)throw Error(code);};
export function reserveCost(e,p){
 check([e.reserveTokens,e.maxOutputTokens].every(x=>Number.isSafeInteger(x)&&x>=0)&&e.reserveTokens>=e.maxOutputTokens,'estimate_invalid');
 check([p.inputMicroPerMTok,p.outputMicroPerMTok].every(x=>Number.isSafeInteger(x)&&x>0),'price_invalid');
 const a=(e.reserveTokens-e.maxOutputTokens)*p.inputMicroPerMTok,b=e.maxOutputTokens*p.outputMicroPerMTok;
 check([a,b,a+b].every(Number.isSafeInteger),'estimate_overflow');return Math.ceil((a+b)/1e6);
}
export async function run(argv=process.argv.slice(2)){
 const o={};for(let i=0;i<argv.length;i++){const k=argv[i];check(k.startsWith('--'),'argument');o[k.slice(2)]=k==='--ohne-modellpruefung'?true:argv[++i];}
 let stage='prereqs',app,dir,cookie,origin;const evidence={},usage=[],jobs=[],created=[],abort=new AbortController();
 const stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 let out,failed,archiveBase,archiveIdentity,archiveTarget,archivePlan,archiveJob,archiveComplete=false;
 const ownEvidence=new Map();
 const secret=b=>['OPENAI_API_KEY','STUDIO_ASR_TOKEN'].some(k=>process.env[k]&&b.includes(Buffer.from(process.env[k])));
 const identity=async f=>{const s=await fs.lstat(f);check(s.isDirectory()&&!s.isSymbolicLink()&&await fs.realpath(f)===f,'archive_identity');return {dev:s.dev,ino:s.ino};};
 const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
 const writeOwn=async(name,b)=>{check(!secret(b),'secret_detected');const f=path.join(out,name),h=await fs.open(f,'wx',0o600);const st=await h.stat();ownEvidence.set(name,{dev:st.dev,ino:st.ino});try{await h.writeFile(b);await h.sync();}finally{await h.close();}ownEvidence.set(name,{dev:st.dev,ino:st.ino,sha256:hash(b)});const parent=await fs.open(out,'r');try{await parent.sync();}finally{await parent.close();}};
 const save=async(name,v)=>writeOwn(name,Buffer.from(JSON.stringify(v,null,2)));
 const removeSecretEvidence=async()=>{for(const [name,owned] of ownEvidence){if(name.startsWith('archive-cleanup-'))continue;const f=path.join(out,name),st=await fs.lstat(f);if(same(st,owned)&&st.isFile()&&secret(await fs.readFile(f)))await fs.unlink(f);}};

 try{
  check(o.server&&o.audio&&o.out&&o.stufen,'required_arguments');const server=path.resolve(o.server),root=path.dirname(server);
  for(const f of [server,path.join(root,'db.mjs'),path.join(root,'migrate.mjs'),path.join(root,'accounts.mjs'),path.resolve(o.audio)])check((await fs.stat(f)).isFile(),'prerequisite_file');
  await exec('ffmpeg',['-version']);await exec('ffprobe',['-version']);
  const stages=o.stufen.split(',');check(stages.every(x=>['asr','llm','archiv','archiv-ausfall'].includes(x))&&new Set(stages).size===stages.length,'stufen_invalid');check(!(stages.includes('archiv')&&stages.includes('archiv-ausfall')),'archive_stages_exclusive');
  const test=o['ohne-modellpruefung']===true;check(!test||process.env.NODE_ENV==='test'&&process.env.RA5_FIXTURE==='1','test_only');
  const budget=Number(o.testbudget??200000),platform=Number(o.kostendeckel??1000000);check(Number.isSafeInteger(budget)&&budget>0&&budget<=200000&&Number.isSafeInteger(platform)&&platform>0&&platform<=1000000,'budget_invalid');
  let prices,model=process.env.RA5_LLM_MODEL;
  if(stages.includes('llm')){prices={inputMicroPerMTok:Number(process.env.RA5_INPUT_MICRO_PER_MTOK),outputMicroPerMTok:Number(process.env.RA5_OUTPUT_MICRO_PER_MTOK)};check(model&&Object.values(prices).every(x=>Number.isSafeInteger(x)&&x>0),'explicit_model_prices_required');check(process.env.STUDIO_LLM_DRIVER==='openai'&&process.env.OPENAI_API_KEY,'llm_configuration_required');}
  stage='audio';let probe;try{probe=JSON.parse((await exec('ffprobe',['-v','error','-show_format','-of','json',o.audio])).stdout);}catch{throw Error('audio_invalid');}
  const durationMs=Math.round(Number(probe.format.duration)*1000);check(Number.isSafeInteger(durationMs)&&durationMs>0,'audio_duration');
  const mime={'.wav':'audio/wav','.mp3':'audio/mpeg','.mp4':'audio/mp4','.webm':'audio/webm'}[path.extname(o.audio).toLowerCase()];check(mime,'audio_format');stage='prereqs';
  const candidate=path.resolve(o.out);await fs.mkdir(candidate,{recursive:false,mode:0o700});out=candidate;
  dir=await fs.mkdtemp(new URL('.studio-ra5-',import.meta.url).pathname);
  const load=f=>import(pathToFileURL(path.join(root,f)).href);
  const [{openDB},{migrate},{ownerCreate},{createStudioServer}]=await Promise.all(['db.mjs','migrate.mjs','accounts.mjs',path.basename(server)].map(load));
  const email='ra5-'+randomUUID()+'@example.test';const file=path.join(dir,'studio.sqlite'),db=openDB(file);let link;
  try{await migrate(db,file);link=ownerCreate({db,base:''},email,'RA5 synthetic');}finally{db.close();}
  // Bootstrap ends here. API workflow below; the only later DB read is the exact
  // transcript snapshot for pre-dispatch cleanup ownership (no DB mutations).
  app=await createStudioServer({dataDir:dir,base:'',origins:'http://127.0.0.1',cookieInsecure:true});
  if(test){const fixture=await import('./fixture.mjs');await fixture.archive(app,path.join(dir,'archive-fixture'),stages.includes('archiv-ausfall'));}
  await new Promise((r,j)=>{app.server.once('error',j);app.server.listen(0,'127.0.0.1',r);});origin='http://127.0.0.1:'+app.server.address().port;
  const req=async(m,p,b,raw=false)=>{abort.signal.throwIfAborted();return fetch(origin+'/api'+p,{method:m,redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15000)]),headers:{Origin:'http://127.0.0.1','X-Studio':'1',...(cookie?{Cookie:cookie}:{}),'Content-Type':raw?'application/octet-stream':'application/json',...(m==='POST'?{'Idempotency-Key':randomUUID()}: {})},body:b===undefined?undefined:raw?b:JSON.stringify(b)});};
  const json=async(m,p,b)=>{const r=await req(m,p,b);check(r.ok,'http_'+r.status+'_'+stage);return r.json();};
  const snapshot=async label=>usage.push({label,account:await json('GET','/account/usage'),admin:await json('GET','/admin/usage')});
  const wait=async getter=>{for(let i=0;i<1200;i++){abort.signal.throwIfAborted();const v=await getter();if(v.status==='ready'||['succeeded','failed','canceled'].includes(v.status))return v;await new Promise(r=>setTimeout(r,250));}throw Error('timeout_'+stage);};
  const job=async(m,p,b)=>{const j=await json(m,p,b);await snapshot(stage+'_submitted');const end=await wait(()=>json('GET','/jobs/'+j.id));jobs.push(end);check(end.status==='succeeded',end.errorCode??'job_failed');return end;};
  stage='bootstrap';const password=randomUUID()+randomUUID();await json('POST','/auth/token/'+link.url.split('/').at(-1),{password});
  const login=await req('POST','/auth/login',{email,password});
  // Owner link does not expose email in every version: synthetic address retained below.
  let owner;if(login.ok){cookie=login.headers.get('set-cookie')?.split(';')[0];owner=(await login.json()).user.id;}
  check(cookie,'login_failed');
  await json('PUT','/admin/settings',{asrRequireGpu:true,asrWindowSeconds:300,archiveMode:'manual',archiveEvictAfterDays:null,llmGlobalCostMicroMonth:platform,...(prices?{llmModel:model,llmPrices:prices}:{})});
  evidence.faehigkeiten=await json('GET','/capabilities');for(const service of ['asr','llm'])if(stages.includes(service)||service==='asr'&&stages.includes('llm'))check(evidence.faehigkeiten[service].state==='ready',service+'_configuration_required');await snapshot('before');
  stage='upload';const p=await json('POST','/projects',{title:'RA5 synthetic'}),audio=await fs.readFile(o.audio);
  const {track:t}=await json('POST','/projects/'+p.id+'/recordings',{title:'RA5 upload',kind:'audio',mimeType:mime,participantName:'Synthetic',startedAtMs:null,source:'upload',declaredBytes:audio.length});
  let chunks=0;for(let pos=0;pos<audio.length;pos+=8*1024**2){check((await req('PUT',`/tracks/${t.id}/chunks/${chunks++}`,audio.subarray(pos,pos+8*1024**2),true)).ok,'upload_failed');}
  await json('POST',`/tracks/${t.id}/finalize`,{chunkCount:chunks,durationMs});let track=await wait(()=>json('GET','/tracks/'+t.id));check(track.status==='ready','track_failed');
  const local=await req('GET',`/tracks/${t.id}/file`),localHash=hash(Buffer.from(await local.arrayBuffer()));check(localHash===track.sha256,'local_hash');
  if(stages.includes('asr')||stages.includes('llm')){stage='asr';await snapshot('asr_before');const start=performance.now(),j=await job('POST',`/tracks/${t.id}/transcription`,{language:'de'}),tr=await json('GET',`/tracks/${t.id}/transcript`);const elapsedMs=performance.now()-start;
   evidence.asr={job:j,device:tr.device,timestamps:tr.timestamps,segments:tr.segments.length,words:tr.segments.reduce((n,s)=>n+(s.words?.length??0),0),elapsedMs,durationMs,realtimeFactor:elapsedMs/durationMs,preview:tr.segments.map(s=>s.text).join(' ').slice(0,200),windowCount:j.progress??null};
   evidence.stichprobe=[];for(const s of [...tr.segments].sort(()=>Math.random()-.5).slice(0,5)){const n=evidence.stichprobe.length;const dest=path.join(dir,`seg-${n}.wav`);await exec('ffmpeg',['-v','error','-i',o.audio,'-ss',String(s.startMs/1000),'-t',String((s.endMs-s.startMs)/1000),dest]);await writeOwn(path.basename(dest),await fs.readFile(dest));evidence.stichprobe.push({startMs:s.startMs,endMs:s.endMs,text:s.text.slice(0,200),file:path.basename(dest)});}
   evidence.subtitles={};for(const f of ['srt','vtt']){const r=await req('GET',`/tracks/${t.id}/transcript/file?format=${f}`);check(r.ok,'subtitles_unavailable');evidence.subtitles[f]={sha256:hash(Buffer.from(await r.arrayBuffer()))};}await snapshot('asr_after');check(usage.at(-1).account.asrSeconds.used-usage.find(x=>x.label==='asr_before').account.asrSeconds.used===Math.ceil(durationMs/1000),'asr_usage');}
  if(stages.includes('llm')){stage='llm';if(!test){const base=new URL(process.env.STUDIO_LLM_BASE_URL??'https://api.openai.com/v1');check(!base.username&&!base.password&&!base.search&&!base.hash&&base.protocol==='https:','model_url');const r=await fetch(base.href.replace(/\/$/,'')+'/models/'+encodeURIComponent(model),{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY}});check(r.ok,'model_access');await r.body?.cancel();}evidence.llm={modelCheck:test?'SKIPPED TEST ONLY':'200',prices,model,tasks:[]};let charged=0,unclear=0;
   await json('PUT','/admin/settings',{llmGlobalCostMicroMonth:1});const capInput={task:'titles',trackId:t.id},capEstimate=await json('POST','/llm/estimate',{projectId:p.id,...capInput});const denied=await req('POST',`/projects/${p.id}/generations`,{...capInput,consent:{provider:capEstimate.provider,model:capEstimate.model,dataScope:capEstimate.dataScope}});check(denied.status===402,'platform_cap_not_enforced');await denied.body?.cancel();await json('PUT','/admin/settings',{llmGlobalCostMicroMonth:platform});evidence.llm.capProbe={status:402,estimate:capEstimate};
   for(const task of ['titles','chapters','shownotes','social','marketer_plan','producer_outline']){await snapshot(task+'_before');const input={task,...(task==='producer_outline'?{brief:'Synthetisches Gespräch planen'}:{trackId:t.id})};const e=await json('POST','/llm/estimate',{projectId:p.id,...input}),reserve=reserveCost(e,prices);check(e.allowed&&Number.isSafeInteger(reserve)&&Number.isSafeInteger(charged+reserve)&&charged+reserve<=budget,'test_budget_exhausted');
    const j=await json('POST',`/projects/${p.id}/generations`,{...input,consent:{provider:e.provider,model:e.model,dataScope:e.dataScope}});await snapshot(task+'_submitted');const end=await wait(()=>json('GET','/jobs/'+j.id));jobs.push(end);await snapshot(task+'_after');charged=usage.at(-1).admin.platform.llmCostMicro.used;unclear=end.unclear?unclear+1:0;
    const g=end.result?.generationId?await json('GET','/generations/'+end.result.generationId):null;evidence.llm.tasks.push({task,estimate:e,reserve,job:end,inputTokens:g?.inputTokens,outputTokens:g?.outputTokens,usageEstimated:g?.usageEstimated,chargedTotal:charged,recomputed:g&&!g.usageEstimated?Math.ceil((g.inputTokens*prices.inputMicroPerMTok+g.outputTokens*prices.outputMicroPerMTok)/1e6):null});check(charged<=budget&&unclear<2,'cost_or_unclear_stop');check(end.status==='succeeded',end.errorCode??'llm_failed');}
  }
  for(const s of stages.filter(x=>x.startsWith('archiv'))){stage=s;await snapshot(s+'_before');const status=await json('GET','/admin/archive');if(s==='archiv-ausfall'){const before=track.archive??null,r=await req('POST',`/admin/tracks/${t.id}/archive`,{});check(r.status===503,'outage_expected');const b=await r.json();check(b.error?.code==='archive_unavailable'||b.code==='archive_unavailable','outage_code');track=await json('GET','/tracks/'+t.id);check(track.local!==false&&JSON.stringify(track.archive??null)===JSON.stringify(before),'outage_mutation');evidence.archiv={status,expectedFailure:true};}else{
   // Exact first-snapshot names from archiveHandler; no versions or backups are eligible.
   if(!test){const ar=path.resolve(process.env.STUDIO_ARCHIVE_PATH??'');archiveTarget=app.ctx.archive;await archiveTarget.preflight();archiveIdentity={root:ar,...await identity(ar)};
    archiveBase=path.join(ar,'konten',owner,p.id,track.recordingId,t.id);
    try{await fs.lstat(archiveBase);throw Error('archive_path_exists');}catch(e){if(e.code!=='ENOENT')throw e;}
    const ext={'audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'mp4','audio/webm':'webm'}[track.mimeType];check(ext,'archive_extension');
    const tr=app.ctx.db.sql.prepare('SELECT * FROM transcripts WHERE track_id=?').get(t.id);
    archivePlan={directory:archiveBase,expectedNames:['original.'+ext,'manifest.json',...(tr?['transkript.json']:[])],hashes:{['original.'+ext]:localHash,...(tr?{'transkript.json':hash(JSON.stringify(tr))}:{})},manifest:{trackId:t.id,ownerId:owner,projectTitle:p.title,recordingTitle:'RA5 upload',participantName:'Synthetic',mimeType:track.mimeType,bytes:track.bytes,sha256:localHash,durationMs:track.durationMs,schema:1},identity:archiveIdentity};
    created.push(archivePlan);await save('archive-cleanup-intent.json',archivePlan);
   }
   const j=await json('POST',`/admin/tracks/${t.id}/archive`,{});archiveJob=j;
   if(archivePlan)await save('archive-cleanup-dispatch.json',{job:j,manifest:archivePlan.manifest});
   await snapshot(stage+'_submitted');const end=await wait(()=>json('GET','/jobs/'+j.id));jobs.push(end);check(end.status==='succeeded',end.errorCode??'job_failed');archiveComplete=true;
   track=await json('GET','/tracks/'+t.id);check(track.archive?.status==='verified','archive_unverified');evidence.archiv={status,job:end,archive:track.archive,localHash,trackHash:track.sha256};}await snapshot(s+'_after');}
  evidence.result={ok:true,testOnly:test};
 }catch(e){failed=true;evidence.result={ok:false,stage,code:abort.signal.aborted?'signal_aborted':/^[a-zA-Z0-9_]+$/.test(e.message)?e.message:'internal'};}
 finally{
  if(app)await app.close().catch(()=>{failed=true;evidence.cleanupError='server_stop_failed_preserve_ledger';});
  if(archiveBase){try{
   // Any dispatch uncertainty or partial write is retained for manual reconciliation.
   check(!evidence.cleanupError&&archiveComplete&&archiveJob,'cleanup_dispatch_uncertain');
   const preflight=async()=>{await archiveTarget.preflight();check(same(await identity(archiveIdentity.root),archiveIdentity),'cleanup_identity_changed');};
   await preflight();const baseIdentity=await identity(archiveBase),entries=await fs.readdir(archiveBase);
   check(entries.every(n=>archivePlan.expectedNames.includes(n))&&archivePlan.expectedNames.every(n=>entries.includes(n)),'cleanup_unknown_object');
   const manifest=JSON.parse(await fs.readFile(path.join(archiveBase,'manifest.json'),'utf8'));
   check(manifest.archivedAt===archiveJob.createdAt&&Object.keys(manifest).length===Object.keys(archivePlan.manifest).length+1&&Object.entries(archivePlan.manifest).every(([k,v])=>manifest[k]===v),'cleanup_manifest_ownership');
   const expectedManifest={...archivePlan.manifest};delete expectedManifest.schema;expectedManifest.archivedAt=archiveJob.createdAt;expectedManifest.schema=1;
   const planned={...archivePlan.hashes,'manifest.json':hash(JSON.stringify(expectedManifest))},objects=[];
   for(const n of entries){const f=path.join(archiveBase,n),st=await fs.lstat(f);check(st.isFile()&&!st.isSymbolicLink()&&hash(await fs.readFile(f))===planned[n],'cleanup_ownership');objects.push({file:f,sha256:planned[n],dev:st.dev,ino:st.ino});}
   await save('archive-cleanup-objects.json',objects);
   for(const entry of objects){await preflight();check(same(await identity(archiveBase),baseIdentity),'cleanup_identity_changed');check((await fs.readdir(archiveBase)).every(n=>archivePlan.expectedNames.includes(n)),'cleanup_unknown_object');const st=await fs.lstat(entry.file);check(same(st,entry)&&st.isFile()&&hash(await fs.readFile(entry.file))===entry.sha256,'cleanup_ownership');await fs.unlink(entry.file);}
   // Retain all directories: no history, marker, backup or ancestor cleanup.
  }catch{failed=true;evidence.cleanupError='archive_cleanup_failed_preserve_ledger';}}

  if(archiveBase&&!evidence.cleanupError){try{await archiveTarget.preflight();check(same(await identity(archiveIdentity.root),archiveIdentity),'cleanup_identity_changed');}catch{failed=true;evidence.cleanupError='archive_cleanup_failed_preserve_ledger';}}
  if(dir&&!evidence.cleanupError)await fs.rm(dir,{recursive:true,force:true});if(evidence.cleanupError)evidence.retainedDataDir=dir; if(failed)evidence.result={ok:false,stage,code:evidence.cleanupError??evidence.result?.code??'cleanup_failed'};
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  if(out){try{for(const [n,v] of Object.entries({...evidence,kontingent:usage,workjobs:jobs,cleanup:{dataRemoved:!!dir&&!evidence.cleanupError,created}})){try{await save(n+'.json',v);}catch(e){failed=true;evidence.evidenceError=e.message==='secret_detected'?'secret_detected':'evidence_write_failed';}}await save('evidence-files.json',Object.fromEntries(ownEvidence));}catch(e){failed=true;evidence.evidenceError=e.message==='secret_detected'?'secret_detected':'evidence_write_failed';}
   try{for(const n of await fs.readdir(out)){const st=await fs.lstat(path.join(out,n));check(st.isFile()&&!st.isSymbolicLink(),'evidence_unknown_object');check(!secret(await fs.readFile(path.join(out,n))),'secret_detected');}}catch(e){failed=true;evidence.evidenceError=e.message==='secret_detected'?'secret_detected':'evidence_scan_failed';}
   if(evidence.evidenceError){try{await save('evidence-error.json',{ok:false,stage,code:evidence.evidenceError});}catch{/* Preserve existing ledger and any colliding diagnostic. */}}
   if(evidence.evidenceError==='secret_detected')await removeSecretEvidence();
  }

 }
 if(failed)throw Object.assign(Error('RA5 failed: '+stage+' '+(evidence.evidenceError??evidence.result?.code??'cleanup_failed')),{stage,code:evidence.evidenceError??evidence.result?.code??'cleanup_failed'});return evidence.result;
}
if(process.argv[1]===new URL(import.meta.url).pathname)run().then(()=>console.log('RA5 OK')).catch(e=>{console.error(e.message);process.exitCode=1;});
