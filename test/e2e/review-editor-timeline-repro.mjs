import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {prepareTestDB,kontoAnlegen} from '../server/hilfen.mjs';
import {createStudioServer} from '../../server/index.mjs';
import {ffmpeg} from '../../server/ffmpeg.mjs';
import {sourcePath} from '../../server/edits.mjs';
import {probe} from '../../server/ffmpeg.mjs';
import {renderPath} from '../../server/render.mjs';
import {hashFile} from '../../server/storage.mjs';
const base=process.env.UI_BASE??'/',origin='http://127.0.0.1:5200',out=path.resolve('../Pruefungen/Bearbeiten-Riverside-Paritaet/Review-Belege');
const dir=await mkdtemp('/tmp/pel-editor-');let app,vite,browser;let checks=0;const ok=(v,n)=>{assert(v,n);console.log('PASS '+(++checks)+' '+n);};
try{
 const link=await prepareTestDB(dir);app=await createStudioServer({dataDir:dir,base:base==='/'?'':base.slice(0,-1),cookieInsecure:true,origins:origin,asrEnv:{STUDIO_ASR_DRIVER:'fake'},llmEnv:{STUDIO_LLM_DRIVER:'fake',NODE_ENV:'test'},archiveEnv:{}});await new Promise((r,j)=>{app.server.once('error',j);app.server.listen(8890,'127.0.0.1',r);});
 const req=async(method,p,b,cookie)=>fetch('http://127.0.0.1:8890'+base+'api'+p,{method,headers:{'Content-Type':'application/json','X-Studio':'1',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:b===undefined?undefined:JSON.stringify(b)});
 const auth=await kontoAnlegen(req,link.url.split('/').pop(),{displayName:'Synthetic Editor',password:'Synthetic-password-123!'}),cookie=auth.headers.get('set-cookie').split(';')[0],ctx=app.ctx,owner=ctx.db.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 ctx.db.put('projects',{id:'10000000-0000-0000-0000-000000000001',ownerId:owner,title:'Synthetic Project',createdAt:new Date().toISOString()});ctx.db.put('recordings',{id:'10000000-0000-0000-0000-000000000002',ownerId:owner,projectId:'10000000-0000-0000-0000-000000000001',title:'Synthetic recording'});
 const hashes=[];for(const kind of ['video','audio']){const t={id:kind==='video'?'10000000-0000-0000-0000-000000000003':'10000000-0000-0000-0000-000000000004',ownerId:owner,recordingId:'10000000-0000-0000-0000-000000000002',kind,mimeType:kind+'/mp4',status:'ready',durationMs:4000,width:160,height:90,local:true,participantName:kind};ctx.db.put('tracks',t);const file=sourcePath(ctx,t);await mkdir(path.dirname(file),{recursive:true});await ffmpeg(kind==='video'?['-f','lavfi','-i','testsrc2=s=160x90:r=30:d=4','-f','lavfi','-i','sine=frequency=660:duration=4','-c:v','libx264','-c:a','aac','-shortest',file]:['-f','lavfi','-i','sine=frequency=440:duration=4','-c:a','aac',file]);hashes.push([file,await hashFile(file)]);}
 process.env.API='http://127.0.0.1:8890';process.env.VITE_BASE=base;process.env.PORT='5200';vite=await createServer();await vite.listen();browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});const context=await browser.newContext();await context.addCookies([{name:cookie.split('=')[0],value:cookie.split('=')[1],url:origin}]);const page=await context.newPage(),errors=[];page.setDefaultTimeout(60000);page.on('console',m=>{if(m.type()==='error')console.log('BROWSER',m.text())});page.on('response',r=>{if(r.status()>=400)console.log('HTTP',r.status(),r.url())});page.on('pageerror',e=>errors.push(e.message));
 const project='10000000-0000-0000-0000-000000000001',track='10000000-0000-0000-0000-000000000004';
 const cut=await(await req('POST','/projects/'+project+'/edits',{title:'Independent review',kind:'audio'},cookie)).json();
 const url=origin+base+'bearbeiten/'+cut.id,draftKey='schnitt-draft:'+owner+':'+cut.id;

 const saved=()=>page.waitForFunction(()=>document.querySelector('.schnitt-page [role=status]')?.textContent==='Gespeichert');
 const read=async()=> (await req('GET','/edits/'+cut.id,undefined,cookie)).json();
 // Synthetic word timing fixture, read through the actual transcript endpoint.
 const segments=[{id:'s1',startMs:0,endMs:4000,text:'Hallo äh zusammen Ende',words:[{text:'Hallo',startMs:0,endMs:800},{text:'äh',startMs:900,endMs:1200},{text:'zusammen',startMs:2400,endMs:3000},{text:'Ende',startMs:3100,endMs:4000}],speaker:null,edited:false}];
 const asr=await req('POST','/tracks/'+track+'/transcription',{},cookie);ok(asr.ok,'fake ASR job accepted');
 let transcript;for(let i=0;i<100;i++){const response=await req('GET','/tracks/'+track+'/transcript',undefined,cookie);if(response.ok){transcript=await response.json();break;}await new Promise(r=>setTimeout(r,100));}assert(transcript);
 ctx.db.sql.prepare("UPDATE transcripts SET timestamps='word',segments=?,machine=? WHERE id=?").run(JSON.stringify(segments),JSON.stringify(segments),transcript.id);
 await page.goto(url);await page.getByRole('heading',{name:'Independent review',exact:true}).waitFor();
 const add=()=>page.getByRole('button',{name:/Synthetic recording · audio/}).click();
 await page.locator('.schnitt-source-panel summary').click();await add();await add();await saved();

 // A focused transcript word should never invoke the selected timeline clip's Delete action.
 await page.locator('.schnitt-select').first().click();
 await page.locator('[data-unit]').first().click();
 const initial=(await read()).edl.clips.length;
 await page.keyboard.press('Delete');await page.waitForTimeout(1200);await saved();
 const afterDelete=(await read()).edl.clips.length;
 ok(afterDelete===initial,'FIX W1: Delete on transcript word leaves clips untouched');
 // Native button Space activation is prevented by the global player shortcut.
 await page.locator('.schnitt-select').first().click();
 await page.getByRole('button',{name:'Ausgewählten Clip löschen',exact:true}).focus();
 await page.keyboard.press('Space');await page.waitForTimeout(150);
 await saved();ok(await page.getByRole('button',{name:'Pause',exact:true}).count()===0&& (await read()).edl.clips.length===initial-1,'FIX W3: Space activates the focused button natively, player stays paused');
 await page.getByRole('button',{name:'Rückgängig',exact:true}).click();await saved();
 // A range prelisten control should at least start playback.
 await page.locator('[data-unit]').first().click();
 ok(await page.getByRole('button',{name:'Zum Auswahlbeginn springen',exact:true}).count()===1,'FIX H1: seek-only control is labelled honestly');
 // Concurrent keyboard removal during a pointer trim is silently overwritten by the stale gesture.
 await page.locator('.schnitt-select').last().click();
 const handle=page.getByRole('button',{name:'Clip 1 Ende ziehen'});await handle.hover();const box=await handle.boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2-10,box.y+box.height/2);
 await page.keyboard.press('Delete');await page.waitForTimeout(1200);await saved();
 ok((await read()).edl.clips.length===initial-1,'keyboard edit accepted during pointer gesture');
 await page.mouse.up();await page.waitForTimeout(1200);await saved();
 ok((await read()).edl.clips.length===initial-1,'FIX W2: pointer-up does not restore the clip deleted during the gesture');
 console.log('REPRO COMPLETE '+checks+' '+base);
}finally{await browser?.close();await vite?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
