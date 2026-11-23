import path from 'node:path';
import {constants,createReadStream,createWriteStream} from 'node:fs';
import {lstat,realpath,readFile,stat,statfs,mkdir,open,link,unlink} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
export const archiveError=(code='archive_unavailable')=>Object.assign(Error('Archivprüfung fehlgeschlagen.'),{code,status:503,retryable:['archive_unavailable','archive_checksum'].includes(code)});
export async function safePath(root,rel,create=false){
 if(!rel||path.isAbsolute(rel)||rel.includes('\\')||rel.split('/').some(p=>!p||p==='.'||p==='..'||! /^[a-zA-Z0-9._-]+$/.test(p)))throw archiveError();
 const base=path.resolve(root);if(await realpath(base)!==base)throw archiveError();
 const parts=rel.split('/');let p=base;
 for(let i=0;i<parts.length;i++){p=path.join(p,parts[i]);let s;try{s=await lstat(p);}catch(e){if(e.code!=='ENOENT')throw e;if(create&&i<parts.length-1){try{await mkdir(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}s=await lstat(p);}else continue;}if(s&&(s.isSymbolicLink()||i<parts.length-1&&!s.isDirectory()||i===parts.length-1&&!s.isFile()))throw archiveError();}
 return p;
}
export async function digest(file,signal){const h=createHash('sha256');for await(const b of createReadStream(file,{flags:constants.O_RDONLY|constants.O_NOFOLLOW,signal}))h.update(b);return h.digest('hex');}
async function copy(source,dest,signal){await pipeline(createReadStream(source,{flags:constants.O_RDONLY|constants.O_NOFOLLOW}),createWriteStream(dest,{flags:constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode:0o600}),{signal});const out=await open(dest,constants.O_RDONLY|constants.O_NOFOLLOW);try{await out.sync();}finally{await out.close();}}

// mountinfo escapes are octal; validate before decoding, including unrelated rows.
export function validateArchiveMount(info,root,expectedFilesystem){
 const decode=value=>{if(/\\(?!040|011|012|134)/.test(value))throw archiveError();return value.replace(/\\(040|011|012|134)/g,(_,n)=>String.fromCharCode(parseInt(n,8)));};
 let selected;
 for(const row of info.trimEnd().split('\n')){
  const f=row.split(' '),sep=f.indexOf('-');
  if(sep<6||f.length!==sep+4||f.some(v=>!v)||!/^\d+$/.test(f[0])||!/^\d+$/.test(f[1])||!/^\d+:\d+$/.test(f[2])||!f[4].startsWith('/'))throw archiveError();
  decode(f[3]);const point=decode(f[4]);decode(f[sep+2]);
  if(point===root)selected={type:f[sep+1],options:f[5].split(',')};
 }
 if(!selected||(expectedFilesystem&&selected.type!==expectedFilesystem)||(selected.type==='cifs'&&!selected.options.includes('nosymfollow')))throw archiveError();
 return selected;
}

export function createArchiveTarget(env=process.env){
 if(env.STUDIO_ARCHIVE_DRIVER==='fake')throw Error('Fake-Archiv nur als expliziter Testadapter injizieren.');
 const missing=['STUDIO_ARCHIVE_DRIVER','STUDIO_ARCHIVE_PATH','STUDIO_ARCHIVE_ID'].filter(k=>!env[k]);if(env.STUDIO_ARCHIVE_DRIVER&&env.STUDIO_ARCHIVE_DRIVER!=='mount')missing.push('STUDIO_ARCHIVE_DRIVER=mount');
 if(missing.length)return {id:null,missing};
 const root=path.resolve(env.STUDIO_ARCHIVE_PATH),archiveId=env.STUDIO_ARCHIVE_ID;
 async function preflight(signal){signal?.throwIfAborted();try{if((await lstat(root)).isSymbolicLink()||await realpath(root)!==root||(await stat(root)).dev===(await stat(path.dirname(root))).dev)throw Error();validateArchiveMount(await readFile('/proc/self/mountinfo','utf8'),root,env.STUDIO_ARCHIVE_EXPECTED_FILESYSTEM);const marker=await safePath(root,'.podcast-studio-archiv.json');if((await lstat(marker)).size>4096)throw Error();if(JSON.parse(await readFile(marker,'utf8')).archiveId!==archiveId)throw Error();const s=await statfs(root);return {archiveId,freeBytes:s.bavail*s.bsize};}catch{throw archiveError();}}
 async function checked(rel,create=false,signal){await preflight(signal);return safePath(root,rel,create);}
 return {id:'mount',archiveId,missing:[],preflight,
 async stat(rel){const p=await checked(rel);try{return {bytes:(await lstat(p)).size};}catch(e){if(e.code==='ENOENT')return null;throw e;}},
 async sha256(rel,signal){return digest(await checked(rel,false,signal),signal);},
 async put(local,rel,signal){if(!/\.teil-[0-9a-f-]{36}$/.test(rel))throw archiveError();const p=await checked(rel,true,signal);await copy(local,p,signal);},
 async commit(temp,rel){if(!/\.teil-[0-9a-f-]{36}$/.test(temp)||path.dirname(temp)!==path.dirname(rel))throw archiveError();const a=await checked(temp),b=await checked(rel);await link(a,b);const d=await open(path.dirname(b),'r');try{await d.sync();}finally{await d.close();}await unlink(a);},
 async fetch(rel,temp,signal){await copy(await checked(rel,false,signal),temp,signal);},
 async remove(rel){if(!/\.teil-[0-9a-f-]{36}$/.test(rel))throw archiveError();const p=await checked(rel);await unlink(p).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 };
}
// Test-only adapter factory: never selected from the service environment.
export function fakeArchiveTarget(target){if(process.env.NODE_ENV!=='test')throw Error('Fake-Archiv außerhalb Tests verboten');return {...target,id:'fake'};}
