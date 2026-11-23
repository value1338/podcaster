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

const c=await b.newContext({permissions:['microphone']});
await c.addInitScript(()=>{
 const put=IDBObjectStore.prototype.put,get=IDBObjectStore.prototype.get;
 IDBObjectStore.prototype.put=function(...a){if(this.name==='chunks'&&window.failNow)throw new DOMException('quota','QuotaExceededError');return put.apply(this,a)};
 IDBObjectStore.prototype.get=function(...a){if(this.name==='meta'&&window.failNow)return {};return get.apply(this,a)};
});
let p=await c.newPage();await p.goto(base+'/studio');await p.getByLabel('Neues Projekt').fill('Markerfenster');
await p.getByRole('button',{name:'Anlegen & aufnehmen'}).click();await p.getByRole('heading',{name:'Bereit zur Aufnahme'}).waitFor();
const pid=p.url().split('/').at(-1);
await p.getByRole('button',{name:'Aufnahme starten',exact:true}).click();await p.getByRole('heading',{name:'Aufnahme läuft'}).waitFor();
await p.waitForTimeout(5500);await p.evaluate(()=>window.failNow=true);await c.setOffline(true);
await p.getByRole('heading',{name:'Aufnahme wird gesichert'}).waitFor({timeout:9000});
await p.getByRole('button',{name:'Notfalldatei speichern'}).click();
const text=await p.locator('body').innerText();
ok(/nur im Arbeitsspeicher/.test(text)&&/Gerade ist nichts offen – alle Abschnitte sind vom Server bestätigt/.test(text),'BUG: RAM-only vorhanden, Notfallknopf behauptet dennoch alles bestätigt während Marker-IDB hängt');
ok(await p.evaluate(()=>Object.keys(localStorage).every(k=>!k.startsWith('podcast-studio:nicht-lokal:'))),'BUG: kein localStorage-Fehlvermerk im Hängefenster');
await p.screenshot({path:out+'/markerfenster.png'});
await p.close({runBeforeUnload:false});await c.setOffline(false);
p=await c.newPage();await p.goto(base+'/studio/'+pid);const w=p.getByRole('region',{name:'Wiederherstellung'});await w.waitFor();
await w.getByRole('button',{name:'Hochladen & abschließen'}).click();
await w.getByText('Unterbrochene Aufnahme übertragen').waitFor({timeout:30000});
ok(true,'BUG: harter Tababbruch im Markerfenster führt zu erfolgreicher verkürzter Recovery statt Missing-Hinweis');
await p.screenshot({path:out+'/markerfenster-recovery.png'});await c.close();
console.log('MARKER DONE');
}finally{writeFileSync(out+'/marker-results.json',JSON.stringify(results,null,2));await b?.close();own.server.closeAllConnections?.();await own.close();rmSync(tmp,{recursive:true,force:true})}
