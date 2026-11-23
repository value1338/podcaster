import {test,expect} from 'vitest';
import {testServer} from './hilfen.mjs';

test('PA2 exposes real usage and unavailable driver capabilities',async()=>{
 const s=await testServer();try{const token=s.link.url.split('/').at(-1);const r=await s.request('POST','/auth/token/'+token,{password:'test-password-123'});const c=r.headers.get('set-cookie').split(';')[0];
 const u=await s.request('GET','/account/usage',undefined,c);expect(u.status).toBe(200);expect((await u.json()).storageBytes.used).toBe(0);
 const caps=await (await s.request('GET','/capabilities',undefined,c)).json();expect(caps.asr.state).toBe('configuration_required');
 }finally{await s.close();}
});

import {quota} from '../../server/quota.mjs';
import {Work} from '../../server/work.mjs';
import {openDB} from '../../server/db.mjs';
import {migrate} from '../../server/migrate.mjs';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {run} from '../../server/ffmpeg.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(fn){const dir=await mkdtemp('/tmp/studio-pa2-'),file=path.join(dir,'studio.sqlite'),db=openDB(file);try{await migrate(db,file);db.sql.prepare("INSERT INTO users VALUES ('u','u@example.test','U','member','free',NULL,'active',?,NULL)").run(new Date().toISOString());db.sql.prepare('UPDATE plans SET asr_seconds_month=100,active_jobs=100 WHERE id=\'free\'').run();await fn({db,dir,file,q:quota(db)});}finally{db.close();await rm(dir,{recursive:true,force:true});}}

test('50 contenders, platform cap, settlement, month binding and rollback',async()=>fixture(async({db,q})=>{
 const results=await Promise.all(Array.from({length:50},(_,i)=>Promise.resolve().then(()=>{try{q.reserve('u','j'+i,[{meter:'asr_seconds',amount:10}]);return 200;}catch(e){return e.status;}})));expect(results.filter(s=>s===200)).toHaveLength(10);expect(results.filter(s=>s===402)).toHaveLength(40);expect(q.usageOf('u').asrSeconds.reserved).toBe(100);
 q.commit('j0',[{meter:'asr_seconds',used:12}]);q.commit('j0',[{meter:'asr_seconds',used:80}]);q.release('j0','late');expect(q.usageOf('u').asrSeconds.used).toBe(12);
 q.release('j1','failed');q.commit('j1',[{meter:'asr_seconds',used:50}]);expect(q.usageOf('u').asrSeconds.used).toBe(12);
 expect(()=>db.tx(()=>{q.reserve('u','rollback',[{meter:'llm_tokens',amount:4}]);throw Error('rollback');})).toThrow();expect(db.sql.prepare("SELECT count(*) n FROM usage WHERE job_id='rollback'").get().n).toBe(0);
 db.sql.prepare("UPDATE settings SET value='2' WHERE key='llm.globalTokensMonth'").run();expect(()=>q.reserve('u','cap',[{meter:'llm_tokens',amount:3}])).toThrow(expect.objectContaining({status:402,details:expect.objectContaining({scope:'platform'})}));
 db.sql.prepare("UPDATE usage SET period='2020-01' WHERE job_id='j2'").run();q.commit('j2',[{meter:'asr_seconds',used:10}]);expect(q.usageOf('u','2020-01').asrSeconds.used).toBe(10);
}));

test('two independent processes serialize reservations without busy errors',async()=>fixture(async({db,file,q})=>{
 const child=()=>new Promise((resolve,reject)=>{const script=`import {openDB} from './server/db.mjs';import {quota} from './server/quota.mjs';const db=openDB(process.argv[1]);let ok=0,bad=0;for(let i=0;i<50;i++){try{quota(db).reserve('u',process.pid+'-'+i,[{meter:'asr_seconds',amount:10}]);ok++;}catch(e){if(e.status===402)bad++;else throw e;}}db.close();console.log(JSON.stringify({ok,bad}));`;const p=spawn(process.execPath,['--input-type=module','-e',script,file],{cwd:process.cwd()});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>code?reject(Error(err)):resolve(JSON.parse(out)));});
 const rs=await Promise.all([child(),child()]);expect(rs.reduce((n,r)=>n+r.ok,0)).toBe(10);expect(rs.reduce((n,r)=>n+r.bad,0)).toBe(90);expect(q.usageOf('u').asrSeconds.reserved).toBe(100);
}));

test('persistent jobs: idempotency, atomic results, retry, ownership, interrupted LLM',async()=>fixture(async({db,q})=>{
 const pid=randomUUID();db.put('projects',{id:pid,ownerId:'u'});const ctx={db},w=new Work(ctx);w.stopped=true;
 const input={ownerId:'u',kind:'asr',subjectType:'project',subjectId:pid,idemKey:'same',wants:[{meter:'asr_seconds',amount:10}]};const a=w.create(input);expect(w.create(input).reused).toBe(true);expect(q.activeJobs('u')).toBe(1);expect(()=>w.create({...input,idemKey:'other',ownerId:'foreign'})).toThrow(expect.objectContaining({status:404}));
 w.finish(a.job.id,'succeeded',{transcriptId:'t'},[{meter:'asr_seconds',used:8}],d=>d.sql.prepare("INSERT INTO settings VALUES ('result','true','now',NULL)").run());w.finish(a.job.id,'succeeded',null,[{meter:'asr_seconds',used:80}]);expect(q.usageOf('u').asrSeconds.used).toBe(8);
 const b=w.create({...input,idemKey:'retry'}).job;w.finish(b.id,'failed');w.handlers.asr=async()=>({actual:[{meter:'asr_seconds',used:9}]});expect(w.retry(b.id).id).toBe(b.id);expect(q.usageOf('u').asrSeconds.reserved).toBe(10);w.finish(b.id,'succeeded',null,[{meter:'asr_seconds',used:9}]);expect(q.usageOf('u').asrSeconds.used).toBe(17);
 const c=w.create({...input,idemKey:'recover'}).job;db.sql.prepare("UPDATE jobs SET status='running',state=? WHERE id=?").run(JSON.stringify({windows:[{text:'saved'}]}),c.id);
 const l=w.create({...input,kind:'llm',idemKey:'sent',wants:[{meter:'llm_tokens',amount:50}]}).job;db.sql.prepare("UPDATE jobs SET status='running',state=? WHERE id=?").run('{"sent":true}',l.id);await w.close();const restarted=new Work(ctx);restarted.stopped=true;try{expect(restarted.get(c.id).status).toBe('queued');expect(JSON.parse(restarted.get(c.id).state).windows).toHaveLength(1);expect(restarted.get(l.id).error_code).toBe('interrupted');expect(q.usageOf('u').llmTokens.reserved).toBe(0);expect(q.usageOf('u').llmTokens.used).toBe(50);}finally{await restarted.close();}
}));

test('storage quota protects new work, accepts ongoing audio, bounds upload bytes and admin ownership',async()=>{
 const s=await testServer();try{const r=await s.request('POST','/auth/token/'+s.link.url.split('/').at(-1),{password:'test-password-123'});const c=r.headers.get('set-cookie').split(';')[0];const req=(m,p,b)=>s.request(m,p,b,c);const user=(await r.json()).user;
 const project=await (await req('POST','/projects',{title:'Quota'})).json();const input={title:'Audio',kind:'audio',mimeType:'audio/webm',participantName:'Me',startedAtMs:null};const create=b=>req('POST',`/projects/${project.id}/recordings`,{...input,...b});
 const t=(await (await create()).json()).track;s.app.ctx.db.sql.prepare("UPDATE plans SET storage_bytes=1 WHERE id='intern'").run();const fixture=path.join(s.dir,'audio.webm');await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=sample_rate=48000','-t','0.5','-c:a','libopus',fixture]);const bytes=await readFile(fixture);
 const put=(id,i,data)=>fetch(`http://127.0.0.1:${s.app.server.address().port}/api/tracks/${id}/chunks/${i}`,{method:'PUT',headers:{Cookie:c,Origin:'http://127.0.0.1:8871','X-Studio':'1'},body:data});expect((await put(t.id,0,bytes)).status).toBe(200);expect((await create()).status).toBe(402);expect((await req('POST',`/tracks/${t.id}/finalize`,{chunkCount:1,durationMs:500})).status).toBe(202);
 let current;for(let i=0;i<100;i++){current=await (await req('GET','/tracks/'+t.id)).json();if(current.status==='ready')break;await pause(25);}expect(current.status).toBe('ready');expect((await req('POST',`/tracks/${t.id}/exports`,{format:'wav'})).status).toBe(402);expect((await req('GET',`/tracks/${t.id}/file`)).status).toBe(200);
 s.app.ctx.db.sql.prepare("UPDATE plans SET storage_bytes=NULL WHERE id='intern'").run();const upload=(await (await create({source:'upload',declaredBytes:4})).json()).track;expect((await put(upload.id,0,Buffer.from('1234'))).status).toBe(200);expect((await put(upload.id,0,Buffer.from('12'))).status).toBe(200);expect((await put(upload.id,1,Buffer.from('345'))).status).toBe(413);expect(s.app.ctx.db.get('tracks',upload.id).uploadBytes).toBe(2);
 const plans=await (await req('GET','/admin/plans')).json();const free=plans.find(p=>p.id==='free');const {id,...plan}=free;expect((await req('PUT','/admin/plans/free',{...plan,asrSecondsMonth:-1})).status).toBe(400);expect((await req('PUT','/admin/plans/free',{...plan,asrSecondsMonth:120})).status).toBe(200);expect((await (await req('GET','/admin/plans')).json()).find(p=>p.id==='free').asrSecondsMonth).toBe(120);
 expect((await req('GET','/admin/users')).status).toBe(200);expect((await (await req('GET','/admin/users')).json())[0].usage.storageBytes.used).toBeGreaterThan(2);
 expect((await req('PUT','/admin/settings',{STUDIO_LLM_BASE_URL:'bad'})).status).toBe(400);expect((await req('PUT','/admin/settings',{asrWindowSeconds:60,llmGlobalTokensMonth:12})).status).toBe(200);expect((await req('GET','/admin/usage?period=bad')).status).toBe(400);
 const job=s.app.ctx.work.create({ownerId:user.id,kind:'asr',subjectType:'track',subjectId:t.id,idemKey:'http'}).job;expect((await req('GET','/jobs/'+job.id)).status).toBe(200);expect((await req('POST','/jobs/'+job.id+'/cancel',{})).status).toBe(200);
 const invite=await (await req('POST','/admin/invites',{planId:'free'})).json();const mr=await s.request('POST','/auth/token/'+invite.url.split('/').at(-1),{email:'member@example.test',displayName:'Member',password:'test-password-123'});const mc=mr.headers.get('set-cookie').split(';')[0];for(const p of ['/jobs/'+job.id,'/admin/usage','/admin/plans','/admin/settings'])expect((await s.request('GET',p,undefined,mc)).status).toBe(404);
 }finally{await s.close();}
},15000);

test('lane limits, cancel discards result, retry delay keeps reservation, active limit',async()=>fixture(async({db,q})=>{
 db.put('projects',{id:'p',ownerId:'u'});const ctx={db};let release;const gate=new Promise(r=>release=r);const counts={asr:0,llm:0,archive:0};const handler=kind=>async()=>{counts[kind]++;await gate;return {result:{transcriptId:'not-saved'},actual:[{meter:'asr_seconds',used:1}],save:()=>{throw Error('Canceled result must not save');}};};const w=new Work(ctx,{asr:handler('asr'),llm:handler('llm'),archive:handler('archive'),restore:handler('archive')});
 try{const js=[];for(const kind of ['asr','asr','llm','llm','llm','archive','restore'])js.push(w.create({ownerId:'u',kind,subjectType:'project',subjectId:'p',wants:[{meter:'asr_seconds',amount:1}]}).job);await pause(30);expect(counts).toEqual({asr:1,llm:2,archive:1});db.sql.prepare("UPDATE plans SET active_jobs=7 WHERE id='free'").run();expect(()=>w.create({ownerId:'u',kind:'asr',subjectType:'project',subjectId:'p'})).toThrow(expect.objectContaining({code:'jobs_limit'}));for(const j of js)w.cancel(j.id);release();await pause(30);expect(js.map(j=>w.get(j.id).status)).toEqual(Array(7).fill('canceled'));expect(js.map(j=>w.get(j.id).result)).toEqual(Array(7).fill(null));expect(q.usageOf('u').asrSeconds).toMatchObject({used:0,reserved:0});
 w.handlers.asr=async()=>{throw Object.assign(Error('retry'),{retryable:true,code:'asr_unavailable'});};const j=w.create({ownerId:'u',kind:'asr',subjectType:'project',subjectId:'p',wants:[{meter:'asr_seconds',amount:2}]}).job;await pause(30);expect(w.get(j.id).status).toBe('queued');expect(w.get(j.id).next_attempt_at).not.toBeNull();expect(q.usageOf('u').asrSeconds.reserved).toBe(2);
 }finally{release();await w.close();}
}));

test('SIGKILL before and after atomic completion preserves exactly once settlement',async()=>fixture(async({db,file,q})=>{
 db.put('projects',{id:'p',ownerId:'u'});
 for(const commit of [false,true]){const script=`import {openDB} from './server/db.mjs';import {Work} from './server/work.mjs';const db=openDB(process.argv[1]),w=new Work({db});w.stopped=true;const j=w.create({ownerId:'u',kind:'asr',subjectType:'project',subjectId:'p',wants:[{meter:'asr_seconds',amount:10}]}).job;db.sql.prepare("UPDATE jobs SET status='running',state=? WHERE id=?").run('{"windows":[{"text":"persisted"}]}',j.id);if(${commit})w.finish(j.id,'succeeded',null,[{meter:'asr_seconds',used:10}]);console.log(j.id);setInterval(()=>{},1000);`;
 const p=spawn(process.execPath,['--input-type=module','-e',script,file],{cwd:process.cwd()});let err='';p.stderr.on('data',d=>err+=d);const exited=new Promise(r=>p.on('exit',r));const id=await new Promise((resolve,reject)=>{p.stdout.once('data',d=>resolve(String(d).trim()));p.on('exit',()=>reject(Error(err)));});p.kill('SIGKILL');await exited;const w=new Work({db});w.stopped=true;try{const j=w.get(id);expect(j.status).toBe(commit?'succeeded':'queued');if(!commit){expect(JSON.parse(j.state).windows[0].text).toBe('persisted');w.finish(id,'succeeded',null,[{meter:'asr_seconds',used:10}]);}w.finish(id,'succeeded',null,[{meter:'asr_seconds',used:10}]);}finally{await w.close();}}
 expect(q.usageOf('u').asrSeconds.used).toBe(20);expect(q.usageOf('u').asrSeconds.reserved).toBe(0);
}));
