import {test,expect,vi} from 'vitest';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareTestDB,kontoAnlegen,anmelden} from './hilfen.mjs';
import {createStudioServer} from '../../server/index.mjs';
import {hashToken} from '../../server/auth.mjs';
const origin='http://127.0.0.1:8884';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('L2–L6/L8: echte HTTP Auth, Begrenzung, fMP4, Widerruf und Recovery',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'pel-live-'));let app;const logs=[];const spies=['log','warn','error'].map(k=>vi.spyOn(console,k).mockImplementation((...a)=>logs.push(a.join(' '))));
 try{
 const link=await prepareTestDB(dir);app=await createStudioServer({dataDir:dir,origins:origin,cookieInsecure:true,base:'/podcast'});app.server.keepAliveTimeout=120000; // idle gaps (spawnSync, waits) exceed Node's 5 s keep-alive; undici would reuse a just-closed socket -> ECONNRESET

 await new Promise((ok,no)=>{app.server.once('error',no);app.server.listen(8884,'127.0.0.1',ok);});
 const request=(method,p,b,cookie)=>fetch(origin+'/podcast/api'+p,{method,headers:{'X-Studio':'1',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:b===undefined?undefined:b instanceof Uint8Array?b:JSON.stringify(b)}).catch(e=>{throw Error(method+' '+p+': '+(e.cause?.code??e.message));});
 await kontoAnlegen(request,link.url.split('/').at(-1),{password:'Testpassword-1234',name:'Owner'});
 const a=await anmelden(request,'test-owner@example.test','Testpassword-1234');
 // A second genuine account, using the existing invitation endpoint.
 const second=await (await request('POST','/admin/invites',{email:'second@example.test',planId:'pro'},a)).json();
 await kontoAnlegen(request,second.url.split('/').at(-1),{password:'Testpassword-1234',displayName:'Second',email:'second@example.test'});
 const b=await anmelden(request,'second@example.test','Testpassword-1234');
 const made=await request('POST','/live',{publicTitle:'Öffentliche Sendung'},a);expect(made.status).toBe(201);const {live,link:viewerLink}=await made.json();const id=live.id,token=viewerLink.url.split('#t=')[1];
 expect(JSON.stringify(app.ctx.db.sql.prepare('SELECT * FROM live_sessions').all())).not.toContain(token);expect(JSON.stringify(app.ctx.db.sql.prepare('SELECT * FROM live_sessions').all())).not.toContain('ps_zuschauer');
 expect(app.ctx.db.sql.prepare('SELECT token_hash FROM live_sessions WHERE id=?').get(id).token_hash).toBe(hashToken(token));
 expect((await request('GET','/live/'+id,undefined,b)).status).toBe(404);
 expect((await request('GET','/watch/state',undefined,a)).status).toBe(404);
 const enter=await request('POST','/watch/enter',{token});expect(enter.status).toBe(204);const set=enter.headers.get('set-cookie');expect(set).toContain('Secure; SameSite=Strict; Path=/podcast/api/watch/');const wc=set.split(';')[0];
 expect((await request('GET','/live',undefined,wc)).status).toBe(401);
 expect(Object.keys(await (await request('GET','/watch/state',undefined,wc)).json()).sort()).toEqual(['epoch','publicTitle','startedAt','status']);
 for(let i=0;i<9;i++)expect((await request('POST','/watch/enter',{token})).status).toBe(204);
 expect((await request('POST','/watch/enter',{token})).status).toBe(429);
 const src=path.join(dir,'source.webm');const gen=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','10','-c:v','libvpx','-deadline','realtime','-cpu-used','8','-b:v','1500k','-c:a','libopus',src]);expect(gen.status).toBe(0);
 const start=await request('POST',`/live/${id}/start`,{mimeType:'video/webm;codecs=vp8,opus'},a);expect(start.status).toBe(200);const {epoch}=await start.json();expect(app.ctx.live.active()).toBe(true);
 const made2=await (await request('POST','/live',{publicTitle:'B'},b)).json();expect((await request('POST',`/live/${made2.live.id}/start`,{mimeType:'video/webm'},b)).status).toBe(409);
 expect((await request('PUT',`/live/${id}/ingest/${epoch}/2`,new Uint8Array([1]),a)).status).toBe(409);
 expect((await request('PUT',`/live/${id}/ingest/${epoch}/0`,new Uint8Array(4194305),a)).status).toBe(413);
 const bytes=await readFile(src);let seq=0;for(let i=0;i<bytes.length;i+=100000){const chunk=bytes.subarray(i,i+100000);expect((await request('PUT',`/live/${id}/ingest/${epoch}/${seq}`,chunk,a)).status).toBe(204);expect((await request('PUT',`/live/${id}/ingest/${epoch}/${seq}`,chunk,a)).status).toBe(204);seq++;}
 const d=path.join(dir,'live',id,String(epoch));let playlist;for(let i=0;i<100;i++){playlist=await readFile(path.join(d,'index.m3u8'),'utf8').catch(()=>null);if(playlist?.includes('.m4s'))break;await wait(100);}expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
 const files=await readdir(d);const seg=files.find(f=>/^seg-\d+\.m4s$/.test(f));const joined=path.join(dir,'probe.mp4');await writeFile(joined,Buffer.concat([await readFile(path.join(d,'init.mp4')),await readFile(path.join(d,seg))]));const probe=spawnSync('ffprobe',['-v','error','-show_streams','-of','json',joined],{encoding:'utf8'});const streams=JSON.parse(probe.stdout).streams;expect(streams.map(s=>s.codec_name)).toEqual(['h264','aac']);expect(streams[0].profile).toBe('Main');expect(streams[0].height).toBe(720);
 const pidFile=readFile; // cmdline must never contain credentials
 const {execFileSync}=await import('node:child_process');const pids=execFileSync('pgrep',['-P',String(process.pid),'ffmpeg'],{encoding:'utf8'}).trim().split('\n');for(const pid of pids){const cmd=await pidFile('/proc/'+pid+'/cmdline','utf8');expect(cmd).not.toContain(token);expect(cmd).not.toContain(wc.split('=')[1]);}
 expect((await request('GET',`/watch/hls/${epoch+1}/index.m3u8`,undefined,wc)).status).toBe(404);
 expect((await request('GET',`/watch/hls/${epoch}/source.webm`,undefined,wc)).status).toBe(404);
 expect((await request('HEAD',`/watch/hls/${epoch}/init.mp4`,undefined,wc)).status).toBe(200);
 const rates=[];for(let i=0;i<12;i++)rates.push((await request('GET','/watch/state',undefined,wc)).status);expect(rates).toContain(429);
 expect((await request('DELETE',`/live/${id}/link`,undefined,a)).status).toBe(204);
 expect((await request('GET',`/watch/hls/${epoch}/init.mp4`,undefined,wc)).status).toBe(404);
 const invalid=await (await request('POST','/watch/enter',{token:'invalid'})).text();expect(await (await request('POST','/watch/enter',{token})).text()).toBe(invalid);
 for(const pid of pids)process.kill(Number(pid),'SIGKILL');for(let i=0;i<50&&app.ctx.live.active();i++)await wait(100);expect(app.ctx.live.active()).toBe(false);expect((await (await request('GET','/live/'+id,undefined,a)).json()).status).toBe('interrupted');
 expect((await request('POST',`/live/${id}/start`,{mimeType:'video/webm'},a)).status).toBe(200);
 const keep=path.join(dir,'live',id,String(epoch+1),'foreign.txt');await writeFile(keep,'preserve');
 expect((await request('POST',`/live/${id}/stop`,undefined,a)).status).toBe(200);expect(app.ctx.live.active()).toBe(false);expect(await readFile(keep,'utf8')).toBe('preserve');
 const third=await (await request('POST','/live',{publicTitle:'disconnect'},a)).json();const thirdId=third.live.id;const thirdStart=await (await request('POST',`/live/${thirdId}/start`,{mimeType:'video/webm'},a)).json();
 const {request:rawRequest}=await import('node:http');await new Promise(resolve=>{const q=rawRequest(origin+`/podcast/api/live/${thirdId}/ingest/${thirdStart.epoch}/0`,{method:'PUT',headers:{'X-Studio':'1',Origin:origin,Cookie:a,'Content-Length':'100'}},r=>{r.resume();r.on('end',resolve);});q.on('error',resolve);q.write(Buffer.from([1]));});
 expect((await (await request('GET',`/live/${thirdId}`,undefined,a)).json()).status).toBe('interrupted');
 const realNow=Date.now;const clock=vi.spyOn(Date,'now').mockImplementation(()=>realNow()+121000);try{await wait(1200);expect((await (await request('GET',`/live/${thirdId}`,undefined,a)).json()).endReason).toBe('timeout');}finally{clock.mockRestore();}
 app.ctx.live.recover();expect(app.ctx.db.sql.prepare('SELECT end_reason FROM live_sessions WHERE id=?').get(made2.live.id).end_reason).toBe('server_restart');
 expect(logs.join(' ')).not.toContain(token);expect(logs.join(' ')).not.toContain(wc.split('=')[1]);
 const fourth=await (await request('POST','/live',{publicTitle:'close active'},b)).json();expect((await request('POST',`/live/${fourth.live.id}/start`,{mimeType:'video/webm'},b)).status).toBe(200);const finalPid=execFileSync('pgrep',['-P',String(process.pid),'ffmpeg'],{encoding:'utf8'}).trim();await app.close();app=null;expect(()=>process.kill(Number(finalPid),0)).toThrow();
 }finally{spies.forEach(s=>s.mockRestore());if(app)await app.close();await rm(dir,{recursive:true,force:true});}
},60000);

test('Browser-MediaRecorder HTTP-1s-Stücke werden vor Aufnahmeende als AV-fMP4 lesbar',async()=>{
 const {chromium}=await import('@playwright/test');const {streamBrowser}=await import('../fixtures/pel/live/browser.mjs');
 const dir=await mkdtemp(path.join(tmpdir(),'pel-browser-live-'));let app,browser;
 try{
 await writeFile(path.join(dir,'index.html'),'<!doctype html><title>Live test fixture</title>');
 const setup=await prepareTestDB(dir);app=await createStudioServer({dataDir:dir,dist:dir,origins:origin,cookieInsecure:true});
 await new Promise((ok,no)=>{app.server.once('error',no);app.server.listen(8884,'127.0.0.1',ok);});
 const request=(method,p,b,cookie)=>fetch(origin+'/api'+p,{method,headers:{'X-Studio':'1',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:b===undefined?undefined:JSON.stringify(b)});
 await kontoAnlegen(request,setup.url.split('/').at(-1),{password:'Testpassword-1234'});const owner=await anmelden(request,'test-owner@example.test','Testpassword-1234');
 const created=await (await request('POST','/live',{publicTitle:'Browser fixture'},owner)).json(),id=created.live.id;
 const {epoch}=await (await request('POST',`/live/${id}/start`,{mimeType:'video/webm;codecs=vp8,opus'},owner)).json();
 browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});const context=await browser.newContext();await context.addCookies([{name:'ps_sitzung',value:owner.slice(11),url:origin}]);const page=await context.newPage();await page.goto(origin);
 const {execFileSync}=await import('node:child_process');const ffpid=execFileSync('pgrep',['-P',String(process.pid),'ffmpeg'],{encoding:'utf8'}).trim();const ticks=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));const cpu=async()=>{const a=(await readFile('/proc/'+ffpid+'/stat','utf8')).split(') ')[1].split(' ');return Number(a[11])+Number(a[12]);};const cpuBefore=await cpu();const rssBefore=process.memoryUsage().rss;const started=Date.now();let firstSegmentMs=null;const d=path.join(dir,'live',id,String(epoch));
 const recording=streamBrowser(page,{base:'',id,epoch,seconds:24});
 const poll=setInterval(async()=>{const files=await readdir(d).catch(()=>[]);if(firstSegmentMs===null&&files.some(f=>/^seg-\d+\.m4s$/.test(f)))firstSegmentMs=Date.now()-started;},100);
 let result;try{result=await recording;}finally{clearInterval(poll);}
 expect(result.chunks.length).toBeGreaterThan(15);expect(firstSegmentMs).not.toBeNull();expect(firstSegmentMs).toBeLessThan(10000);
 const playlist=await readFile(path.join(d,'index.m3u8'),'utf8');const segments=playlist.match(/seg-\d+\.m4s/g);expect(segments.length).toBeLessThanOrEqual(6);expect(segments.length).toBeGreaterThanOrEqual(3);
 const joined=path.join(dir,'probe.mp4');await writeFile(joined,Buffer.concat([await readFile(path.join(d,'init.mp4')),await readFile(path.join(d,segments.at(-1)))]));
 const probe=JSON.parse(spawnSync('ffprobe',['-v','error','-show_streams','-of','json',joined],{encoding:'utf8'}).stdout).streams;
 expect(probe.map(s=>s.codec_name)).toEqual(['h264','aac']);expect(probe[0].height).toBe(720);expect(probe[0].r_frame_rate).toBe('30/1');
 const {stat}=await import('node:fs/promises');let diskBytes=0;for(const f of await readdir(d))diskBytes+=(await stat(path.join(d,f))).size;const measurement={cpuPercent:100*(await cpu()-cpuBefore)/ticks/((Date.now()-started)/1000),rssBefore,rssAfter:process.memoryUsage().rss,diskBytes,firstSegmentMs,chunks:result.chunks.length,maxUploadMs:Math.max(...result.chunks.map(c=>c.uploadMs)),playlist,streams:probe.map(s=>({codec:s.codec_name,profile:s.profile,level:s.level,width:s.width,height:s.height,rate:s.r_frame_rate})),health:(await (await request('GET',`/live/${id}`,undefined,owner)).json()).health};
 console.log('BROWSER_LIVE_EVIDENCE '+JSON.stringify(measurement));
 // No incoming chunks: interrupt after 20s, then new epoch and explicit stop.
 await wait(21500);expect((await (await request('GET',`/live/${id}`,undefined,owner)).json()).status).toBe('interrupted');
 const resumed=await (await request('POST',`/live/${id}/start`,{mimeType:'video/webm'},owner)).json();expect(resumed.epoch).toBe(epoch+1);
 app.ctx.db.sql.prepare('UPDATE live_sessions SET started_at=? WHERE id=?').run(new Date(Date.now()-241*60000).toISOString(),id);await wait(1200);expect((await (await request('GET',`/live/${id}`,undefined,owner)).json()).endReason).toBe('time_limit');expect(app.ctx.live.active()).toBe(false);
 }finally{if(browser)await browser.close();if(app)await app.close();await rm(dir,{recursive:true,force:true});}
},90000);
