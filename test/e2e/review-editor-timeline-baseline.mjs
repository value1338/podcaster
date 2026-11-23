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
const base=process.env.UI_BASE??'/',origin='http://127.0.0.1:5199',out=path.resolve('../Pruefungen/Bearbeiten-Riverside-Paritaet/Review-Belege');
const dir=await mkdtemp('/tmp/pel-editor-');let app,vite,browser;let checks=0;const ok=(v,n)=>{assert(v,n);console.log('PASS '+(++checks)+' '+n);};
try{
 const link=await prepareTestDB(dir);app=await createStudioServer({dataDir:dir,base:base==='/'?'':base.slice(0,-1),cookieInsecure:true,origins:origin,asrEnv:{STUDIO_ASR_DRIVER:'fake'},llmEnv:{STUDIO_LLM_DRIVER:'fake',NODE_ENV:'test'},archiveEnv:{}});await new Promise((r,j)=>{app.server.once('error',j);app.server.listen(8889,'127.0.0.1',r);});
 const req=async(method,p,b,cookie)=>fetch('http://127.0.0.1:8889'+base+'api'+p,{method,headers:{'Content-Type':'application/json','X-Studio':'1',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:b===undefined?undefined:JSON.stringify(b)});
 const auth=await kontoAnlegen(req,link.url.split('/').pop(),{displayName:'Synthetic Editor',password:'Synthetic-password-123!'}),cookie=auth.headers.get('set-cookie').split(';')[0],ctx=app.ctx,owner=ctx.db.sql.prepare('SELECT id FROM users LIMIT 1').get().id;
 ctx.db.put('projects',{id:'10000000-0000-0000-0000-000000000001',ownerId:owner,title:'Synthetic Project',createdAt:new Date().toISOString()});ctx.db.put('recordings',{id:'10000000-0000-0000-0000-000000000002',ownerId:owner,projectId:'10000000-0000-0000-0000-000000000001',title:'Synthetic recording'});
 const hashes=[];for(const kind of ['video','audio']){const t={id:kind==='video'?'10000000-0000-0000-0000-000000000003':'10000000-0000-0000-0000-000000000004',ownerId:owner,recordingId:'10000000-0000-0000-0000-000000000002',kind,mimeType:kind+'/mp4',status:'ready',durationMs:4000,width:160,height:90,local:true,participantName:kind};ctx.db.put('tracks',t);const file=sourcePath(ctx,t);await mkdir(path.dirname(file),{recursive:true});await ffmpeg(kind==='video'?['-f','lavfi','-i','testsrc2=s=160x90:r=30:d=4','-f','lavfi','-i','sine=frequency=660:duration=4','-c:v','libx264','-c:a','aac','-shortest',file]:['-f','lavfi','-i','sine=frequency=440:duration=4','-c:a','aac',file]);hashes.push([file,await hashFile(file)]);}
 process.env.API='http://127.0.0.1:8889';process.env.VITE_BASE=base;process.env.PORT='5199';vite=await createServer();await vite.listen();browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});const context=await browser.newContext();await context.addCookies([{name:cookie.split('=')[0],value:cookie.split('=')[1],url:origin}]);const page=await context.newPage(),errors=[];page.setDefaultTimeout(60000);page.on('console',m=>{if(m.type()==='error')console.log('BROWSER',m.text())});page.on('response',r=>{if(r.status()>=400)console.log('HTTP',r.status(),r.url())});page.on('pageerror',e=>errors.push(e.message));
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
 ok((await read()).edl.clips.length===2,'two sources form one episode');
 await page.getByLabel('Abspielkopf in Schnittzeit').fill('3500');await page.getByRole('button',{name:'Abspielen',exact:true}).click();await page.waitForFunction(()=>Number(document.querySelector('input[aria-label="Abspielkopf in Schnittzeit"]').value)>4200,{},{timeout:15000});
 const across=Number(await page.getByLabel('Abspielkopf in Schnittzeit').inputValue());ok(across>4000&&across<6000,'continuous playback crosses clip boundary: '+across);await page.getByRole('button',{name:'Pause',exact:true}).click();
 // External timeline ruler seek must load the matching source time.
 await page.locator('.schnitt-ruler').click({position:{x:120,y:10}});await page.waitForTimeout(200);const seek=Number(await page.getByLabel('Abspielkopf in Schnittzeit').inputValue());ok(seek>0&&seek<4000,'ruler seeks episode preview');
 await page.getByLabel('Abspielkopf in Schnittzeit').fill('2000');await page.getByRole('button',{name:'Am Abspielkopf teilen',exact:true}).click();await saved();ok((await read()).edl.clips.length===3,'split at playhead');
 await page.locator('.schnitt-select').first().click();await page.getByLabel('In (Quellzeit in ms)').fill('200');await page.getByRole('button',{name:'Trim anwenden',exact:true}).click();await saved();ok((await read()).edl.clips[0].inMs===200,'numeric trim persists');

 const handle=page.getByRole('button',{name:'Clip 1 Ende ziehen'});await handle.hover();const box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2-20,box.y+box.height/2);await page.mouse.up();await page.waitForTimeout(1200);await saved();ok((await read()).edl.clips[0].outMs<2000,'pointer edge trim persists');
 const beforeMove=(await read()).edl;await page.locator('.schnitt-clip').first().dragTo(page.locator('.schnitt-clip').last());await saved();ok((await read()).edl.clips.at(-1).id===beforeMove.clips[0].id,'drag reorders EDL');
 await page.getByRole('button',{name:'Rückgängig',exact:true}).click();await saved();ok((await read()).edl.clips[0].id===beforeMove.clips[0].id,'undo restores drag');
 await page.getByLabel('Timeline-Zoom').fill('2');ok(await page.locator('.schnitt-track').evaluate(e=>e.clientWidth)>1000,'zoom changes timeline width');
 await page.locator('.schnitt-select').first().focus();await page.keyboard.press('Delete');await saved();ok((await read()).edl.clips.length===2,'keyboard delete');await page.keyboard.press('Control+z');await saved();ok((await read()).edl.clips.length===3,'keyboard undo');

 const beforeText=JSON.stringify((await read()).edl);
 await page.locator('.schnitt-transcript-text').evaluate(root=>{const words=root.querySelectorAll('[data-unit]'),range=document.createRange();range.setStart(words[0].firstChild,0);range.setEnd(words[1].firstChild,words[1].textContent.length);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);root.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
 await page.getByRole('button',{name:'Auswahl aus Episode entfernen'}).click();await saved();ok(JSON.stringify((await read()).edl)!==beforeText,'native text selection cuts media interval');await page.getByRole('button',{name:'Rückgängig',exact:true}).click();await saved();ok(JSON.stringify((await read()).edl)===beforeText,'undo restores exact EDL after text cut');await page.evaluate(()=>getSelection()?.removeAllRanges());
 await page.getByRole('button',{name:/Füllwörter/}).click();await page.getByRole('button',{name:/äh ·/}).first().click();const beforeCut=(await read()).durationMs;await page.getByRole('button',{name:'Auswahl aus Episode entfernen'}).click();await saved();ok((await read()).durationMs===beforeCut-300,'confirmed transcript word cut removes exactly 300ms');
 await page.getByRole('button',{name:/Pausen ab/}).click();ok(await page.getByRole('button',{name:/Pause ·/}).count()>0,'pause candidates from transcript gaps');await page.getByRole('button',{name:/Pausen ab/}).click();
 await page.getByLabel('Format',{exact:true}).selectOption('wav');await page.getByRole('button',{name:'Episode exportieren',exact:true}).click();await page.locator('.schnitt-render').getByRole('link',{name:'Herunterladen'}).waitFor({timeout:30000});
 const renders=await(await req('GET','/edits/'+cut.id+'/renders',undefined,cookie)).json(),r=renders[0],raw=ctx.db.sql.prepare('SELECT * FROM renders WHERE id=?').get(r.id),ff=await probe(renderPath(ctx,raw)),expected=(await read()).durationMs/1000;
 ok(r.status==='ready'&&Math.abs(Number(ff.format.duration)-expected)<0.05,'ffprobe single WAV duration '+ff.format.duration+' expected '+expected);console.log('FFPROBE',JSON.stringify(ff));
 ok(ff.streams.filter(s=>s.codec_type==='audio').length===1,'one continuous audio stream');
 const href=await page.locator('.schnitt-render').getByRole('link').getAttribute('href');ok(href.startsWith(base+'api/renders/'),'export download respects base');
 for(const width of [1280,390]){await page.setViewportSize({width,height:1100});await page.keyboard.press('Escape');await page.waitForTimeout(300);await page.locator('.shell__main').evaluate(e=>e.scrollTop=0);await page.screenshot({path:path.join(out,'editor-'+(base==='/'?'root':'podcast')+'-'+width+'.png'),fullPage:true});ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no document overflow '+width);await page.locator('.schnitt-timeline').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'timeline-'+(base==='/'?'root':'podcast')+'-'+width+'.png')});}

 const video=await(await req('POST','/projects/'+project+'/edits',{title:'Video episode',kind:'video'},cookie)).json();
 const ve={v:1,clips:[{id:'v1',trackId:'10000000-0000-0000-0000-000000000003',inMs:0,outMs:2000},{id:'v2',trackId:'10000000-0000-0000-0000-000000000003',inMs:2000,outMs:4000}]};await req('PUT','/edits/'+video.id+'/edl',{baseRevision:video.revision,edl:ve},cookie);
 await page.setViewportSize({width:1280,height:1100});await page.goto(origin+base+'bearbeiten/'+video.id);await page.getByRole('heading',{name:'Video episode',exact:true}).waitFor();
 await page.getByLabel('Abspielkopf in Schnittzeit').fill('1500');await page.getByRole('button',{name:'Abspielen',exact:true}).click();await page.waitForFunction(()=>Number(document.querySelector('input[aria-label="Abspielkopf in Schnittzeit"]').value)>2200,{},{timeout:15000});ok(await page.locator('video.schnitt-active').evaluate(e=>e.currentTime>2&&e.getBoundingClientRect().height>0),'visible video slot follows clip boundary');await page.getByRole('button',{name:'Pause',exact:true}).click();
 await page.getByLabel('Format',{exact:true}).selectOption('mp4');await page.getByRole('button',{name:'Episode exportieren',exact:true}).click();await page.locator('.schnitt-render').getByRole('link',{name:'Herunterladen'}).waitFor({timeout:30000});const vr=ctx.db.sql.prepare('SELECT * FROM renders WHERE edit_id=?').get(video.id),vp=await probe(renderPath(ctx,vr));ok(Math.abs(Number(vp.format.duration)-4)<0.05&&vp.streams.some(s=>s.codec_type==='video'),'two-clip MP4 render duration 4s');console.log('FFPROBE_VIDEO',JSON.stringify(vp));
 for(const [file,sha] of hashes)ok(await hashFile(file)===sha,'original media unchanged');ok(!errors.length,'no browser exceptions '+errors.join(','));console.log('COMPLETE '+checks+' '+base);
}finally{await browser?.close();await vite?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
