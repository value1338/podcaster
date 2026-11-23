// PA10 route inventory derived from source regex/literal nodes and router parts branches.
import ts from 'typescript';
import {readFile,writeFile,mkdir,mkdtemp,rm,readdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {testServer} from '../server/hilfen.mjs';
const out=path.resolve('../Pruefungen/Plattform/PA10-Gesamt');await mkdir(out,{recursive:true});
const paths=new Map(),sources=[];
function add(p,source){if(p.startsWith('/api/'))paths.set(p,{path:p,source});}
function expand(s){
 s=s.replace(/^\^/,'').replace(/\$$/,'').replaceAll('\\/','/').replaceAll('([^/]+)',':id');
 for(let k=0;k<20 && /\([^()]*\)/.test(s);k++){
 const m=/\((?:\?:)?([^()]*)\)(\?)?/.exec(s);if(!m)break;
 const opts=m[1].split('|');if(m[2])opts.push('');return opts.flatMap(x=>expand(s.slice(0,m.index)+x+s.slice(m.index+m[0].length)));
 }return [s];
}
for(const file of ['router','platform','accounts','admin','transcripts','llm','archive']){
 const text=await readFile(`server/${file}.mjs`,'utf8');const ast=ts.createSourceFile(file+'.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 sources.push({file,sha256:createHash('sha256').update(text).digest('hex')});
 function visit(n){if(ts.isRegularExpressionLiteral(n)&&n.text.includes('api')){const src=n.text.slice(1,n.text.lastIndexOf('/'));for(const p of expand(src))add(p,`${file}:${ast.getLineAndCharacterOfPosition(n.pos).line+1}`);}if(ts.isStringLiteral(n)&&n.text.startsWith('/api/')&&!n.text.endsWith('/'))add(n.text,`${file}:${ast.getLineAndCharacterOfPosition(n.pos).line+1}`);ts.forEachChild(n,visit);}visit(ast);
 if(file==='router'){
 // v1 uses imperative parts[] checks: derive collections, arity and suffixes from actual branches.
 let collection='';for(const [i,line] of text.split('\n').entries()){
 const c=/if\(parts\[1\]==='([^']+)'\)/.exec(line);if(c)collection=c[1];if(!collection)continue;
 for(const m of line.matchAll(/parts.length===(\d+)/g)){const len=+m[1];let p='/api/'+collection;if(len>=3)p+='/:id';if(len>=4){const suffix=/parts\[3\]==='([^']+)'/.exec(line);if(!suffix)continue;p+='/'+suffix[1];}if(len===5)p+='/0';add(p,`router:${i+1}`);}
 // exports base branch has no explicit length check before verb
 if(collection==='exports')add('/api/exports/:id',`router:${i+1}`);
 }
 }
}
// Reject parser artefacts; include explicit extraction limits rather than claiming arbitrary JS route completeness.
for(const [p] of paths)if(/[()[\]\\?*]/.test(p)||p==='/api/admin')paths.delete(p);
await writeFile(path.join(out,'routeninventar.json'),JSON.stringify({sources,limits:'AST literal/regex extraction, finite alternative/optional expansion; v1 parts branches heuristic. Methods probed, unsupported combinations retained. Dynamic computed routers not generally provable; platform fallback includes nonimplemented control paths.',routes:[...paths.values()]},null,2));
const s=await testServer();let failures=[];const rows=[];try{
const req=async(m,p,c,body,extra={})=>{const r=await fetch(`http://127.0.0.1:${s.app.server.address().port}${p}`,{method:m,headers:{Origin:'http://127.0.0.1:8871','X-Studio':'1',...(c?{Cookie:c}:{}),...extra},body:['GET','HEAD'].includes(m)?undefined:JSON.stringify(body??{})});return {status:r.status,text:await r.text(),disposition:r.headers.get('content-disposition')};};
const redeem=async(url,b)=>{const r=await s.request('POST','/auth/token/'+url.split('/').at(-1),b);return r.headers.get('set-cookie').split(';')[0]};
const a=await redeem(s.link.url,{password:'pa10-owner-password'});const inv=await(await s.request('POST','/admin/invites',{email:'pa10-member@test.test',planId:'free'},a)).json();const b=await redeem(inv.url,{password:'pa10-member-password',displayName:'Member'});
const aid=(await(await s.request('GET','/session',undefined,a)).json()).user.id;
const p=await(await s.request('POST','/projects',{title:'PRIVATE PA10'},a)).json();const t=(await(await s.request('POST',`/projects/${p.id}/recordings`,{title:'PRIVATE',mimeType:'audio/webm',kind:'audio',participantName:'A',startedAtMs:0},a)).json()).track;
const mediaDir=path.join(s.dir,'medien',p.id,t.recordingId,t.id);await mkdir(mediaDir+'/exporte',{recursive:true});await writeFile(mediaDir+'/original.webm','PA10 PRIVATE MEDIA');t.status='ready';t.bytes=18;s.app.ctx.db.put('tracks',t);
const e={id:randomUUID(),ownerId:aid,trackId:t.id,status:'ready',format:'wav'};s.app.ctx.db.put('exports',e);await writeFile(mediaDir+'/exporte/'+e.id+'.wav','PA10 PRIVATE EXPORT');
const byteSnapshot=async()=>JSON.stringify(await Promise.all(['original.webm','exporte/'+e.id+'.wav'].map(async f=>[f,createHash('sha256').update(await readFile(mediaDir+'/'+f)).digest('hex')])));const originalBytes=await byteSnapshot();
const gid=randomUUID(),jid=randomUUID(),now=new Date().toISOString();
s.app.ctx.db.sql.prepare('INSERT INTO jobs(id,owner_id,kind,subject_type,subject_id,status,input,created_at) VALUES (?,?,?,?,?,?,?,?)').run(jid,aid,'asr','track',t.id,'failed','{}',now);
s.app.ctx.db.sql.prepare('INSERT INTO generations(id,owner_id,project_id,track_id,job_id,task,content,provider,model,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(gid,aid,p.id,t.id,jid,'shownotes','PRIVATE Äpfel','test','test',now);
const segments=JSON.stringify([{id:'s1',startMs:0,endMs:100,text:'PRIVATE Äpfel'}]);
s.app.ctx.db.sql.prepare('INSERT INTO transcripts(id,track_id,owner_id,job_id,model,device,timestamps,duration_ms,segments,machine,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),t.id,aid,jid,'test','cpu','segment',100,segments,segments,now,now);
const snapshot=()=>JSON.stringify(s.app.ctx.db.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,s.app.ctx.db.sql.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
function bind(url,foreign=false){const id=url.includes('/projects/')?p.id:url.includes('/exports/')?e.id:url.includes('/generations/')?gid:url.includes('/jobs/')?jid:url.includes('/users/')?aid:url.includes('/plans/')?'free':url.includes('/invites/')?inv.id:t.id;return url.replaceAll(':id',foreign?randomUUID():id);}
for(const route of paths.values())for(const method of ['GET','HEAD','POST','PUT','PATCH','DELETE']){
 const url=bind(route.path),isPublic=['/api/health','/api/session','/api/auth/login'].includes(url)||url.startsWith('/api/auth/token/');
 if(isPublic)continue;
 const before=snapshot();const no=await req(method,url);let good=no.status===401;
 const foreign=url==='/api/auth/logout'?{status:204}:await req(method,url,b);let missing=null;
 if(url.startsWith('/api/admin/'))good&&=foreign.status===404;
 else if(route.path.includes(':id')){missing=await req(method,bind(route.path,true),b);good&&=foreign.status===404&&missing.status===404&&foreign.text===missing.text&&!foreign.disposition;}
 good&&=snapshot()===before&&(await byteSnapshot())===originalBytes;
 rows.push({method,...route,noAuth:no.status,member:foreign.status,random:missing?.status,integrity:snapshot()===before,pass:good});if(!good)failures.push(rows.at(-1));
 if(method==='GET'||method==='HEAD')for(const query of route.path.endsWith('/file')?['?raw=1','?download=1','']:[]){const f=await req(method,url+query,b,undefined,{Range:'bytes=0-1'});const n=await req(method,url+query);const pass=f.status===404&&n.status===401&&!f.disposition;rows.push({method,path:route.path+query,range:true,pass});if(!pass)failures.push(rows.at(-1));}
}
// Own read controls prove seeded IDs resolve; mutable positive controls are covered in end-to-end suites.
for(const url of [`/api/tracks/${t.id}/file`,`/api/exports/${e.id}/file`,`/api/projects/${p.id}`,`/api/tracks/${t.id}`,`/api/exports/${e.id}`,`/api/jobs/${jid}`,`/api/tracks/${t.id}/transcript`,`/api/generations/${gid}`,`/api/generations/${gid}/file`]){const r=await req('GET',url,a);rows.push({ownControl:url,status:r.status,pass:r.status===200});if(r.status!==200)failures.push(rows.at(-1));}
await writeFile(path.join(out,'routenmatrix.json'),JSON.stringify({rows,failures,limitations:'All method probes include 405 cases. Snapshots all SQL rows and SHA256 of own ready synthetic media/export files; mutable own positive controls in separate browser/server evidence. No universal positive mutation control claimed.'},null,2));
console.log(JSON.stringify({inventory:paths.size,probes:rows.length,failures:failures.length}));
}finally{await s.close();}process.exitCode=failures.length?1:0;
