import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {prepareTestDB,kontoAnlegen} from '../server/hilfen.mjs';
import {createStudioServer} from '../../server/index.mjs';
import {ffmpeg} from '../../server/ffmpeg.mjs';
import {sourcePath} from '../../server/edits.mjs';
import {hashFile} from '../../server/storage.mjs';
const base=process.env.UI_BASE??'/',origin='http://127.0.0.1:5198',out=path.resolve('../Pruefungen/Planer-Editor-Live/Review-Editor-Frontend');
const dir=await mkdtemp('/tmp/pel-editor-');let app,vite,browser;let checks=0;const ok=(v,n)=>{assert(v,n);console.log('PASS '+(++checks)+' '+n);};
try{
 const link=await prepareTestDB(dir);app=await createStudioServer({dataDir:dir,base:base==='/'?'':base.slice(0,-1),cookieInsecure:true,origins:origin,asrEnv:{},llmEnv:{},archiveEnv:{}});await new Promise((r,j)=>{app.server.once('error',j);app.server.listen(8888,'127.0.0.1',r);});
 const req=async(method,p,b,cookie)=>fetch('http://127.0.0.1:8888'+base+'api'+p,{method,headers:{'Content-Type':'application/json','X-Studio':'1',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:b===undefined?undefined:JSON.stringify(b)});
 const auth=await kontoAnlegen(req,link.url.split('/').pop(),{displayName:'Synthetic Editor',password:'Synthetic-password-123!'}),cookie=auth.headers.get('set-cookie').split(';')[0],ctx=app.ctx,owner=ctx.db.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 ctx.db.put('projects',{id:'10000000-0000-0000-0000-000000000001',ownerId:owner,title:'Synthetic Project',createdAt:new Date().toISOString()});ctx.db.put('recordings',{id:'10000000-0000-0000-0000-000000000002',ownerId:owner,projectId:'10000000-0000-0000-0000-000000000001',title:'Synthetic recording'});
 const hashes=[];for(const kind of ['video','audio']){const t={id:kind==='video'?'10000000-0000-0000-0000-000000000003':'10000000-0000-0000-0000-000000000004',ownerId:owner,recordingId:'10000000-0000-0000-0000-000000000002',kind,mimeType:kind+'/mp4',status:'ready',durationMs:4000,width:160,height:90,local:true,participantName:kind};ctx.db.put('tracks',t);const file=sourcePath(ctx,t);await mkdir(path.dirname(file),{recursive:true});await ffmpeg(kind==='video'?['-f','lavfi','-i','testsrc2=s=160x90:r=30:d=4','-f','lavfi','-i','sine=frequency=660:duration=4','-c:v','libx264','-c:a','aac','-shortest',file]:['-f','lavfi','-i','sine=frequency=440:duration=4','-c:a','aac',file]);hashes.push([file,await hashFile(file)]);}
 process.env.API='http://127.0.0.1:8888';process.env.VITE_BASE=base;process.env.PORT='5198';vite=await createServer();await vite.listen();browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});const context=await browser.newContext();await context.addCookies([{name:cookie.split('=')[0],value:cookie.split('=')[1],url:origin}]);const page=await context.newPage(),errors=[];page.setDefaultTimeout(60000);page.on('console',m=>{if(m.type()==='error')console.log('BROWSER',m.text())});page.on('response',r=>{if(r.status()>=400)console.log('HTTP',r.status(),r.url())});page.on('pageerror',e=>errors.push(e.message));
 const project='10000000-0000-0000-0000-000000000001',track='10000000-0000-0000-0000-000000000004';
 const cut=await(await req('POST','/projects/'+project+'/edits',{title:'Independent review',kind:'audio'},cookie)).json();
 const url=origin+base+'bearbeiten/'+cut.id,draftKey='schnitt-draft:'+owner+':'+cut.id;
 const ready=()=>page.getByRole('heading',{name:'Independent review',exact:true}).waitFor();
 const saved=()=>page.waitForFunction(()=>document.querySelector('.schnitt-page [role=status]')?.textContent==='Gespeichert');
 const add=()=>page.getByRole('button',{name:/Synthetic recording · audio/}).click();
 const read=async()=> (await req('GET','/edits/'+cut.id,undefined,cookie)).json();
 if(process.env.REVIEW_VISUAL){await page.goto(url);await ready();await add();await saved();page.once('dialog',x=>x.accept('Renamed independently'));await page.getByRole('button',{name:'Umbenennen'}).click();await page.getByRole('heading',{name:'Renamed independently'}).waitFor();for(const width of [1280,390]){await page.setViewportSize({width,height:900});await page.keyboard.press('Escape');await page.waitForTimeout(800);await page.locator('.shell__main').evaluate(e=>e.scrollTop=0);await page.screenshot({path:path.join(out,'visual-final-'+(base==='/'?'root':'podcast')+'-'+width+'.png')});}console.log('LAYOUT',JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('.shell__main,.schnitt-page,.schnitt-list,.schnitt-player,.schnitt-toolbar')].map(e=>({class:e.className,width:e.clientWidth,scroll:e.scrollWidth})))));console.log('VISUAL COMPLETE');}else{
 await page.goto(url);await ready();
 for(const raw of ['{broken',JSON.stringify({edl:{v:1,clips:[{id:'evil',trackId:track,inMs:0,outMs:999999}]},revision:1})]){
 await page.evaluate(([k,v])=>sessionStorage.setItem(k,v),[draftKey,raw]);await page.reload();await ready();ok(await page.locator('.schnitt-select').count()===0,'malformed or out-of-range draft ignored');}
 // Delay an actual server save response while the user continues editing.
 let release,seen;const hit=new Promise(r=>seen=r),gate=new Promise(r=>release=r);let once=true;
 await page.route('**/api/edits/*/edl',async route=>{if(once){once=false;const response=await route.fetch();seen();await gate;await route.fulfill({response});}else await route.continue();});
 await add();await hit;await add();release();await saved();await page.waitForTimeout(1500);ok((await read()).edl.clips.length===2,'changes during in-flight save persisted with next revision');await page.unroute('**/api/edits/*/edl');
 // Hold revisions refresh after successful PUT beyond the next autosave timer.
 let revisionHit,revisionRelease;const rh=new Promise(r=>revisionHit=r),rg=new Promise(r=>revisionRelease=r);let holdRevision=true;
 await page.route('**/api/edits/*/revisions',async r=>{if(holdRevision){holdRevision=false;const response=await r.fetch();revisionHit();await rg;await r.fulfill({response});}else await r.continue();});
 await add();await rh;await add();await page.waitForTimeout(1300);revisionRelease();await page.waitForTimeout(1500);
 const raceState=await read(),uiCount=await page.locator('.schnitt-select').count();console.log('LATE_REVISION_REFRESH',JSON.stringify({server:raceState.edl.clips.length,ui:uiCount,status:await page.locator('.schnitt-page [role=status]').innerText()}));
 ok(raceState.edl.clips.length===uiCount&&uiCount===4,'autosave continues after delayed revisions refresh');
 for(const [file,sha] of hashes)ok(await hashFile(file)===sha,'original unchanged');ok(!errors.length,'no browser exceptions');console.log('AUTOSAVE FIX COMPLETE '+base);
}}finally{await browser?.close();await vite?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
