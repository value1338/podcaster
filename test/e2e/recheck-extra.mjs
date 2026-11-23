import {chromium} from '@playwright/test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import net from 'node:net';
const out='../Pruefungen/Recheck-F1-F2',base='http://127.0.0.1:8865/podcast',results=[];
const ok=(b,m)=>{results.push({pass:!!b,msg:m});console.log(b?'OK':'FAIL',m);if(!b)throw Error(m)};
await new Promise((res,rej)=>{const s=net.createServer();s.on('error',rej);s.listen(8865,'127.0.0.1',()=>s.close(res))});
const tmp=mkdtempSync(out+'/temp-extra-');
const {createStudioServer}=await import('../../server/index.mjs');
const own=await createStudioServer({dataDir:tmp,base:'/podcast'});
await new Promise(r=>own.server.listen(8865,'127.0.0.1',r));
let b;
try{
b=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const c=await b.newContext({permissions:['microphone'],acceptDownloads:true});
let p=await c.newPage();
await p.goto(base+'/studio');await p.getByLabel('Neues Projekt').fill('Recheck Extra');
await p.getByRole('button',{name:'Anlegen & aufnehmen'}).click();
await p.getByRole('heading',{name:'Bereit zur Aufnahme'}).waitFor();
const pid=p.url().split('/').at(-1);
const start=async title=>{await p.getByRole('heading',{name:'Bereit zur Aufnahme'}).waitFor();await p.getByLabel('Titel der Aufnahme').fill(title);await p.getByRole('button',{name:'Aufnahme starten',exact:true}).click();await p.getByRole('heading',{name:'Aufnahme läuft'}).waitFor()};
await start('NurTitelSuchwortZirbel');
await p.waitForTimeout(5500);await p.getByRole('button',{name:'Aufnahme beenden'}).click();
await p.getByRole('heading',{name:'Aufnahme gesichert'}).waitFor({timeout:30000});
await p.goto(base+'/projekte/'+pid);await p.locator('audio').waitFor();
for(const fmt of ['MP3','WAV']){
 await p.getByRole('button',{name:'Herunterladen',exact:true}).first().click();
 await p.getByRole('menuitem',{name:new RegExp('^'+fmt)}).click();
 for(let i=0;i<80;i++){await p.waitForTimeout(250);await p.getByRole('button',{name:'Herunterladen',exact:true}).first().click();if((await p.getByRole('menuitem',{name:new RegExp('^'+fmt)}).innerText()).includes('Bereit'))break;await p.keyboard.press('Escape')}
 const [d]=await Promise.all([p.waitForEvent('download'),p.getByRole('menuitem',{name:new RegExp('^'+fmt)}).click()]);
 await d.saveAs(tmp+'/'+fmt);execFileSync('ffmpeg',['-v','error','-i',tmp+'/'+fmt,'-f','null','-']);ok(true,fmt+' UI-Download vollständig dekodiert');
}
await p.goto(base+'/projekte');const input=p.getByRole('searchbox');await input.fill('NurTitelSuchwortZirbel');await p.waitForTimeout(500);
ok((await p.locator('body').innerText()).includes('Recheck Extra'),'F3: ausschließlich Aufnahmetitel findet Projekt in UI');
await p.goto(base+'/studio/'+pid);
await start('Recovery Status Frist');
await c.setOffline(true);await p.waitForTimeout(9000);await p.close({runBeforeUnload:false});await c.setOffline(false);
p=await c.newPage();await p.goto(base+'/studio/'+pid);
const w=p.getByRole('region',{name:'Wiederherstellung'});await w.waitFor();
let first=true,failed=false,retry=0;
p.on('requestfailed',r=>{if(/\/api\/tracks\/[^/]+$/.test(r.url()))failed=true});
await p.route('**/api/tracks/*',async r=>{if(first){first=false;return}retry++;await r.continue()});
const count=()=>p.evaluate(()=>new Promise((res,rej)=>{const r=indexedDB.open('podcast-studio-aufnahme');r.onsuccess=()=>{const db=r.result,q=db.transaction('chunks').objectStore('chunks').count();q.onsuccess=()=>{res(q.result);db.close()};q.onerror=rej};r.onerror=rej}));
const n=await count();ok(n>0,'Recovery: echte IDB-Abschnitte vorhanden');
const t=Date.now();await w.getByRole('button',{name:'Hochladen & abschließen'}).click();await p.waitForTimeout(18000);ok(await count()===n,'Recovery: lokale Daten während Statushang unverändert');
await w.getByText('Unterbrochene Aufnahme übertragen').waitFor({timeout:20000});
ok(failed&&retry>0&&Date.now()-t>=20000,'Recovery: 20s echter Browserabort + Retry');
await p.screenshot({path:out+'/status-recovery.png'});
await c.close();
// Fragment: Abschnitt 0 online hochladen, dann Quota und offline.
const q=await b.newContext({permissions:['microphone'],acceptDownloads:true});
await q.addInitScript(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...a){if(this.name==='chunks'&&window.quotaNow)throw new DOMException('test','QuotaExceededError');return put.apply(this,a)}});
p=await q.newPage();await p.goto(base+'/studio/'+pid);await start('Fragment');
await p.waitForTimeout(5500);await p.evaluate(()=>window.quotaNow=true);await q.setOffline(true);
await p.getByRole('heading',{name:'Aufnahme wird gesichert'}).waitFor({timeout:9000});await p.waitForTimeout(1000);
const [d]=await Promise.all([p.waitForEvent('download'),p.getByRole('button',{name:'Notfalldatei speichern'}).click()]);
await d.saveAs(tmp+'/fragment.webm');execFileSync('ffmpeg',['-v','error','-i',tmp+'/fragment.webm','-f','null','-']);
const text=await p.locator('body').innerText();ok(/mit Dateikopf aus Abschnitt 0/.test(text)&&/davor hat der Server bereits bestätigt/.test(text),'Fragmentwarnung unterscheidet Download von vollständiger Aufnahme');
results.push({fragmentText:text});await p.screenshot({path:out+'/fragment.png'});
await q.setOffline(false);await p.getByRole('heading',{name:'Aufnahme gesichert'}).waitFor({timeout:30000});await q.close();
console.log('EXTRA DONE');
}finally{writeFileSync(out+'/extra-results.json',JSON.stringify(results,null,2));await b?.close();own.server.closeAllConnections?.();await own.close();rmSync(tmp,{recursive:true,force:true})}
