import {test,expect} from 'vitest';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDB} from '../../server/db.mjs';
import {migrate,pelVersion,snapshot} from '../../server/migrate.mjs';
import {createStudioServer} from '../../server/index.mjs';
import {Jobs} from '../../server/jobs.mjs';
import {quota} from '../../server/quota.mjs';
import {hashToken} from '../../server/auth.mjs';
import {archiveHandler} from '../../server/archive.mjs';
import {randomUUID} from 'node:crypto';
import {run} from '../../server/ffmpeg.mjs';
const old=new URL('../../deploy/releases/plattform-v2.1-20261120T213716Z/server/index.mjs',import.meta.url);
test('F0 upgrades 0 and 1, preserves rows and snapshots, idempotent, old release rollback',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pel-f0-'));let db,app;
 try{
 const file=path.join(dir,'studio.sqlite');db=openDB(file);db.put('projects',{id:'p',title:'unchanged'});
 await expect(createStudioServer({dataDir:dir,origins:'http://localhost'})).rejects.toThrow('Explizite Migration');
 const result=await migrate(db,file);expect(pelVersion(db.sql)).toBe(1);expect(db.get('projects','p').title).toBe('unchanged');
 const bytes=await readFile(result.backupPath),names=await readdir(dir);
 expect(await migrate(db,file)).toEqual({changed:false,version:1});expect(await readdir(dir)).toEqual(names);expect(await readFile(result.backupPath)).toEqual(bytes);
 for(const name of names.filter(n=>n.endsWith('.sqlite'))){const sql=new DatabaseSync(path.join(dir,name),{readOnly:true});expect(sql.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');sql.close();}
 // Online backup of a dedicated synthetic DB, never of production data.
 const copy=path.join(dir,'rollback');await (await import('node:fs/promises')).mkdir(copy);await snapshot(db.sql,path.join(copy,'studio.sqlite'));
 app=await (await import(old)).createStudioServer({dataDir:copy,origins:'http://localhost'});await new Promise(r=>app.server.listen(8881,'127.0.0.1',r));expect(app.ctx.db.get('projects','p').title).toBe('unchanged');await app.close();app=null;
 // Upgrade an actual v1 base from the pre-extension snapshot.
 const source=new DatabaseSync(result.pelBackupPath,{readOnly:true});const upgradeDir=path.join(dir,'upgrade');await (await import('node:fs/promises')).mkdir(upgradeDir);const upgrade=path.join(upgradeDir,'studio.sqlite');try{await snapshot(source,upgrade);}finally{source.close();}await expect(createStudioServer({dataDir:upgradeDir,origins:'http://localhost'})).rejects.toThrow('Explizite Migration');
 const cli=await new Promise((resolve,reject)=>(import('node:child_process')).then(({execFile})=>execFile(process.execPath,['server/cli.mjs','status'],{env:{...process.env,STUDIO_DATA_DIR:upgradeDir}},(e,out)=>e?reject(e):resolve(JSON.parse(out)))));expect(cli.ext).toEqual({pel:0});
 const v1=openDB(upgrade);try{expect(pelVersion(v1.sql)).toBe(0);await migrate(v1,upgrade);expect(pelVersion(v1.sql)).toBe(1);}finally{v1.close();}
 }finally{if(app)await app.close();db?.close();await rm(dir,{recursive:true,force:true});}
});
test('F0 queue dedup, onQueue, queued/running cancellation and close owns children',async()=>{
 const childDir=await mkdtemp(path.join(os.tmpdir(),'pel-child-'));const marker=path.join(childDir,'pid');const j=new Jobs();let queued=0,ran=false;
 j.add('a',async signal=>{try{await run(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`],{signal});}catch{}},{onQueue(){queued++;}});
 j.add('a',()=>{}, {onQueue(){queued++;}});j.add('b',()=>{ran=true;});expect(j.has('b')).toBe(true);expect(j.cancel('b')).toBe(true);expect(j.has('b')).toBe(false);for(let i=0;i<100;i++){if(await readFile(marker,'utf8').catch(()=>''))break;await new Promise(r=>setTimeout(r,10));}const childPid=Number(await readFile(marker,'utf8'));expect(j.cancel('a')).toBe(true);await j.idle;expect(ran).toBe(false);expect(queued).toBe(1);expect(()=>process.kill(childPid,0)).toThrow();
 j.add('c',async signal=>{await run(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`],{signal}).catch(()=>{});});j.add('d',()=>{ran=true;});await j.close();expect(j.has('d')).toBe(false);expect(ran).toBe(false);await rm(childDir,{recursive:true,force:true});
});
test('F0 two accounts, quota renders, watch without session, route scoped EDL size and CSRF',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pel-http-'));let app;const file=path.join(dir,'studio.sqlite');const db=openDB(file);
 try{
 await migrate(db,file);const now=new Date().toISOString();for(const [id,role] of [['a','owner'],['b','member']])db.sql.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run(id,id+'@test.test',id,role,'intern','hash','active',now,null); // column count checked below
 }finally{db.close();}
 try{
 app=await createStudioServer({dataDir:dir,origins:'http://localhost',base:'/podcast'});await new Promise(r=>app.server.listen(8881,'127.0.0.1',r));
 const sql=app.ctx.db.sql;sql.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,NULL)').run(hashToken('test'),'a',new Date().toISOString(),new Date().toISOString(),'2099-01-01T00:00:00Z');
 const q=quota(app.ctx.db);for(const [id,owner,status,bytes] of [['r1','a','queued',null],['r2','a','processing',null],['r3','a','ready',123],['r4','b','ready',456]])sql.prepare('INSERT INTO renders(id,owner_id,edit_id,revision,edl_sha256,track_ids,format,status,bytes,created_at) VALUES (?,?,?,1,?, ?,?,?,?,?)').run(id,owner,'e','hash','["track"]','mp3',status,bytes,new Date().toISOString());expect(q.activeJobs('a')).toBe(2);expect(q.storageUsed('a')).toBe(123);expect(q.storageUsed('b')).toBe(456);
 const owner=randomUUID(),project=randomUUID(),recording=randomUUID(),track=randomUUID();app.ctx.db.put('projects',{id:project,ownerId:owner});app.ctx.db.put('recordings',{id:recording,ownerId:owner,projectId:project});app.ctx.db.put('tracks',{id:track,ownerId:owner,recordingId:recording,mimeType:'audio/webm',status:'ready',archive:{status:'verified'}});
 sql.prepare("INSERT OR REPLACE INTO settings VALUES ('archive.evictAfterDays','1',?,NULL)").run(new Date().toISOString());
 let preflights=0;app.ctx.archive={async preflight(){preflights++;throw Error('preflight reached');}};
 for(const status of ['queued','processing']){sql.prepare('UPDATE renders SET track_ids=?,status=? WHERE id=?').run(JSON.stringify([track]),status,'r1');await expect(archiveHandler(app.ctx)({id:'evict',kind:'evict',subject_id:track},{signal:new AbortController().signal})).rejects.toMatchObject({code:'archive_unavailable'});expect(preflights).toBe(0);}
 sql.prepare("UPDATE renders SET status='ready' WHERE id='r1'").run();await expect(archiveHandler(app.ctx)({id:'evict',kind:'evict',subject_id:track},{signal:new AbortController().signal})).rejects.toThrow('preflight reached');expect(preflights).toBe(1);

 const request=(p,method='GET',body,auth=true,csrf=true)=>fetch('http://127.0.0.1:8881/podcast/api'+p,{method,headers:{...(auth?{Cookie:'ps_sitzung=test'}:{}),...(csrf?{'X-Studio':'1',Origin:'http://localhost'}:{})},body});
 expect((await request('/watch/state','GET',undefined,false)).status).toBe(404);expect((await request('/live','GET',undefined,false)).status).toBe(401);
 app.ctx.db.put('projects',{id:'edl-project',ownerId:'a',title:'EDL limit fixture'});
 const created=await request('/projects/edl-project/edits','POST',JSON.stringify({title:'Body limit',kind:'audio'}));expect(created.status).toBe(201);
 const editPath='/edits/'+(await created.json()).id+'/edl';
 expect((await request(editPath,'PUT',JSON.stringify({baseRevision:1,edl:{v:1,clips:[]},padding:'x'.repeat(20000)}))).status).toBe(200);
 expect((await request(editPath,'PUT',JSON.stringify({x:'x'.repeat(262144)}))).status).toBe(413);
 expect((await request(editPath,'PUT','{',false)).status).toBe(401);expect((await request(editPath,'PUT','{',true,false)).status).toBe(403);
 expect((await request('/projects','POST',JSON.stringify({title:'x'.repeat(20000)}))).status).toBe(413);
 }finally{if(app)await app.close();await rm(dir,{recursive:true,force:true});}
});

test('F0 throttle starts the owned subprocess at nice 10, default unchanged',async()=>{
 const args=['-e',"console.log(require('node:os').getPriority())"];
 const normal=Number(await run(process.execPath,args));const throttled=Number(await run(process.execPath,args,{throttle:true}));expect(throttled).toBeGreaterThanOrEqual(10);expect(normal).toBeLessThanOrEqual(throttled);
});
