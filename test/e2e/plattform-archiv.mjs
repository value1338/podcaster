import {chromium} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {testServer} from '../server/hilfen.mjs';
const out=path.resolve('../Pruefungen/Plattform/PA10-Gesamt/archiv-ui');await mkdir(out,{recursive:true});
const mount=process.env.PA10_MOUNT;if(!mount)throw Error('real private mount required');
const id=randomUUID();await writeFile(mount+'/.podcast-studio-archiv.json',JSON.stringify({archiveId:id}),{flag:'wx'});
const s=await testServer({dist:'/tmp/pa10-podcast-build',base:'/podcast',archiveEnv:{STUDIO_ARCHIVE_DRIVER:'mount',STUDIO_ARCHIVE_PATH:mount,STUDIO_ARCHIVE_ID:id}});let browser;const results=[];
const check=(v,msg)=>{results.push({pass:!!v,msg});if(!v)throw Error(msg)};
try{
const origin='http://127.0.0.1:'+s.app.server.address().port;
// testServer origin must match real browser origin
s.app.ctx.auth.origins=[origin,'http://127.0.0.1:8871'];
const setup=await s.request('POST','/auth/token/'+s.link.url.split('/').at(-1),{password:'archive-test-password'});check(setup.ok,'setup');const cookie=setup.headers.get('set-cookie').split(';')[0],uid=(await setup.json()).user.id;
const p={id:randomUUID(),ownerId:uid,title:'PA10 Archiv UI',createdAt:new Date().toISOString()},r={id:randomUUID(),ownerId:uid,projectId:p.id,title:'Archivaufnahme',createdAt:p.createdAt},t={id:randomUUID(),ownerId:uid,recordingId:r.id,participantName:'Test',kind:'audio',mimeType:'audio/wav',status:'ready',local:true,durationMs:1000,receivedChunks:1,startedAtMs:0};
const dir=path.join(s.dir,'medien',p.id,r.id,t.id);await mkdir(dir,{recursive:true});execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440','-t','1',dir+'/original.wav']);const bytes=await readFile(dir+'/original.wav');t.bytes=bytes.length;t.sha256=createHash('sha256').update(bytes).digest('hex');for(const [table,row] of [['projects',p],['recordings',r],['tracks',t]])s.app.ctx.db.put(table,row);
s.app.ctx.db.sql.prepare('INSERT INTO settings VALUES (?,?,?,?)').run('archive.evictAfterDays','1',p.createdAt,uid);
browser=await chromium.launch();const c=await browser.newContext();await c.addCookies([{name:cookie.split('=')[0],value:cookie.split('=')[1],domain:'127.0.0.1',path:'/podcast/'}]);const page=await c.newPage();page.on('dialog',d=>d.accept());await page.goto(origin+'/podcast/projekte/'+p.id);
async function menu(label){await page.getByRole('button',{name:'Spurverwaltung'}).click();await page.getByRole('menuitem',{name:new RegExp(label)}).click();}
async function wait(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('state timeout')}
await menu('Archivieren');await wait(()=>s.app.ctx.db.get('tracks',t.id).archive?.status==='verified');await page.reload();await page.getByText(/Archivkopie geprüft/).waitFor();check(true,'ready mount UI archives with verified copy');
await menu('Auslagern');await wait(()=>s.app.ctx.db.get('tracks',t.id).local===false);await page.reload();await page.getByText('Im Archiv',{exact:true}).waitFor();await page.screenshot({path:out+'/archiv-1280.png'});await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/archiv-390.png'});
await page.getByRole('button',{name:'Zurückholen',exact:true}).click();await wait(()=>s.app.ctx.db.get('tracks',t.id).local===true);check((await readFile(dir+'/original.wav')).equals(bytes),'restored bytes identical');
console.log(results);
}finally{await browser?.close();await s.close();await writeFile(out+'/results.json',JSON.stringify(results,null,2));}
