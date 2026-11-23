import {test,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {openDB} from '../../server/db.mjs';
import {migrate} from '../../server/migrate.mjs';
import {Work,jobView} from '../../server/work.mjs';
import {quota} from '../../server/quota.mjs';
import {testServer} from './hilfen.mjs';
const wait=()=>new Promise(r=>setTimeout(r,30));
async function fixture(fn){const dir=await mkdtemp('/tmp/studio-review-'),file=dir+'/studio.sqlite',db=openDB(file);try{await migrate(db,file);db.sql.prepare("INSERT INTO users VALUES ('u','u@example.test','U','member','free',NULL,'active','now',NULL)").run();db.sql.prepare("UPDATE plans SET active_jobs=100 WHERE id='free'").run();db.put('projects',{id:'p',ownerId:'u'});await fn(db);}finally{db.close();await rm(dir,{recursive:true,force:true});}}
const create=(w,kind,key)=>w.create({ownerId:'u',kind,subjectType:'project',subjectId:'p',idemKey:key,wants:[{meter:kind==='llm'?'llm_tokens':'asr_seconds',amount:10}]}).job;
test('F3 graceful shutdown preserves state/reservation; recovery separates sent LLM and user cancel',()=>fixture(async db=>{
 const handler=sent=>async(j,{signal,state})=>{state({windows:[1],sent});await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('abort'))));};
 const w=new Work({db},{asr:handler(false),archive:handler(false),llm:async(j,o)=>handler(j.idem_key==='c')(j,o)});
 const a=create(w,'asr','a'),b=create(w,'archive','b'),c=create(w,'llm','c'),unsent=create(w,'llm','unsent');await wait();await w.close();
 expect(w.get(a.id).status).toBe('running');expect(quota(db).usageOf('u').asrSeconds.reserved).toBe(20);
 const r=new Work({db});r.stopped=true;try{expect(r.get(a.id).status).toBe('queued');expect(r.get(b.id).status).toBe('queued');expect(r.get(unsent.id).status).toBe('queued');expect(JSON.parse(r.get(a.id).state).windows).toEqual([1]);expect(r.get(c.id).error_code).toBe('interrupted');expect(quota(db).usageOf('u').llmTokens.used).toBe(10);expect(quota(db).meterState('*','llm_tokens').used).toBe(10);expect(jobView(r.get(c.id)).usageEstimated).toBe(true);expect(()=>r.retry(c.id)).toThrow(expect.objectContaining({code:'new_job_required'}));
 const d=create(r,'llm','d');r.finish(d.id,'failed',null,[{meter:'llm_tokens',used:7}],null,'llm_bad_response');expect(quota(db).usageOf('u').llmTokens.used).toBe(17);expect(()=>r.retry(d.id)).toThrow(expect.objectContaining({code:'new_job_required'}));
 const e=create(r,'asr','e');r.state(e.id,{cancelRequested:true});r.cancel(e.id);expect(r.get(e.id).status).toBe('canceled');expect(r.get(e.id).result).toBeNull();
 }finally{await r.close();}
}));
test('F5 uncertain sent LLM exhausts platform cap without automatic resend',()=>fixture(async db=>{
 db.sql.prepare("UPDATE settings SET value='10' WHERE key='llm.globalTokensMonth'").run();
 let calls=0;const w=new Work({db},{llm:async(j,{state})=>{calls++;state({sent:true});throw Error('timeout');}});
 try{const j=create(w,'llm','sent');await wait();expect(w.get(j.id).error_code).toBe('llm_unclear');expect(calls).toBe(1);expect(()=>create(w,'llm','next')).toThrow(expect.objectContaining({status:402}));}finally{await w.close();}
}));
test('F10 scheduler exceptions are contained and next tick can recover',()=>fixture(async db=>{
 const w=new Work({db});const log=vi.spyOn(console,'error').mockImplementation(()=>{});const tick=vi.spyOn(w,'tick').mockImplementationOnce(()=>{throw Object.assign(Error('locked'),{code:'SQLITE_BUSY'});});
 try{expect(()=>w.safeTick()).not.toThrow();expect(log).toHaveBeenCalledWith('Podcast-Studio scheduler failure','internal');w.safeTick();expect(tick).toHaveBeenCalledTimes(2);}finally{log.mockRestore();await w.close();}
}));
test('F1/F2 account lock applies to correct password; unrelated failures do not lock owner; F4 uploads reserve',async()=>{
 const s=await testServer();try{
 const r=await s.request('POST','/auth/token/'+s.link.url.split('/').at(-1),{password:'test-password-123'}),u=(await r.json()).user,c=r.headers.get('set-cookie').split(';')[0];
 for(let i=0;i<21;i++)expect((await s.request('POST','/auth/login',{email:'unknown'+i+'@example.test',password:'bad'})).status).toBe(401);
 expect((await s.request('POST','/auth/login',{email:u.email,password:'test-password-123'})).status).toBe(200);
 for(let i=0;i<5;i++)expect((await s.request('POST','/auth/login',{email:u.email,password:'bad'})).status).toBe(401);
 expect((await s.request('POST','/auth/login',{email:u.email,password:'test-password-123'})).status).toBe(429);
 for(let i=0;i<5;i++)await s.request('POST','/auth/login',{email:'absent@example.test',password:'bad'});
 expect((await s.request('POST','/auth/login',{email:'absent@example.test',password:'test-password-123'})).status).toBe(429);
 const p=await (await s.request('POST','/projects',{title:'quota'},c)).json();s.app.ctx.db.sql.prepare("UPDATE plans SET storage_bytes=1000 WHERE id='intern'").run();
 const upload=()=>s.request('POST','/projects/'+p.id+'/recordings',{title:'upload',kind:'audio',mimeType:'audio/webm',participantName:'U',startedAtMs:null,source:'upload',declaredBytes:900},c);
 expect((await Promise.all([upload(),upload(),upload()])).map(r=>r.status).sort()).toEqual([201,402,402]);
 }finally{await s.close();}
},15000);

import {ownerCreate,legacyClaim} from '../../server/accounts.mjs';
import {enqueueTrack,chunkPath} from '../../server/tracks.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
test('F8 claim audit rolls back with ownership; F9 counts raw processing/failed bytes',()=>fixture(async db=>{
 const link=ownerCreate({db,base:''},'owner@example.test','Owner');expect(link.id).toBeTruthy();
 const owner=db.sql.prepare("SELECT id FROM users WHERE role='owner'").get().id;db.put('projects',{id:'legacy'});
 db.sql.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'audit failed'); END");
 expect(()=>legacyClaim({db},owner,true)).toThrow();expect(db.get('projects','legacy').ownerId).toBeUndefined();
 db.sql.exec('DROP TRIGGER reject_audit');legacyClaim({db},owner,true);
 expect(JSON.parse(db.sql.prepare("SELECT detail FROM audit WHERE action='legacy.claim'").get().detail).projects).toBe(1);
 db.put('tracks',{id:'processing',ownerId:'u',status:'processing',uploadBytes:12});
 db.put('tracks',{id:'failed',ownerId:'u',status:'failed',rawBytes:25,uploadBytes:20});
 expect(quota(db).storageUsed('u')).toBe(37);
}));
test('async failed media finalization preserves concurrently written platform fields',()=>fixture(async db=>{
 const dir=await mkdtemp('/tmp/studio-review-media-');try{
 db.put('recordings',{id:'r',projectId:'p',ownerId:'u'});const t={id:'t',recordingId:'r',ownerId:'u',status:'processing',mimeType:'audio/webm',chunkCount:1,kind:'audio'};
 db.put('tracks',t);let task;const ctx={db,dataDir:dir,jobs:{add:(id,fn)=>task=fn(new AbortController().signal)}};
 const chunk=chunkPath(ctx,t,0);await mkdir(path.dirname(chunk),{recursive:true});await writeFile(chunk,'invalid media');
 enqueueTrack(ctx,t);db.put('tracks',{...db.get('tracks','t'),transcription:{status:'queued'},archive:{status:'pending'},local:true});await task;
 expect(db.get('tracks','t')).toMatchObject({status:'failed',transcription:{status:'queued'},archive:{status:'pending'},local:true});
 }finally{await rm(dir,{recursive:true,force:true});}
}));

test('N1 paid ASR failure cannot reuse its consumed reservation',()=>fixture(async db=>{
 const w=new Work({db},{asr:async()=>({})});w.stopped=true;
 try{const j=create(w,'asr','paid-asr');w.finish(j.id,'failed',null,[{meter:'asr_seconds',used:10}],null,'asr_failed');expect(()=>w.retry(j.id)).toThrow(expect.objectContaining({status:409,code:'new_job_required'}));expect(quota(db).usageOf('u').asrSeconds.used).toBe(10);}finally{await w.close();}
}));
test('N2 recovery honors persisted cancellation before invoking a handler',()=>fixture(async db=>{
 const w=new Work({db});w.stopped=true;const j=create(w,'asr','cancel-before-crash');db.sql.prepare("UPDATE jobs SET status='running',state=? WHERE id=?").run(JSON.stringify({cancelRequested:true}),j.id);
 const handler=vi.fn(),r=new Work({db},{asr:handler});try{await wait();expect(r.get(j.id).status).toBe('canceled');expect(handler).not.toHaveBeenCalled();expect(quota(db).usageOf('u').asrSeconds.reserved).toBe(0);}finally{await r.close();await w.close();}
}));
test('N3 raw-file stat completion preserves every concurrent track update',()=>fixture(async db=>{
 const dir=await mkdtemp('/tmp/studio-stat-race-');let stop=false;
 try{db.put('recordings',{id:'r',projectId:'p',ownerId:'u'});const t={id:'t',recordingId:'r',ownerId:'u',status:'processing',mimeType:'audio/webm',chunkCount:1,kind:'audio',marks:0};db.put('tracks',t);let task;const ctx={db,dataDir:dir,jobs:{add:(_,fn)=>task=fn(new AbortController().signal)}};const chunk=chunkPath(ctx,t,0);await mkdir(path.dirname(chunk),{recursive:true});await writeFile(chunk,Buffer.alloc(4<<20,1));let writes=0;const writer=()=>{if(stop)return;db.put('tracks',{...db.get('tracks','t'),marks:++writes});setImmediate(writer);};enqueueTrack(ctx,t);setImmediate(writer);await task;stop=true;expect(writes).toBeGreaterThan(0);expect(db.get('tracks','t').marks).toBe(writes);
 }finally{stop=true;await rm(dir,{recursive:true,force:true});}
}));

test('N4 real SQLite lock retries settlement without invoking handler or releasing usage',()=>fixture(async db=>{
 const {DatabaseSync}=await import('node:sqlite');const file=db.sql.prepare('PRAGMA database_list').get().file,other=new DatabaseSync(file);let calls=0,release;
 const w=new Work({db},{asr:async()=>{calls++;await new Promise(r=>release=r);return {actual:[{meter:'asr_seconds',used:10}],result:{ok:true}};}});const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{const j=create(w,'asr','locked');await wait();other.exec('BEGIN IMMEDIATE');release();await wait();expect(w.get(j.id).status).toBe('running');expect(w.settlements.has(j.id)).toBe(true);expect(quota(db).usageOf('u').asrSeconds.reserved).toBe(10);other.exec('ROLLBACK');w.safeTick();expect(w.get(j.id).status).toBe('succeeded');expect(calls).toBe(1);expect(quota(db).usageOf('u').asrSeconds.used).toBe(10);}finally{other.close();log.mockRestore();await w.close();}
}),15000);
