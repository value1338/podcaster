import {test,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,lstat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createArchiveTarget,safePath,fakeArchiveTarget,validateArchiveMount} from '../../server/archive-target.mjs';
import {archiveHandler,archiveStatus} from '../../server/archive.mjs';
import {testServer} from './hilfen.mjs';
const sentinelPath=dir=>path.join(dir,'pa5-sentinel');
const hash=b=>createHash('sha256').update(b).digest('hex');
test('mount refuses absent root, ordinary directory, wrong marker; no auto creation; fake environment forbidden',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pa5-'));try{const target=createArchiveTarget({STUDIO_ARCHIVE_DRIVER:'mount',STUDIO_ARCHIVE_PATH:dir+'/missing',STUDIO_ARCHIVE_ID:'test'});await expect(target.preflight()).rejects.toMatchObject({code:'archive_unavailable'});await expect(lstat(dir+'/missing')).rejects.toMatchObject({code:'ENOENT'});await mkdir(dir+'/ordinary');await writeFile(dir+'/ordinary/.podcast-studio-archiv.json','{"archiveId":"test"}');await expect(createArchiveTarget({STUDIO_ARCHIVE_DRIVER:'mount',STUDIO_ARCHIVE_PATH:dir+'/ordinary',STUDIO_ARCHIVE_ID:'test'}).preflight()).rejects.toMatchObject({code:'archive_unavailable'});expect(()=>createArchiveTarget({STUDIO_ARCHIVE_DRIVER:'fake'})).toThrow();await expect(safePath(dir,'../escape')).rejects.toThrow();await symlink(os.tmpdir(),dir+'/escape');await expect(safePath(dir,'escape/test')).rejects.toThrow();}finally{await rm(dir,{recursive:true,force:true});}
});
// /dev/shm is an existing tmpfs mount in the test VM. The test never mounts or changes a share.
test.skipIf(!process.env.PA5_MOUNT)('A1-A9 real mount streaming, immutable commit, cancellation, corruption, evict/restore',async()=>{
 const app=await testServer(),{ctx}=app.app;const root=await mkdtemp('/dev/shm/pa5-');
 // The adapter requires the mountpoint itself. A separate private mount namespace test supplies PA5_MOUNT.
 try{
 const dir=process.env.PA5_MOUNT;if(!dir)return;const id=randomUUID();const missingMarker=createArchiveTarget({STUDIO_ARCHIVE_DRIVER:'mount',STUDIO_ARCHIVE_PATH:dir,STUDIO_ARCHIVE_ID:id});await expect(missingMarker.preflight()).rejects.toMatchObject({code:'archive_unavailable'});await expect(lstat(dir+'/.podcast-studio-archiv.json')).rejects.toMatchObject({code:'ENOENT'});await writeFile(sentinelPath(app.dir),'untouched');await writeFile(dir+'/sentinel','untouched');await writeFile(dir+'/.podcast-studio-archiv.json',JSON.stringify({archiveId:id}),{flag:'wx'});
 const a=createArchiveTarget({STUDIO_ARCHIVE_DRIVER:'mount',STUDIO_ARCHIVE_PATH:dir,STUDIO_ARCHIVE_ID:id});ctx.archive=a;
 await expect(a.preflight()).resolves.toMatchObject({archiveId:id});
 await expect(createArchiveTarget({STUDIO_ARCHIVE_DRIVER:'mount',STUDIO_ARCHIVE_PATH:dir,STUDIO_ARCHIVE_ID:id,STUDIO_ARCHIVE_EXPECTED_FILESYSTEM:'cifs'}).preflight()).rejects.toMatchObject({code:'archive_unavailable'});
 const owner=ctx.db.sql.prepare('SELECT id FROM users').get().id,p={id:randomUUID(),ownerId:owner,title:'P'},r={id:randomUUID(),ownerId:owner,projectId:p.id,title:'R'},t={id:randomUUID(),ownerId:owner,recordingId:r.id,mimeType:'audio/wav',participantName:'T',status:'ready',bytes:5,sha256:hash('hello'),durationMs:1};ctx.db.put('projects',p);ctx.db.put('recordings',r);ctx.db.put('tracks',t);const local=path.join(ctx.dataDir,'medien',p.id,r.id,t.id);await mkdir(local,{recursive:true});await writeFile(local+'/original.wav','hello');const j={id:randomUUID(),subject_id:t.id,kind:'archive',created_at:new Date().toISOString(),owner_id:owner,input:'{}'},handler=archiveHandler(ctx),signal=new AbortController().signal;

 const relEarly=`konten/${owner}/${p.id}/${r.id}/${t.id}/original.wav`;
 ctx.archive=fakeArchiveTarget({...a,async put(file,temp,s){await a.put(file,temp,s);await writeFile(dir+'/'+temp,'xxxxx');}});
 await expect(archiveHandler(ctx)(j,{signal})).rejects.toMatchObject({code:'archive_checksum'});expect(ctx.db.get('tracks',t.id).archive).toBeUndefined();expect(await a.stat(relEarly)).toBeNull();
 ctx.archive=fakeArchiveTarget({...a,async put(file,temp,s){await a.put(file,temp,s);throw Object.assign(Error('abort'),{name:'AbortError'});}});
 await expect(archiveHandler(ctx)(j,{signal})).rejects.toThrow('abort');expect(await a.stat(relEarly+'.teil-'+j.id)).not.toBeNull();ctx.archive=fakeArchiveTarget({...a,async put(file,temp,sig){await a.put(file,temp,sig);ctx.db.put('tracks',{...ctx.db.get('tracks',t.id),concurrentField:'preserved'});}});
 ctx.db.sql.prepare('INSERT INTO transcripts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),t.id,owner,j.id,'de','test','cpu','none',1,'[]','[]',0,1,j.created_at,j.created_at);
 let out=await handler(j,{signal});out.save();await a.put(local+'/original.wav',relEarly+'.teil-'+j.id,signal);expect(await a.stat(relEarly+'.teil-'+j.id)).not.toBeNull();await handler(j,{signal});expect(await a.stat(relEarly+'.teil-'+j.id)).toBeNull();expect(ctx.db.get('tracks',t.id).archive.status).toBe('verified');expect(ctx.db.get('tracks',t.id).concurrentField).toBe('preserved');ctx.archive=a;const rel=`konten/${owner}/${p.id}/${r.id}/${t.id}/original.wav`;expect(await a.sha256(rel)).toBe(t.sha256);expect(await a.stat(path.dirname(rel)+'/manifest.json')).not.toBeNull();
 const transcriptBefore=await readFile(dir+'/'+path.dirname(rel)+'/transkript.json');ctx.db.sql.prepare('UPDATE transcripts SET revision=2,edited=1 WHERE track_id=?').run(t.id);
 out=await handler({...j,id:randomUUID()},{signal});out.save();expect(await a.sha256(rel)).toBe(t.sha256);expect(await readFile(dir+'/'+path.dirname(rel)+'/transkript.json')).toEqual(transcriptBefore);
 await writeFile(local+'/original.wav','bad');await expect(handler(j,{signal})).rejects.toMatchObject({code:'archive_checksum'});await writeFile(local+'/original.wav','hello');
 ctx.db.sql.prepare('INSERT INTO settings VALUES (?,?,?,?)').run('archive.evictAfterDays','1',new Date().toISOString(),owner);
 await writeFile(dir+'/'+rel,'other');await expect(handler(j,{signal})).rejects.toMatchObject({code:'archive_conflict'});await expect(handler({...j,kind:'evict'},{signal})).rejects.toThrow();expect(await readFile(local+'/original.wav','utf8')).toBe('hello');await writeFile(dir+'/'+rel,'hello');
 const temp=rel+'.teil-'+randomUUID();await a.put(local+'/original.wav',temp,signal);await expect(a.commit(temp,rel)).rejects.toMatchObject({code:'EEXIST'});await a.remove(temp);
 const aborted=new AbortController();aborted.abort();await expect(a.put(local+'/original.wav',temp,aborted.signal)).rejects.toThrow();
 ctx.archiveReaders.set(t.id,1);await expect(handler({...j,kind:'evict'},{signal})).rejects.toThrow();ctx.archiveReaders.delete(t.id);
 const other={id:randomUUID()};ctx.db.sql.prepare("INSERT INTO jobs(id,owner_id,kind,subject_type,subject_id,status,input,created_at) VALUES (?,?,'asr','track',?,'queued','{}',?)").run(other.id,owner,t.id,j.created_at);await expect(handler({...j,kind:'evict'},{signal})).rejects.toThrow();ctx.db.sql.prepare("UPDATE jobs SET status='canceled' WHERE id=?").run(other.id);
 await handler({...j,kind:'evict'},{signal});expect(ctx.db.get('tracks',t.id).local).toBe(false);await expect(readFile(local+'/original.wav')).rejects.toMatchObject({code:'ENOENT'});await writeFile(dir+'/'+rel,'other');await expect(handler({...j,kind:'restore'},{signal})).rejects.toMatchObject({code:'archive_checksum'});await expect(readFile(local+'/original.wav')).rejects.toMatchObject({code:'ENOENT'});await writeFile(dir+'/'+rel,'hello');out=await handler({...j,kind:'restore'},{signal});out.save();expect(await readFile(local+'/original.wav','utf8')).toBe('hello');expect(await a.sha256(rel)).toBe(t.sha256);

 ctx.work.handlers.archive=archiveHandler(ctx);const login=await app.request('POST','/auth/token/'+app.link.url.split('/').at(-1),{password:'test-password-123'});const cookie=login.headers.get('set-cookie').split(';')[0];const response=await app.request('POST','/admin/tracks/'+t.id+'/archive',{},cookie);expect(response.status).toBe(202);const jobId=(await response.json()).id;for(let i=0;i<100&&ctx.work.get(jobId).status!=='succeeded';i++)await new Promise(r=>setTimeout(r,10));expect(ctx.work.get(jobId).status).toBe('succeeded');
 expect(await readFile(sentinelPath(app.dir),'utf8')).toBe('untouched');expect(await readFile(dir+'/sentinel','utf8')).toBe('untouched');
 await writeFile(dir+'/.podcast-studio-archiv.json','{"archiveId":"wrong"}');for(const call of [()=>a.put(local+'/original.wav',temp,signal),()=>a.sha256(rel),()=>a.fetch(rel,local+'/copy',signal),()=>a.commit(temp,rel)])await expect(call()).rejects.toMatchObject({code:'archive_unavailable'});
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
test('real default status is configuration_required',async()=>{const s=await testServer({archiveEnv:{}});try{expect((await archiveStatus(s.app.ctx)).state).toBe('configuration_required');}finally{await s.close();}});
test('HTTP owner/member route matrix, foreign 404, expired session, HEAD and Range',async()=>{
 const s=await testServer({archiveEnv:{}});try{
 const setup=await s.request('POST','/auth/token/'+s.link.url.split('/').at(-1),{password:'test-password-123'}),ownerCookie=setup.headers.get('set-cookie').split(';')[0],owner=(await setup.json()).user;
 const inv=await s.request('POST','/admin/invites',{email:'pa5-member@example.test',planId:'free'},ownerCookie),invite=await inv.json();const reg=await s.request('POST','/auth/token/'+invite.url.split('/').at(-1),{password:'test-password-123',displayName:'Member'}),memberCookie=reg.headers.get('set-cookie').split(';')[0],member=(await reg.json()).user;
 const db=s.app.ctx.db,p={id:randomUUID(),ownerId:member.id,title:'P'},r={id:randomUUID(),ownerId:member.id,projectId:p.id,title:'R'},t={id:randomUUID(),ownerId:member.id,recordingId:r.id,status:'ready',local:false,mimeType:'audio/wav'};db.put('projects',p);db.put('recordings',r);db.put('tracks',t);
 expect((await s.request('POST','/admin/tracks/'+t.id+'/archive',{},ownerCookie)).status).toBe(503); // owner may archive member, reaches configuration gate
 expect((await s.request('POST','/tracks/'+t.id+'/restore',{},ownerCookie)).status).toBe(404);
 expect((await s.request('POST','/tracks/'+t.id+'/restore',{},memberCookie)).status).toBe(503);
 for(const action of ['archive','evict'])expect((await s.request('POST','/admin/tracks/'+t.id+'/'+action,{},memberCookie)).status).toBe(404);
 for(const method of ['GET','HEAD']){expect((await s.request(method,'/tracks/'+t.id+'/file',undefined,memberCookie)).status).toBe(409);const a=await s.request(method,'/tracks/'+t.id+'/file',undefined,ownerCookie),b=await s.request(method,'/tracks/'+randomUUID()+'/file',undefined,ownerCookie);expect(a.status).toBe(404);expect(await a.text()).toBe(await b.text());}
 const local=path.join(s.dir,'medien',p.id,r.id,t.id);await mkdir(local,{recursive:true});await writeFile(local+'/original.wav','hello');db.put('tracks',{...t,local:true});const url='http://127.0.0.1:'+s.app.server.address().port+'/api/tracks/'+t.id+'/file';const range=await fetch(url,{headers:{Cookie:memberCookie,Range:'bytes=1-3'}});expect(range.status).toBe(206);expect(await range.text()).toBe('ell');const head=await fetch(url,{method:'HEAD',headers:{Cookie:memberCookie,Range:'bytes=1-3'}});expect(head.status).toBe(206);expect(await head.text()).toBe('');
 db.sql.prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();expect((await s.request('GET','/tracks/'+t.id+'/file',undefined,memberCookie)).status).toBe(401);
 }finally{await s.close();}
});

test('Review B1 only owner controls archive/evict jobs, even for member-owned tracks',async()=>{
 const s=await testServer();try{
 const login=await s.request('POST','/auth/token/'+s.link.url.split('/').at(-1),{password:'owner-password-123'}),owner=(await login.json()).user,oc=login.headers.get('set-cookie').split(';')[0];
 const invite=await(await s.request('POST','/admin/invites',{email:'archive-member@example.test',planId:'free'},oc)).json();
 const member=await s.request('POST','/auth/token/'+invite.url.split('/').at(-1),{password:'member-password-123',displayName:'Member'}),u=(await member.json()).user,mc=member.headers.get('set-cookie').split(';')[0],db=s.app.ctx.db,w=s.app.ctx.work;
 w.stopped=true;w.handlers.archive=async()=>({});w.handlers.evict=async()=>({});
 const p={id:randomUUID(),ownerId:u.id,title:'P'},r={id:randomUUID(),ownerId:u.id,projectId:p.id},t={id:randomUUID(),ownerId:u.id,recordingId:r.id};db.put('projects',p);db.put('recordings',r);db.put('tracks',t);
 for(const kind of ['archive','evict']){
 const j=w.create({ownerId:u.id,kind,subjectType:'track',subjectId:t.id,input:{actorId:owner.id}}).job;db.sql.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(j.id);
 expect((await s.request('GET','/jobs/'+j.id,undefined,oc)).status).toBe(200);
 for(const action of ['retry','cancel'])expect((await s.request('POST','/jobs/'+j.id+'/'+action,{},mc)).status).toBe(404);
 expect(w.get(j.id).status).toBe('failed');
 expect((await s.request('POST','/jobs/'+j.id+'/retry',{},oc)).status).toBe(202);
 expect((await s.request('POST','/jobs/'+j.id+'/cancel',{},oc)).status).toBe(200);
 expect(w.get(j.id).status).toBe('canceled');expect(JSON.parse(w.get(j.id).input).actorId).toBe(owner.id);
 expect(db.sql.prepare("SELECT actor_id FROM audit WHERE subject=? AND action='archive.job.retry'").get(j.id).actor_id).toBe(owner.id);
 }
 }finally{await s.close();}
});

// Catches missing VFS guard, superblock-option confusion, and wrong stacked selection.
test('RA4d CIFS requires per-mount nosymfollow; malformed mountinfo fails closed',()=>{
 const row=(type,opts='rw',point='/archive')=>`100 30 0:99 / ${point} ${opts} shared:1 - ${type} source rw,nosymfollow\n`;
 expect(()=>validateArchiveMount(row('cifs'),'/archive')).toThrow();
 expect(()=>validateArchiveMount(row('cifs','rw,nosymfollow'),'/archive')).not.toThrow();
 expect(()=>validateArchiveMount('640 28 0:4 net:[4026532761] /run/docker/netns/test rw - nsfs nsfs rw\n'+row('tmpfs'),'/archive')).not.toThrow();
 expect(()=>validateArchiveMount(row('tmpfs'),'/archive','cifs')).toThrow();
 expect(()=>validateArchiveMount(row('autofs')+row('cifs','rw,nosymfollow'),'/archive','cifs')).not.toThrow();
 expect(()=>validateArchiveMount(row('cifs','rw,nosymfollow')+row('cifs'),'/archive')).toThrow();
 expect(()=>validateArchiveMount(row('cifs','rw,nosymfollow','/with\\040space'),'/with space','cifs')).not.toThrow();
 for(const bad of ['', 'garbage', row('cifs','rw,nosymfollow')+'bad\n', '100 30 0:99 / /archive rw - cifs source\n', row('cifs','rw,nosymfollow','/bad\\999')]) expect(()=>validateArchiveMount(bad,'/archive')).toThrow();
 expect(()=>validateArchiveMount(row('cifs','rw,nosymfollow'),'/missing')).toThrow();
});
