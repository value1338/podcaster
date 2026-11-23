import {renameSync} from 'node:fs';
import {quota} from './quota.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, stat, rename, rm } from 'node:fs/promises';
import { trackDir, extensions } from './tracks.mjs';
import { ffmpeg, probe } from './ffmpeg.mjs';
import { problem } from './storage.mjs';
export function exportPath(ctx,e){return path.join(trackDir(ctx,ctx.db.get('tracks',e.trackId)),'exporte',e.id+'.'+e.format);}
export function enqueueExport(ctx,e){ctx.jobs.add('export:'+e.id,async signal=>{const t=ctx.db.get('tracks',e.trackId);try{e.status='processing';ctx.db.put('exports',e);const dest=exportPath(ctx,e),temp=dest+'.tmp.'+e.format;await mkdir(path.dirname(dest),{recursive:true});
 const codecs=e.format==='mp3'?['-vn','-c:a','libmp3lame','-b:a','192k']:e.format==='wav'?['-vn','-c:a','pcm_s16le','-ar','48000']:['-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart'];
 await ffmpeg(['-i',path.join(trackDir(ctx,t),'original.'+extensions[t.mimeType.split(';')[0]]),...codecs,temp],{durationMs:t.durationMs,signal,throttle:ctx.live?.active()??false});await probe(temp,{signal});const s=await stat(temp);ctx.db.tx(()=>{quota(ctx.db).checkStorage(e.ownerId,s.size);renameSync(temp,dest);Object.assign(e,{status:'ready',bytes:s.size,error:null,finishedAt:new Date().toISOString()});ctx.db.put('exports',e);});
 }catch(err){await rm(exportPath(ctx,e)+'.tmp.'+e.format,{force:true});if(signal.aborted)return;Object.assign(e,{status:'failed',error:'media_invalid',finishedAt:new Date().toISOString()});ctx.db.put('exports',e);}});}
export function createExport(ctx,t,format){if(!['mp3','wav','mp4'].includes(format)||format==='mp4'&&t.kind!=='video')throw problem(400,'invalid_format','Ungültiges Exportformat.');if(t.status!=='ready')throw problem(409,'not_ready','Spur ist noch nicht bereit.');
 const existing=ctx.db.all('exports').find(e=>e.trackId===t.id&&e.format===format&&e.status!=='failed');if(existing)return existing;
 const e={id:randomUUID(),ownerId:t.ownerId,trackId:t.id,format,status:'queued',error:null,bytes:null,createdAt:new Date().toISOString(),finishedAt:null};ctx.db.put('exports',e);enqueueExport(ctx,e);return e;}
