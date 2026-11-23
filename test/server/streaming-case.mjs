import { prepareTestDB } from './hilfen.mjs';
import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
test.skipIf(process.env.STUDIO_TEST_GIB!=='1')('1 GiB streamed to separate server: bounded RSS, 64 MiB limit, restart',async()=>{
 const dir=await mkdtemp(path.resolve('../.studio-stream-'));let Cookie;let child;let peak=0;let baseline=0;
 const start=async()=>{child=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,STUDIO_DATA_DIR:dir,STUDIO_PORT:'8871',STUDIO_ORIGINS:'http://127.0.0.1:8871',STUDIO_COOKIE_INSECURE:'1'},stdio:['ignore','pipe','pipe']});await once(child.stdout,'data');};
 const rss=async()=>Number((await readFile(`/proc/${child.pid}/status`,'utf8')).match(/VmRSS:\s+(\d+)/)[1])*1024;
 const authedFetch=(url,options={})=>fetch(url,{...options,headers:{Cookie,Origin:'http://127.0.0.1:8871','X-Studio':'1',...options.headers}});
 const req=async(p,b)=>{const r=await authedFetch('http://127.0.0.1:8871/api'+p,{method:'POST',body:JSON.stringify(b)});return r.json();};
 try{const link=await prepareTestDB(dir);await start();const auth=await fetch('http://127.0.0.1:8871/api/auth/token/'+link.url.split('/').at(-1),{method:'POST',headers:{Origin:'http://127.0.0.1:8871','X-Studio':'1'},body:JSON.stringify({password:'local-stream-test-password'})});Cookie=auth.headers.get('set-cookie').split(';')[0];const p=await req('/projects',{title:'Streaming'});const {track}=await req(`/projects/${p.id}/recordings`,{title:'1 GiB',kind:'audio',mimeType:'audio/webm',participantName:'Test',startedAtMs:0});baseline=await rss();
 const block=Buffer.alloc(1024*1024,7);const upload=async(index,mb)=>{async function* source(){for(let j=0;j<mb;j++)yield block;}return authedFetch(`http://127.0.0.1:8871/api/tracks/${track.id}/chunks/${index}`,{method:'PUT',body:source(),duplex:'half'});};
 const timer=setInterval(()=>{rss().then(n=>peak=Math.max(peak,n)).catch(()=>{});},20);
 try{for(let i=0;i<32;i++){const r=await upload(i,32);expect(r.status).toBe(200);expect((await r.json()).receivedChunks).toBe(i+1);}const tooLarge=await upload(32,65);expect(tooLarge.status).toBe(413);}finally{clearInterval(timer);}
 expect(peak-baseline).toBeLessThan(192*1024*1024);
 // Kill an actual running process after persisted processing commit; reopen and verify terminal state.
 const r=await req(`/tracks/${track.id}/finalize`,{chunkCount:32,durationMs:60000});expect(r.status).toBe('processing');const exited=once(child,'exit');child.kill('SIGKILL');await exited;await start();let status;for(let i=0;i<400;i++){const row=await(await authedFetch(`http://127.0.0.1:8871/api/tracks/${track.id}`)).json();status=row.status;if(status==='failed'||status==='ready')break;await new Promise(r=>setTimeout(r,25));}expect(status).toBe('failed');
 console.log(JSON.stringify({uploadedBytes:1024**3,baselineRSS:baseline,peakRSS:peak,deltaRSS:peak-baseline,restartStatus:status}));
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await rm(dir,{recursive:true,force:true});}
},60000);
