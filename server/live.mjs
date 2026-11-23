import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readdir,unlink,rmdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {problem,sendFile} from './storage.mjs';
import {requireUser,hashToken,secret,limit} from './auth.mjs';
const managers=new WeakMap();
const filePattern=/^(?:index\.m3u8|init\.mp4|seg-\d{1,7}\.m4s)$/;
const cleanupPattern=/^(?:index\.m3u8|init\.mp4|seg-\d{1,7}\.m4s)(?:\.tmp)?$/;
const missing=()=>problem(404,'not_found','Nicht gefunden.');
const now=()=>new Date().toISOString();
const bad=()=>problem(400,'invalid_input','Ungültige Eingabe.');
const mimePattern=/^video\/(?:webm|mp4)(?:;\s*codecs="?(?:vp8|vp9|opus|avc1\.[0-9a-fA-F]{6}|mp4a\.40\.2)(?:\s*,\s*(?:vp8|vp9|opus|avc1\.[0-9a-fA-F]{6}|mp4a\.40\.2))*"?)?$/;
export function createLive(ctx){
 if(managers.has(ctx))return managers.get(ctx);
 const sql=ctx.db.sql, processes=new Map(),viewers=new Map(),interruptions=new Map();let closed=false,pending=false;
 const row=id=>sql.prepare('SELECT * FROM live_sessions WHERE id=?').get(id);
 const setting=(key,fallback,cap)=>{try{const n=JSON.parse(sql.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value);return Number.isFinite(n)?Math.max(1,Math.min(cap,Math.floor(n))):fallback;}catch{return fallback;}};
 const maxViewers=()=>setting('live.maxViewers',10,25);
 const dir=(id,epoch)=>path.join(ctx.dataDir,'live',id,String(epoch));
 async function clean(id){
 if(!/^[a-f0-9-]{36}$/.test(id))return;
 const base=path.join(ctx.dataDir,'live',id);
 if(await lstat(base).then(s=>s.isSymbolicLink()).catch(()=>true))return;
 for(const e of await readdir(base,{withFileTypes:true}).catch(()=>[])){
 if(!/^\d{1,10}$/.test(e.name)||!e.isDirectory())continue;
 const d=path.join(base,e.name);
 for(const f of await readdir(d,{withFileTypes:true}).catch(()=>[]))if(cleanupPattern.test(f.name)&&f.isFile())await unlink(path.join(d,f.name)).catch(()=>{});
 await rmdir(d).catch(()=>{});
 }await rmdir(base).catch(()=>{});
 }
 function removeViewer(key){const v=viewers.get(key);for(const res of v?.responses??[])res.destroy();viewers.delete(key);}
 function purge(id){for(const [key,v] of viewers)if(v.id===id)removeViewer(key);}
 function prune(){const t=Date.now();for(const [key,v] of viewers)if(t-v.heartbeat>=60000||!row(v.id)?.token_hash)removeViewer(key);}
 const count=id=>{prune();return [...viewers.values()].filter(v=>v.id===id&&Date.now()-v.heartbeat<15000).length;};
 const state=r=>({status:r.status,publicTitle:r.public_title,epoch:r.epoch,startedAt:r.started_at});
 const dto=r=>({id:r.id,...state(r),endReason:r.end_reason,linkActive:!!r.token_hash,viewers:count(r.id),maxViewers:maxViewers(),endedAt:r.ended_at,createdAt:r.created_at,health:r.status==='live'?{lastChunkAgeMs:processes.get(r.id)?Date.now()-processes.get(r.id).last:null,speed:processes.get(r.id)?.speed??null}:null});
 async function kill(id){const p=processes.get(id);if(!p)return;p.stopping=true;p.child.stdin.destroy();p.child.kill('SIGTERM');const timer=setTimeout(()=>p.child.kill('SIGKILL'),1500);try{await p.done;}finally{clearTimeout(timer);}}
 async function interrupt(id){const r=row(id);if(r?.status!=='live')return;sql.prepare("UPDATE live_sessions SET status='interrupted' WHERE id=? AND status='live'").run(id);interruptions.set(id,Date.now());await kill(id);await clean(id);processes.delete(id);}
 async function end(id,reason){if(!row(id))return;sql.prepare("UPDATE live_sessions SET status='ended',end_reason=?,ended_at=?,token_hash=NULL WHERE id=? AND status!='ended'").run(reason,now(),id);purge(id);interruptions.delete(id);await kill(id);await clean(id);processes.delete(id);}
 const timer=setInterval(()=>{prune();for(const r of sql.prepare("SELECT * FROM live_sessions WHERE status IN ('live','interrupted')").all()){
 const t=Date.now();let action;
 if(r.started_at&&t-Date.parse(r.started_at)>=setting('live.maxMinutes',240,240)*60000)action=end(r.id,'time_limit');
 else if(r.status==='live'&&t-(processes.get(r.id)?.last??0)>=20000)action=interrupt(r.id);
 else if(r.status==='interrupted'&&t-(interruptions.get(r.id)??t)>=120000)action=end(r.id,'timeout');
 action?.catch(()=>{});
 }},1000);timer.unref();
 const api={active:()=>pending||processes.size>0,
 recover(){for(const r of sql.prepare("SELECT id FROM live_sessions").all()){sql.prepare("UPDATE live_sessions SET status='ended',end_reason='server_restart',ended_at=?,token_hash=NULL WHERE id=? AND status!='ended'").run(now(),r.id);clean(r.id).catch(()=>{});}},
 async close(){closed=true;clearInterval(timer);while(pending)await new Promise(r=>setTimeout(r,10));await Promise.all(sql.prepare("SELECT id FROM live_sessions WHERE status!='ended'").all().map(r=>end(r.id,'server_restart')));viewers.clear();},
 async handle(req,res,pathname,user,h){
 const {json,body}=h;const method=req.method;const empty=()=>{res.writeHead(204,{'Cache-Control':'no-store'});res.end();return true;};const reply=(code,data)=>{json(res,code,data);return true;};
 const verb=(...methods)=>{if(!methods.includes(method))throw problem(405,'method_not_allowed','Methode nicht erlaubt.');};
 const cookie=(token,age=60)=>res.setHeader('Set-Cookie',`ps_zuschauer=${token}; HttpOnly; Secure; SameSite=Strict; Path=${ctx.base}/api/watch/; Max-Age=${age}`);
 if(pathname.startsWith('/api/watch/')){
 if(pathname==='/api/watch/enter'){
 verb('POST');
 // Behind tailscale serve every request comes from loopback; the proxy puts the real peer last in X-Forwarded-For. Only failed attempts count, so reloading viewers never lock others out.
 const peer=/^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress??'')&&req.headers['x-forwarded-for']?String(req.headers['x-forwarded-for']).split(',').at(-1).trim():req.socket.remoteAddress;const fail=()=>{limit(ctx,'watch-enter:'+peer,20,900000);return missing();};
 const b=await body(req);if(typeof b.token!=='string'||b.token.length>128)throw fail();
 const r=sql.prepare("SELECT * FROM live_sessions WHERE token_hash=? AND status!='ended'").get(hashToken(b.token));if(!r)throw fail();prune();
 const old=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ps_zuschauer='))?.slice(13);if(old)removeViewer(hashToken(old));
 if(count(r.id)>=maxViewers()||[...viewers.values()].filter(v=>v.id===r.id).length>=maxViewers()+5)throw problem(429,'viewers_full','Alle Zuschauerplätze sind belegt.');
 const token=secret();viewers.set(hashToken(token),{id:r.id,link:r.token_hash,heartbeat:Date.now(),bucket:10,at:Date.now()});cookie(token);return empty();
 }
 const token=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ps_zuschauer='))?.slice(13);if(!token||token.length>128)throw missing();prune();const key=hashToken(token),v=viewers.get(key),r=v&&row(v.id);
 if(!v||!r||r.status==='ended'||!r.token_hash||v.link!==r.token_hash)throw missing();
 const t=Date.now();v.bucket=Math.min(10,v.bucket+(t-v.at)/100);v.at=t;if(v.bucket<1)throw problem(429,'rate_limited','Zu viele Anfragen.');v.bucket--;
 if(pathname==='/api/watch/state'){verb('GET');if(t-v.heartbeat>=15000&&count(r.id)>=maxViewers())throw problem(429,'viewers_full','Alle Zuschauerplätze sind belegt.');v.heartbeat=t;cookie(token);return reply(200,state(r));}
 if(pathname==='/api/watch/leave'){verb('POST');removeViewer(key);cookie('',0);return empty();}
 const m=pathname.match(/^\/api\/watch\/hls\/(\d{1,10})\/([^/]+)$/);if(!m||!filePattern.test(m[2])||Number(m[1])!==r.epoch||r.status!=='live')throw missing();verb('GET','HEAD');
 const file=path.join(dir(r.id,r.epoch),m[2]);const s=await lstat(file).catch(()=>null);if(!s?.isFile()||s.isSymbolicLink())throw missing();
 // File access yields: validate the current permission again before registering delivery.
 const fresh=row(v.id);if(viewers.get(key)!==v||Date.now()-v.heartbeat>=60000||!fresh||fresh.status!=='live'||fresh.epoch!==Number(m[1])||!fresh.token_hash||fresh.token_hash!==v.link)throw missing();
 v.responses??=new Set();v.responses.add(res);try{await sendFile(req,res,file,{type:m[2].endsWith('m3u8')?'application/vnd.apple.mpegurl':m[2].endsWith('m4s')?'video/iso.segment':'video/mp4'});}finally{v.responses.delete(res);}return true;
 }
 requireUser(user);
 if(pathname==='/api/live'){
 verb('GET','POST');if(method==='GET')return reply(200,sql.prepare('SELECT * FROM live_sessions WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(user.id).map(dto));
 limit(ctx,'create:'+user.id,60,60000);const b=await body(req);if(typeof b.publicTitle!=='string'||!b.publicTitle.trim()||b.publicTitle.trim().length>120)throw bad();
 if(sql.prepare("SELECT id FROM live_sessions WHERE owner_id=? AND status!='ended'").get(user.id))throw problem(409,'live_exists','Eine Sendung ist bereits offen.');
 const id=randomUUID(),token=secret();sql.prepare("INSERT INTO live_sessions(id,owner_id,public_title,status,token_hash,token_created_at,created_at) VALUES(?,?,?,'created',?,?,?)").run(id,user.id,b.publicTitle.trim(),hashToken(token),now(),now());return reply(201,{live:dto(row(id)),link:link(token)});
 }
 const m=pathname.match(/^\/api\/live\/([a-f0-9-]{36})(?:\/(.*))?$/);const r=m&&row(m[1]);if(!r||r.owner_id!==user.id)throw missing();const action=m[2];
 if(!action){verb('GET');return reply(200,dto(r));}
 if(action==='stop'){verb('POST');await end(r.id,'host_stop');return reply(200,dto(row(r.id)));}
 if(action==='link'){verb('POST','DELETE');if(r.status==='ended')throw missing();const token=method==='POST'?secret():null;sql.prepare('UPDATE live_sessions SET token_hash=?,token_created_at=? WHERE id=?').run(token?hashToken(token):null,token?now():null,r.id);purge(r.id);return token?reply(200,link(token)):empty();}
 if(action==='start'){
 verb('POST');const b=await body(req);if(!mimePattern.test(b.mimeType??''))throw problem(415,'unsupported_media','Medienformat nicht unterstützt.');
 if(!['created','interrupted'].includes(row(r.id).status))throw problem(409,'not_live','Sendung kann nicht gestartet werden.');
 if(closed||api.active())throw problem(409,'live_busy','Eine Sendung läuft bereits.');if(!ctx.hasFFmpeg)throw problem(503,'configuration_required','ffmpeg fehlt.',{service:'live'});
 pending=true;try{await kill(r.id);await clean(r.id);const epoch=row(r.id).epoch+1,d=dir(r.id,epoch);await mkdir(d,{recursive:true,mode:0o700});if(closed||!['created','interrupted'].includes(row(r.id).status)){await clean(r.id);throw problem(409,'not_live','Sendung wurde beendet.');}
 const fmt=b.mimeType.startsWith('video/mp4')?'mov':'webm';const args=['-hide_banner','-loglevel','warning','-nostats','-progress','pipe:3','-probesize','1048576','-analyzeduration','1000000','-protocol_whitelist','pipe','-f',fmt,'-i','pipe:0','-map','0:v:0','-map','0:a:0','-vf',"scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",'-c:v','libx264','-threads','3','-preset','veryfast','-tune','zerolatency','-profile:v','main','-level','3.1','-pix_fmt','yuv420p','-g','60','-keyint_min','60','-sc_threshold','0','-b:v','2500k','-maxrate','2500k','-bufsize','5000k','-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-f','hls','-hls_time','2','-hls_list_size','6','-hls_segment_type','fmp4','-hls_flags','delete_segments+independent_segments+omit_endlist+temp_file','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename','seg-%d.m4s','index.m3u8'];
 const child=spawn('ffmpeg',args,{cwd:d,stdio:['pipe','ignore','pipe','pipe']});const p={child,last:Date.now(),seq:0,busy:false,stopping:false,speed:null};p.done=new Promise(resolve=>child.once('close',resolve));child.stdin.on('error',()=>{});child.stderr.on('data',b=>{p.stderr=((p.stderr??'')+String(b)).slice(-4000);});child.stdio[3].on('data',b=>{const m=String(b).match(/speed=([\d.]+)x/);if(m)p.speed=Number(m[1]);});
 processes.set(r.id,p);
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(problem(503,'configuration_required','ffmpeg nicht verfügbar.',{service:'live'})));});
 if(p.stopping||closed||row(r.id).status==='ended'){await kill(r.id);processes.delete(r.id);await clean(r.id);throw problem(409,'not_live','Sendung wurde beendet.');}sql.prepare("UPDATE live_sessions SET status='live',epoch=?,started_at=coalesce(started_at,?) WHERE id=?").run(epoch,now(),r.id);interruptions.delete(r.id);
 p.done.then(()=>{if(!p.stopping)interrupt(r.id).catch(()=>{});});return reply(200,{epoch});
 }catch(e){if(processes.get(r.id)){await kill(r.id);processes.delete(r.id);}await clean(r.id);throw e;}finally{pending=false;}
 }
 const ingest=action.match(/^ingest\/(\d{1,10})\/(\d{1,10})$/);if(ingest){verb('PUT');const p=processes.get(r.id);if(r.status!=='live'||Number(ingest[1])!==r.epoch||!p)throw problem(409,'not_live','Sendung ist nicht aktiv.');
 const seq=Number(ingest[2]);if(p.busy||seq!==p.seq&&seq!==p.seq-1)throw problem(409,'seq_mismatch','Falsche Abschnittsnummer.',{expected:p.seq});if(Number(req.headers['content-length'])>4194304)throw problem(413,'too_large','Abschnitt ist zu groß.');
 const duplicate=seq===p.seq-1;p.busy=true;let size=0;const deadline=setTimeout(()=>{req.destroy();interrupt(r.id).catch(()=>{});},5000);
 try{for await(const b of req){size+=b.length;if(size>4194304)throw problem(413,'too_large','Abschnitt ist zu groß.');if(duplicate)continue;await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{reject(Error('drain'));},5000);p.child.stdin.write(b,e=>{clearTimeout(timeout);e?reject(e):resolve();});});}if(!size)throw bad();if(processes.get(r.id)!==p||row(r.id).status!=='live')throw problem(409,'not_live','Sendung wurde unterbrochen.');if(!duplicate){p.seq++;p.last=Date.now();}return empty();}catch(e){await interrupt(r.id);throw e.status?e:problem(409,'not_live','Sendung wurde unterbrochen.');}finally{clearTimeout(deadline);p.busy=false;}
 }
 throw missing();
 }
 };
 function link(token){const base=(process.env.STUDIO_PUBLIC_URL??ctx.auth.origins[0]+ctx.base).replace(/\/$/,'');return {url:base+'/zuschauen#t='+token};}
 managers.set(ctx,api);return api;
}
export async function live(ctx,req,res,pathname,user,h){if(!/^\/api\/(?:live(?:\/|$)|watch(?:\/|$))/.test(pathname))return false;return createLive(ctx).handle(req,res,pathname,user,h);}
