import path from 'node:path';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { stat, rm, rename } from 'node:fs/promises';
import { atomicStream, hashFile, problem } from './storage.mjs';
import { ffmpeg, probe } from './ffmpeg.mjs';
export const extensions={'audio/webm':'webm','video/webm':'webm','audio/mp4':'m4a','video/mp4':'mp4','audio/mpeg':'mp3','audio/wav':'wav'};
export function trackDir(ctx,t){const r=ctx.db.get('recordings',t.recordingId);return path.join(ctx.dataDir,'medien',r.projectId,r.id,t.id);}
export const chunkPath=(ctx,t,i)=>path.join(trackDir(ctx,t),'abschnitte',String(i).padStart(6,'0')+'.part');
export async function exists(file){try{await stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export async function contiguous(ctx,t){let i=0;while(i<100000&&await exists(chunkPath(ctx,t,i)))i++;return i;}
export function enqueueTrack(ctx,t){ctx.jobs.add('track:'+t.id,async signal=>{try{
 const ext=extensions[t.mimeType.split(';')[0]],dir=trackDir(ctx,t),raw=path.join(dir,'roh.'+ext),original=path.join(dir,'original.'+ext),temp=path.join(dir,'original.tmp.'+ext);
 if(!await exists(raw)||await exists(chunkPath(ctx,t,0))){async function* chunks(){for(let i=0;i<t.chunkCount;i++)yield* createReadStream(chunkPath(ctx,t,i));} await atomicStream(Readable.from(chunks()),raw);}
 const rawBytes=(await stat(raw)).size;t={...ctx.db.get('tracks',t.id),hasRaw:true,rawBytes};ctx.db.put('tracks',t);
 await ffmpeg(['-i',raw,'-map','0','-c','copy',...(['m4a','mp4'].includes(ext)?['-movflags','+faststart']:[]),temp],{durationMs:t.durationMs,signal,throttle:ctx.live?.active()??false});
 const p=await probe(temp,{signal});const video=p.streams.find(s=>s.codec_type==='video');if(!p.streams.some(s=>s.codec_type===t.kind))throw Error('Erwarteter Medientyp fehlt.');
 const sha256=await hashFile(temp),s=await stat(temp);await rename(temp,original);
 t=ctx.db.get('tracks',t.id);Object.assign(t,{status:'ready',error:null,sha256,bytes:s.size,durationMs:Math.round(Number(p.format.duration)*1000),width:video?.width??null,height:video?.height??null});ctx.db.put('tracks',t);await rm(path.join(dir,'abschnitte'),{recursive:true,force:true});
 }catch(e){const ext=extensions[t.mimeType.split(';')[0]];await rm(path.join(trackDir(ctx,t),'original.tmp.'+ext),{force:true});if(signal.aborted)return;t=ctx.db.get('tracks',t.id);Object.assign(t,{status:'failed',error:'media_invalid'});ctx.db.put('tracks',t);}});}
export async function finalize(ctx,t,b){if(['processing','ready'].includes(t.status))return 200;
 if(!Number.isInteger(b.chunkCount)||b.chunkCount<1||b.chunkCount>100000||!Number.isFinite(b.durationMs)||b.durationMs<0||b.durationMs>604800000||('allowPartial'in b&&typeof b.allowPartial!=='boolean'))throw problem(400,'invalid_input','Ungültiger Abschluss.');
 const missing=[];for(let i=0;i<b.chunkCount;i++)if(!await exists(chunkPath(ctx,t,i)))missing.push(i);
 const count=b.allowPartial?Math.min(b.chunkCount,await contiguous(ctx,t)):b.chunkCount;
 if((missing.length&&!b.allowPartial)||!count)throw problem(409,'chunks_missing','Abschnitte fehlen.',{missing});
 t=ctx.db.get('tracks',t.id);if(['processing','ready'].includes(t.status))return 200;Object.assign(t,{chunkCount:count,durationMs:b.durationMs,status:'processing',error:null});ctx.db.put('tracks',t);enqueueTrack(ctx,t);return 202;}
