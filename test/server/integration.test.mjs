import { prepareTestDB } from './hilfen.mjs';
import './streaming-case.mjs';
import { test, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStudioServer } from '../../server/index.mjs';
import { run, probe } from '../../server/ffmpeg.mjs';
import { Jobs } from '../../server/jobs.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('real media: upload, repair, recovery, ranges, exports, persistence and validation',async()=>{
 // tmpfs: avoids fsync stalls on the I/O-loaded project disk
 const dir=await mkdtemp(path.join(os.tmpdir(),'studio-test-'));let app;
 try{
 const link=await prepareTestDB(dir);
 app=await createStudioServer({dataDir:dir,base:'/podcast',origins:'http://127.0.0.1:8871',cookieInsecure:true});await new Promise(r=>app.server.listen(8871,'127.0.0.1',r));
 const authResponse=await fetch('http://127.0.0.1:8871/api/auth/token/'+link.url.split('/').at(-1),{method:'POST',headers:{Origin:'http://127.0.0.1:8871','X-Studio':'1'},body:JSON.stringify({password:'local-media-test-password'})});expect(authResponse.status).toBe(200);const Cookie=authResponse.headers.get('set-cookie').split(';')[0];
 const authedFetch=(url,options={})=>fetch(url,{...options,headers:{Cookie,Origin:'http://127.0.0.1:8871','X-Studio':'1',...options.headers}});
 const request=async(method,p,b,binary=false)=>{const res=await authedFetch('http://127.0.0.1:8871/podcast/api'+p,{method,body:b===undefined?undefined:binary?b:JSON.stringify(b),headers:b===undefined?{}:{'Content-Type':binary?'application/octet-stream':'application/json'}});return [res.status,await res.json()];};
 const wait=async(p)=>{for(let i=0;i<200;i++){const [,v]=await request('GET',p);if(['ready','failed'].includes(v.status))return v;await sleep(25);}throw Error('timeout '+p);};
 expect((await request('GET','/health'))[1].ffmpeg).toBe(true);
 const [status,p]=await request('POST','/projects',{title:' Test / Projekt '});expect(status).toBe(201);
 expect((await request('PATCH','/projects/'+p.id,{title:'Neu'}))[0]).toBe(200);
 const create=async(mimeType='audio/webm',kind='audio')=>(await request('POST',`/projects/${p.id}/recordings`,{title:'Folge',participantName:'Ich',mimeType,kind,startedAtMs:123}))[1].track;
 expect((await request('POST',`/projects/${p.id}/recordings`,{mimeType:'audio/ogg'}))[0]).toBe(415);
 expect((await request('POST','/projects',{title:''}))[0]).toBe(400);
 expect((await request('DELETE','/projects'))[0]).toBe(405);
 expect((await request('GET','/tracks/not-a-uuid'))[0]).toBe(404);
 const fixture=path.join(dir,'fixture.webm');await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:a','libopus',fixture]);const bytes=await readFile(fixture),size=Math.ceil(bytes.length/3);const t=await create();
 expect((await request('GET','/projects'))[1].find(row=>row.id===p.id).recordingTitles).toEqual(['Folge']);
 expect((await request('PUT',`/tracks/${t.id}/chunks/2`,bytes.subarray(size*2),true))[1].receivedChunks).toBe(0);
 expect((await request('POST',`/tracks/${t.id}/finalize`,{chunkCount:3,durationMs:2000}))[1].error.missing).toEqual([0,1]);
 await request('PUT',`/tracks/${t.id}/chunks/0`,bytes.subarray(0,size),true);await request('PUT',`/tracks/${t.id}/chunks/0`,bytes.subarray(0,size),true);
 expect((await request('PUT',`/tracks/${t.id}/chunks/1`,bytes.subarray(size,size*2),true))[1].receivedChunks).toBe(3);
 expect((await request('PUT',`/tracks/${t.id}/chunks/100000`,bytes,true))[0]).toBe(400);
 expect((await request('POST',`/tracks/${t.id}/finalize`,{chunkCount:3,durationMs:2000}))[0]).toBe(202);
 let ready=await wait('/tracks/'+t.id);expect(ready.status,ready.error).toBe('ready');expect(Math.abs(ready.durationMs-2000)).toBeLessThan(500);
 expect((await request('POST',`/tracks/${t.id}/finalize`,{}))[0]).toBe(200);
 const response=await authedFetch(`http://127.0.0.1:8871/api/tracks/${t.id}/file?download=1`);const downloaded=Buffer.from(await response.arrayBuffer());expect(createHash('sha256').update(downloaded).digest('hex')).toBe(ready.sha256);expect(downloaded.includes(Buffer.from([0x1c,0x53,0xbb,0x6b]))).toBe(true);
 const range=await authedFetch(`http://127.0.0.1:8871/api/tracks/${t.id}/file`,{headers:{Range:'bytes=10-29'}});expect(range.status).toBe(206);expect(Buffer.from(await range.arrayBuffer())).toEqual(downloaded.subarray(10,30));
 expect((await authedFetch(`http://127.0.0.1:8871/api/tracks/${t.id}/file`,{headers:{Range:'bytes=999999999-'}})).status).toBe(416);
 for(const format of ['mp3','wav']){const pair=await Promise.all([request('POST',`/tracks/${t.id}/exports`,{format}),request('POST',`/tracks/${t.id}/exports`,{format})]);expect(pair[0][1].id).toBe(pair[1][1].id);const e=await wait('/exports/'+pair[0][1].id);expect(e.status,e.error).toBe('ready');const f=await authedFetch(`http://127.0.0.1:8871/api/exports/${e.id}/file`);expect(f.headers.get('content-disposition')).toContain('attachment');const file=path.join(dir,'download.'+format);await writeFile(file,Buffer.from(await f.arrayBuffer()));const info=await probe(file);expect(info.streams[0].codec_name).toBe(format==='mp3'?'mp3':'pcm_s16le');expect(Math.abs(Number(info.format.duration)-2)).toBeLessThan(.5);if(format==='wav')expect(info.streams[0].sample_rate).toBe('48000');}
 const bad=await create();await request('PUT',`/tracks/${bad.id}/chunks/0`,Buffer.from('broken'),true);await request('POST',`/tracks/${bad.id}/finalize`,{chunkCount:1,durationMs:1});expect((await wait('/tracks/'+bad.id)).status).toBe('failed');const raw=await authedFetch(`http://127.0.0.1:8871/api/tracks/${bad.id}/file?raw=1`);expect(await raw.text()).toBe('broken');
 const partial=await create();await request('PUT',`/tracks/${partial.id}/chunks/0`,bytes,true);expect((await request('POST',`/tracks/${partial.id}/finalize`,{chunkCount:2,durationMs:2000,allowPartial:true}))[0]).toBe(202);expect((await wait('/tracks/'+partial.id)).status).toBe('ready');
 const videoFile=path.join(dir,'video.webm');await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x120:r=10','-f','lavfi','-i','sine=sample_rate=48000','-t','1','-c:v','libvpx','-c:a','libopus',videoFile]);const v=await create('video/webm','video');await request('PUT',`/tracks/${v.id}/chunks/0`,await readFile(videoFile),true);await request('POST',`/tracks/${v.id}/finalize`,{chunkCount:1,durationMs:1000});expect((await wait('/tracks/'+v.id)).width).toBe(160);const [,e]=await request('POST',`/tracks/${v.id}/exports`,{format:'mp4'});expect((await wait('/exports/'+e.id)).status).toBe('ready');const ef=path.join(dir,'export.mp4');await writeFile(ef,Buffer.from(await(await authedFetch(`http://127.0.0.1:8871/api/exports/${e.id}/file`)).arrayBuffer()));const vp=await probe(ef);expect(vp.streams.map(s=>s.codec_name)).toEqual(['h264','aac']);expect(Math.abs(Number(vp.format.duration)-1)).toBeLessThan(.5);
 // Failed export has a reason; retry gets a fresh id and succeeds after source restoration.
 const ghost={...app.ctx.db.get('tracks',t.id),id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'};app.ctx.db.put('tracks',ghost);
 const [,failedExport]=await request('POST',`/tracks/${ghost.id}/exports`,{format:'mp3'});const failure=await wait('/exports/'+failedExport.id);expect(failure.status).toBe('failed');expect(failure.error).toBe('media_invalid');expect(failure.error).not.toContain(dir);
 const ghostDir=path.join(dir,'medien',p.id,t.recordingId,ghost.id);await mkdir(ghostDir,{recursive:true});await writeFile(path.join(ghostDir,'original.webm'),downloaded);
 const [,retry]=await request('POST',`/tracks/${ghost.id}/exports`,{format:'mp3'});expect(retry.id).not.toBe(failedExport.id);expect((await wait('/exports/'+retry.id)).status).toBe('ready');
 // Safari-compatible AAC/MP4 input container (not an actual Safari browser capture).
 const m4a=path.join(dir,'fixture.m4a');await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=sample_rate=48000','-t','1','-c:a','aac',m4a]);const aac=await create('audio/mp4');await request('PUT',`/tracks/${aac.id}/chunks/0`,await readFile(m4a),true);await request('POST',`/tracks/${aac.id}/finalize`,{chunkCount:1,durationMs:1000});expect((await wait('/tracks/'+aac.id)).status).toBe('ready');
 // Persist a queued finalization/export as if the process stopped before picking it up.
 const restart=await create();await request('PUT',`/tracks/${restart.id}/chunks/0`,bytes,true);app.ctx.db.put('tracks',{...app.ctx.db.get('tracks',restart.id),status:'processing',chunkCount:1,durationMs:2000});const persisted={...e,id:'12345678-1234-1234-1234-123456789abc',status:'processing'};app.ctx.db.put('exports',persisted);
 await app.close();app=await createStudioServer({dataDir:dir,origins:'http://127.0.0.1:8871',cookieInsecure:true});await new Promise(r=>app.server.listen(8871,'127.0.0.1',r));
 const poll=async(table,id)=>{for(let i=0;i<200;i++){const row=app.ctx.db.get(table,id);if(row.status==='ready'||row.status==='failed')return row;await sleep(25);}throw Error('restart timeout');};expect((await poll('tracks',restart.id)).status).toBe('ready');expect((await poll('exports',persisted.id)).status).toBe('ready');
 }finally{if(app)await app.close();await rm(dir,{recursive:true,force:true});}
},30000);
test('shared queue serializes jobs and subprocess failures surface',async()=>{const j=new Jobs();let active=0,max=0;for(let i=0;i<5;i++)j.add(String(i),async()=>{active++;max=Math.max(max,active);await sleep(10);active--;});await j.idle;expect(max).toBe(1);await j.close();await expect(run('ffmpeg',['-invalid-option'])).rejects.toThrow('fehlgeschlagen');const abort=new AbortController();const running=run('ffmpeg',['-re','-f','lavfi','-i','sine','-f','null','-'],{signal:abort.signal});setTimeout(()=>abort.abort(),50);await expect(running).rejects.toThrow();});
