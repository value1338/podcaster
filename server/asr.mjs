import path from 'node:path';
import {mkdir,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {run,ffmpeg} from './ffmpeg.mjs';
import {trackDir,extensions} from './tracks.mjs';
import {settings} from './admin.mjs';
import {asrError} from './asr-adapter.mjs';
export function windowBounds(duration,target,silences=[],maximum=Infinity){const bounds=[0];while(bounds.at(-1)<duration){const start=bounds.at(-1),goal=Math.min(duration,start+target);let end=goal;if(goal<duration){const candidates=silences.filter(x=>x>start&&Math.abs(x-goal)<=20000&&x-start<=maximum).sort((a,b)=>Math.abs(a-goal)-Math.abs(b-goal));end=candidates[0]??goal;}bounds.push(end);}return bounds;}
const mediaTask=(ctx,key,signal,fn)=>new Promise((resolve,reject)=>{let started=false;const abort=()=>{if(!started)reject(signal.reason??new DOMException('Abgebrochen','AbortError'));};if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});ctx.jobs.add(key,async queueSignal=>{try{signal.throwIfAborted();started=true;resolve(await fn(AbortSignal.any([signal,queueSignal])));}catch(e){reject(e);}finally{signal.removeEventListener('abort',abort);}});});
export function asrHandler(ctx){return async(j,{signal,state})=>{
 const track=ctx.db.get('tracks',j.subject_id),adapter=ctx.asr;if(!adapter?.health)throw Object.assign(Error('configuration_required'),{code:'configuration_required'});const h=await adapter.health(signal),cfg=settings(ctx.db);if(cfg.asrRequireGpu&&h.device==='cpu')throw asrError('asr_gpu_required',true);
 const dir=path.join(ctx.dataDir,'arbeit/asr',j.id),wav=path.join(dir,'gesamt.wav');await mkdir(dir,{recursive:true});
 try{
 let saved=JSON.parse(j.state??'{}');
 await mediaTask(ctx,'asr-'+j.id,signal,async s=>{
 await ffmpeg(['-i',path.join(trackDir(ctx,track),'original.'+extensions[track.mimeType.split(';')[0]]),'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav],{signal:s,durationMs:track.durationMs});
 if(!saved.bounds){const silence=await run('ffmpeg',['-nostdin','-hide_banner','-i',wav,'-af','silencedetect=noise=-35dB:d=0.3','-f','null','-'],{signal:s,captureErrors:true,durationMs:track.durationMs});const points=[...silence.matchAll(/silence_end: ([\d.]+)/g)].map(m=>Math.round(Number(m[1])*1000));const max=h.maxAudioSeconds===null?Infinity:h.maxAudioSeconds*1000; saved={...saved,bounds:windowBounds(track.durationMs,Math.min(cfg.asrWindowSeconds*1000,max),points,max),windows:[]};state(saved);}
 });
 for(let i=0;i<saved.bounds.length-1;i++){if(saved.windows[i])continue;signal.throwIfAborted();const file=path.join(dir,i+'.wav'),start=saved.bounds[i],durationMs=saved.bounds[i+1]-start;
 await mediaTask(ctx,'asr-window-'+j.id,signal,s=>ffmpeg(['-ss',String(start/1000),'-i',wav,'-t',String(durationMs/1000),'-c:a','pcm_s16le',file],{signal:s,durationMs}));
 const result=await adapter.transcribe({wavPath:file,durationMs,language:JSON.parse(j.input).language,requestId:j.id+'-'+i},signal);if(cfg.asrRequireGpu&&result.device==='cpu')throw asrError('asr_gpu_required',true);saved.windows[i]=result;state({windows:saved.windows,progress:{done:i+1,total:saved.bounds.length-1}});await rm(file,{force:true});}
 const windows=saved.windows,modes=windows.map(w=>w.timestamps),timestamps=modes.includes('none')?'none':modes.includes('segment')?'segment':'word';let n=0;const segments=windows.flatMap((w,i)=>w.segments.map(s=>({...s,id:'s'+String(++n).padStart(4,'0'),startMs:s.startMs+saved.bounds[i],endMs:s.endMs+saved.bounds[i],words:s.words?.map(x=>({...x,startMs:x.startMs+saved.bounds[i],endMs:x.endMs+saved.bounds[i]}))??null,speaker:null,edited:false})));
 const id=randomUUID(),now=new Date().toISOString(),last=windows.at(-1);return {result:{transcriptId:id},actual:[{meter:'asr_seconds',used:Math.ceil(track.durationMs/1000)}],save(db){const existing=db.sql.prepare('SELECT edited,revision FROM transcripts WHERE track_id=?').get(track.id);if(existing&&((existing.edited&&!JSON.parse(j.input).replaceEdited)||(JSON.parse(j.input).expectedRevision!==undefined&&existing.revision!==JSON.parse(j.input).expectedRevision)))throw asrError('transcript_edited');db.sql.prepare('INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,track.id,j.owner_id,j.id,last.language,last.model,last.device,timestamps,track.durationMs,JSON.stringify(segments),JSON.stringify(segments),0,(existing?.revision??0)+1,now,now);}};
 }finally{await rm(dir,{recursive:true,force:true});}
 };}
