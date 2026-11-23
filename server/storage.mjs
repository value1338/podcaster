import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, statfs, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
export const MAX_CHUNK=64*1024*1024;
export function problem(status,code,message,details={}) { return Object.assign(new Error(message),{status,code,details}); }
export async function atomicStream(source,target,limit=Infinity) {
 await mkdir(path.dirname(target),{recursive:true}); const temp=target+'.'+randomUUID()+'.tmp'; let bytes=0;
 try { await pipeline(source.httpVersion ? Readable.from(source.iterator({destroyOnReturn:false})) : source,new Transform({transform(chunk,enc,cb){bytes+=chunk.length; cb(bytes>limit?problem(413,'too_large','Abschnitt ist zu groß.'):null,chunk);}}),createWriteStream(temp,{flags:'wx',mode:0o600})); const handle=await open(temp,'r'); try {await handle.sync();} finally {await handle.close();} await rename(temp,target); return bytes; } finally {if(source.httpVersion&&!source.complete)source.resume();await rm(temp,{force:true});}
}
export async function hashFile(file) {const h=createHash('sha256'); for await(const b of createReadStream(file)) h.update(b); return h.digest('hex');}
export async function freeBytes(dir){const s=await statfs(dir); return s.bavail*s.bsize;}
export async function sendFile(req,res,file,{type='application/octet-stream',name,attachment=false}={}) {
 let s; try{s=await stat(file);}catch{throw problem(404,'not_found','Datei nicht gefunden.');}
 let start=0,end=s.size-1,status=200;
 if(req.headers.range){const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range); if(!m||(!m[1]&&!m[2])) throw problem(416,'invalid_range','Ungültiger Bytebereich.');
 if(!m[1]) start=Math.max(0,s.size-Number(m[2])); else start=Number(m[1]); if(m[1]&&m[2])end=Math.min(end,Number(m[2]));
 if(start>end||start>=s.size||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)){res.setHeader('Content-Range',`bytes */${s.size}`);throw problem(416,'invalid_range','Bytebereich außerhalb der Datei.');} status=206; res.setHeader('Content-Range',`bytes ${start}-${end}/${s.size}`);}
 res.writeHead(status,{'Content-Type':type,'Content-Length':Math.max(0,end-start+1),'Accept-Ranges':'bytes','Cache-Control':'no-store',...(attachment?{'Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name||'download')}`}:{})});
 if(req.method==='HEAD'||s.size===0){res.end();return;} try{await pipeline(createReadStream(file,{start,end}),res);}catch(e){if(!res.destroyed)throw e;}
}
