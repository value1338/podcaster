import path from 'node:path';
import {unlinkSync} from 'node:fs';
import {writeFile,unlink,link,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {extensions} from './tracks.mjs';
import {problem} from './storage.mjs';
import {requireUser,limit} from './auth.mjs';
import {jobView} from './work.mjs';
import {settings} from './admin.mjs';
import {archiveError,safePath,digest} from './archive-target.mjs';
const uuid=s=>typeof s==='string'&&/^[0-9a-f-]{36}$/.test(s);
const checksum=b=>createHash('sha256').update(b).digest('hex');
function locate(ctx,t){const r=ctx.db.get('recordings',t.recordingId),p=r&&ctx.db.get('projects',r.projectId);if(!r||!p||r.ownerId!==t.ownerId||p.ownerId!==t.ownerId||![t.id,t.ownerId,r.id,p.id].every(uuid))throw archiveError();const ext=extensions[t.mimeType.split(';')[0]];if(!ext)throw archiveError();return {r,p,base:`konten/${t.ownerId}/${p.id}/${r.id}/${t.id}`,local:`medien/${p.id}/${r.id}/${t.id}`,name:'original.'+ext};}
export async function archiveStatus(ctx){const a=ctx.archive,counts={none:0,queued:0,copying:0,verified:0,failed:0};let evicted=0;for(const t of ctx.db.all('tracks')){counts[t.archive?.status??'none']++;if(t.local===false)evicted++;}let state='configuration_required',freeBytes=null,error=null;if(a?.id){try{freeBytes=(await a.preflight()).freeBytes;state='ready';}catch{state='unavailable';error='archive_unavailable';}}return {state,driver:a?.id??null,archiveId:a?.archiveId??null,freeBytes,checkedAt:new Date().toISOString(),error,counts,evicted};}
function busy(ctx,t,jid){return !!ctx.db.sql.prepare("SELECT 1 FROM renders r,json_each(r.track_ids) t WHERE r.status IN ('queued','processing') AND t.value=? LIMIT 1").get(t.id)||ctx.uploads.has(t.id)||(ctx.archiveReaders?.get(t.id)??0)>0||ctx.db.all('exports').some(e=>e.trackId===t.id&&['queued','processing'].includes(e.status))||!!ctx.db.sql.prepare("SELECT 1 FROM jobs WHERE id!=? AND status IN ('queued','running') AND ((subject_type='track' AND subject_id=?) OR (subject_type='project' AND subject_id=?))").get(jid,t.id,locate(ctx,t).p.id);}
export function archiveHandler(ctx){return async(j,{signal})=>{
 const a=ctx.archive,t=ctx.db.get('tracks',j.subject_id);if(!t||t.status!=='ready')throw archiveError();const {r,p,base,local,name}=locate(ctx,t),rel=base+'/'+name;
 const check=async()=>{signal.throwIfAborted();return a.preflight(signal);};
 const original=()=>safePath(ctx.dataDir,local+'/'+name);
 const assertHash=async(file,expected)=>{if(await digest(file,signal)!==expected)throw archiveError('archive_checksum');};
 async function transfer(file,dest,hash){await check();const temp=dest+'.teil-'+j.id;const existing=await a.stat(dest);if(existing){if(await a.sha256(dest,signal)!==hash)throw archiveError('archive_conflict');await a.remove(temp);return;}await a.remove(temp);await a.put(file,temp,signal);if(await a.sha256(temp,signal)!==hash){await a.remove(temp);throw archiveError('archive_checksum');}await check();try{await a.commit(temp,dest);}catch(e){if(e.code!=='EEXIST'||await a.sha256(dest,signal)!==hash)throw archiveError('archive_conflict');await a.remove(temp);}}
 if(j.kind==='archive'){
 if((await check()).freeBytes<t.bytes+1024**3)throw archiveError('archive_space');
 await assertHash(await original(),t.sha256);
 await transfer(await original(),rel,t.sha256);
 // Small metadata snapshots live only inside this track directory, with job-specific ownership.
 async function metadata(value,dest){const tmp=await safePath(ctx.dataDir,local+'/metadata.teil-'+j.id);await writeFile(tmp,JSON.stringify(value),{flag:'wx',mode:0o600}).catch(async e=>{if(e.code!=='EEXIST')throw e;await unlink(tmp);await writeFile(tmp,JSON.stringify(value),{flag:'wx',mode:0o600});});try{await transfer(tmp,base+'/'+dest,checksum(JSON.stringify(value)));}finally{await unlink(tmp);}}
 const manifest={trackId:t.id,ownerId:t.ownerId,projectTitle:p.title,recordingTitle:r.title,participantName:t.participantName,mimeType:t.mimeType,bytes:t.bytes,sha256:t.sha256,durationMs:t.durationMs,archivedAt:j.created_at,schema:1};
 // Existing manifest is immutable; later snapshots use a new job UUID.
 await metadata(manifest,await a.stat(base+'/manifest.json')?'manifest-'+j.id+'.json':'manifest.json');
 const tr=ctx.db.sql.prepare('SELECT * FROM transcripts WHERE track_id=?').get(t.id);if(tr)await metadata(tr,await a.stat(base+'/transkript.json')?'transkript-'+tr.revision+'-'+checksum(JSON.stringify(tr))+'.json':'transkript.json');
 await check();if(await a.sha256(rel,signal)!==t.sha256)throw archiveError('archive_checksum');signal.throwIfAborted();
 return {save(){const fresh=ctx.db.get('tracks',t.id);if(fresh.sha256!==t.sha256||fresh.status!=='ready')throw archiveError('archive_checksum');ctx.db.put('tracks',{...fresh,archive:{status:'verified',verifiedAt:new Date().toISOString(),error:null}});}};
 }
 if(j.kind==='restore'){
 if(t.local!==false)return {};const temp=await safePath(ctx.dataDir,local+'/'+name+'.teil-'+j.id);await check();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});
 try{await a.fetch(rel,temp,signal);await assertHash(temp,t.sha256);await check();signal.throwIfAborted();const dest=await original();try{await link(temp,dest);const handle=await open(path.dirname(dest),'r');try{await handle.sync();}finally{await handle.close();}}catch(e){if(e.code!=='EEXIST')throw e;await assertHash(dest,t.sha256);}return {save(){const fresh=ctx.db.get('tracks',t.id);ctx.db.put('tracks',{...fresh,local:true});}};}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 if(j.kind==='evict'){
 if(settings(ctx.db).archiveEvictAfterDays===null||t.archive?.status!=='verified'||busy(ctx,t,j.id))throw archiveError();
 ctx.archiveLocks.add(t.id);
 try{await check();if(await a.sha256(rel,signal)!==t.sha256)throw archiveError('archive_checksum');if(busy(ctx,t,j.id))throw archiveError();
 // Enumerate only exact, DB-associated export files. Never recursive removal.
 const files=[await original()];for(const e of ctx.db.all('exports').filter(e=>e.trackId===t.id)){if(!uuid(e.id)||!['wav','mp3','mp4'].includes(e.format))throw archiveError();files.push(await safePath(ctx.dataDir,local+'/exporte/'+e.id+'.'+e.format));}
 await check();signal.throwIfAborted();if(await a.sha256(rel,signal)!==t.sha256||busy(ctx,t,j.id))throw archiveError();
 ctx.db.sql.prepare('INSERT INTO audit(at,actor_id,action,subject,detail) VALUES (?,?,?,?,?)').run(new Date().toISOString(),JSON.parse(j.input).actorId??j.owner_id,'archive.evict.verified',t.id,JSON.stringify({jobId:j.id,sha256:t.sha256}));
 for(const f of files){try{unlinkSync(f);}catch(e){if(e.code!=='ENOENT')throw e;}}
 ctx.db.tx(()=>{const fresh=ctx.db.get('tracks',t.id);ctx.db.put('tracks',{...fresh,local:false});for(const e of ctx.db.all('exports').filter(e=>e.trackId===t.id))ctx.db.put('exports',{...e,status:'failed',bytes:null,error:'Archiviert; Export nach Zurückholen neu erzeugen.'});ctx.db.sql.prepare('INSERT INTO audit(at,actor_id,action,subject) VALUES (?,?,?,?)').run(new Date().toISOString(),JSON.parse(j.input).actorId??j.owner_id,'archive.evict',t.id);});return {};
 }finally{ctx.archiveLocks.delete(t.id);}
 }
 throw archiveError();
 };}
export async function archive(ctx,req,res,pathname,user,{json}){
 const m=pathname.match(/^\/api\/(?:admin\/)?tracks\/([^/]+)\/(archive|evict|restore)$/),status=pathname==='/api/admin/archive';if(!m&&!status)return false;
 requireUser(user);const nf=()=>problem(404,'not_found','Nicht gefunden.');if(status||m[2]!=='restore'){if(user.role!=='owner')throw nf();}
 if(status){if(req.method!=='GET')throw problem(405,'method_not_allowed','Methode nicht erlaubt.');json(res,200,await archiveStatus(ctx));return true;}
 if((m[2]==='restore')!==!pathname.startsWith('/api/admin/'))throw nf();const t=ctx.db.get('tracks',m[1]);if(!t||!uuid(t.id)||m[2]==='restore'&&t.ownerId!==user.id)throw nf();
 if(req.method!=='POST')throw problem(405,'method_not_allowed','Methode nicht erlaubt.');limit(ctx,'job:'+user.id,30,60000);
 if(!ctx.archive?.id)throw problem(503,'configuration_required','Archiv nicht eingerichtet.',{service:'archive',missing:ctx.archive?.missing??['STUDIO_ARCHIVE_DRIVER']});await ctx.archive.preflight();
 const key=req.headers['idempotency-key'];if(key){const old=ctx.db.sql.prepare('SELECT * FROM jobs WHERE owner_id=? AND idem_key=?').get(t.ownerId,key);if(old){if(old.kind!==m[2]||old.subject_id!==t.id)throw problem(409,'idempotency_conflict','Idempotenzschlüssel bereits verwendet.');json(res,200,jobView(old));return true;}}
 if(t.status!=='ready')throw problem(409,'not_ready','Spur ist nicht bereit.');if(m[2]==='restore'&&t.local!==false)throw problem(409,'already_local','Spur ist lokal.');if(m[2]==='evict'&&(settings(ctx.db).archiveEvictAfterDays===null||t.archive?.status!=='verified'))throw problem(409,'not_ready','Auslagern ist gesperrt.');
 const active=ctx.db.sql.prepare("SELECT * FROM jobs WHERE subject_id=? AND kind=? AND status IN ('queued','running')").get(t.id,m[2]);if(active){json(res,200,jobView(active));return true;}
 const result=ctx.work.create({ownerId:t.ownerId,kind:m[2],subjectType:'track',subjectId:t.id,input:{actorId:user.id},idemKey:req.headers['idempotency-key']??null});json(res,result.reused?200:202,jobView(result.job));return true;
}

// Automatic copying is opt-in; automatic eviction deliberately has no scheduler.
export function archiveAuto(ctx){if(!ctx.archive?.id||settings(ctx.db).archiveMode!=='auto')return;for(const t of ctx.db.all('tracks')){if(t.status!=='ready'||t.local===false||t.archive?.status==='verified')continue;if(ctx.db.sql.prepare("SELECT 1 FROM jobs WHERE subject_id=? AND kind='archive'").get(t.id))continue;try{ctx.work.create({ownerId:t.ownerId,kind:'archive',subjectType:'track',subjectId:t.id,input:{automatic:true}});}catch{ /* quotas or unclaimed data: next tick */ }}}
