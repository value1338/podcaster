// Own synthetic browser E2E. No manual viewer-cookie injection, no auth dumps.
import {chromium,firefox} from '@playwright/test';
import {mkdtemp,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {prepareTestDB,kontoAnlegen,anmelden} from '../server/hilfen.mjs';
import {createStudioServer} from '../../server/index.mjs';
const out=process.env.LIVE_EVIDENCE;const dir=await mkdtemp(path.join(tmpdir(),'ul-live-'));let app,browser,vite;const results=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));const origin='http://127.0.0.1:5197';
async function until(fn,timeout=25000){const t=Date.now();while(Date.now()-t<timeout){if(await fn())return;await wait(500);}throw Error('Timed out');}
try{
 const setup=await prepareTestDB(dir);app=await createStudioServer({dataDir:dir,origins:origin,cookieInsecure:true});await new Promise((ok,no)=>{app.server.once('error',no);app.server.listen(8887,'127.0.0.1',ok);});
 const req=(method,p,b,cookie)=>fetch('http://127.0.0.1:8887/api'+p,{method,headers:{'X-Studio':'1',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:b===undefined?undefined:JSON.stringify(b)});
 await kontoAnlegen(req,setup.url.split('/').at(-1),{password:'Testpassword-1234'});const owner=await anmelden(req,'test-owner@example.test','Testpassword-1234');
 vite=spawn(process.execPath,['node_modules/vite/bin/vite.js'],{env:{...process.env,PORT:'5197',API:'http://127.0.0.1:8887'},stdio:'ignore'});await until(async()=>fetch(origin).then(r=>r.ok).catch(()=>false));
 browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const hostContext=await browser.newContext();await hostContext.addCookies([{name:'ps_sitzung',value:owner.slice(11),url:origin}]);const host=await hostContext.newPage();await host.goto(origin+'/');await host.getByRole('link',{name:/Live-Stream/}).click();
 await host.getByLabel('Öffentlicher Titel').fill('Eigener synthetischer Live-Test');await host.getByRole('button',{name:'Zuschauerlink erstellen'}).click();const link=await host.getByLabel('Einmaliger Zuschauerlink').inputValue();const fragment=new URL(link).hash;
 const contexts=[await browser.newContext(),await browser.newContext()];const pages=await Promise.all(contexts.map(c=>c.newPage()));
 await pages[0].goto(origin+'/zuschauen'+fragment);await pages[0].getByText('Die Sendung hat noch nicht begonnen.',{exact:true}).waitFor();assert.equal(new URL(pages[0].url()).hash,'');assert.equal((await contexts[0].cookies()).find(c=>c.name==='ps_zuschauer')?.secure,true);results.push('real Chromium loopback Secure viewer cookie accepted by browser; fragment removed; created has no video');
 await host.getByRole('button',{name:'Vorschau vorbereiten'}).click();await host.getByText('Kamera und Mikrofon bereit.',{exact:true}).waitFor();await host.getByRole('button',{name:'Live starten',exact:true}).click();
 let prompts=0;const dismiss=async d=>{prompts++;await d.dismiss();};host.on('dialog',dismiss);
 await host.evaluate(()=>{window.testTracks=document.querySelector('video').srcObject.getTracks();});
 await host.goBack();await wait(500);assert.equal(prompts,1);assert.equal(new URL(host.url()).pathname,'/live-stream');assert((await host.evaluate(()=>window.testTracks.every(t=>t.readyState==='live'))));
 host.off('dialog',dismiss);host.once('dialog',d=>d.accept());await host.goBack();await wait(500);assert.equal(new URL(host.url()).pathname,'/');assert((await host.evaluate(()=>window.testTracks.every(t=>t.readyState==='ended'))));
 console.log('PASS router back canceled keeps sending; accepted releases camera/mic');
}finally{if(out)await writeFile(path.join(out,'browser-results.json'),JSON.stringify(results,null,2));await browser?.close();if(vite){vite.kill('SIGTERM');await new Promise(r=>vite.once('exit',r));}await app?.close();await rm(dir,{recursive:true,force:true});}
