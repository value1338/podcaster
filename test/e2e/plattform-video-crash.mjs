// PA10 actual CDP renderer crash, avoiding graceful tab-close teardown.
import {chromium} from '@playwright/test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import net from 'node:net';
const out=process.env.OUT,base='http://127.0.0.1:18879/podcast',results=[];
const ok=(v,m)=>{results.push({pass:!!v,msg:m});console.log(v?'OK':'FAIL',m);if(!v)throw Error(m)};
await new Promise((r,j)=>{let s=net.createServer();s.on('error',j);s.listen(18879,'127.0.0.1',()=>s.close(r))});
const tmp=mkdtempSync(out+'/temp-');const {createStudioServer}=await import('../../server/index.mjs');
const {openDB}=await import('../../server/db.mjs');const {migrate}=await import('../../server/migrate.mjs');const {ownerCreate}=await import('../../server/accounts.mjs');const f=tmp+'/studio.sqlite',db=openDB(f);await migrate(db,f);const setup=ownerCreate({db,base:'/podcast'},'recovery@example.test','Recovery');db.close();
const own=await createStudioServer({dataDir:tmp,base:'/podcast',dist:process.env.DIST,origins:'http://127.0.0.1:18879',cookieInsecure:true});await new Promise(r=>own.server.listen(18879,'127.0.0.1',r));let browser;
const login=await fetch(base+'/api/auth/token/'+setup.url.split('/').at(-1),{method:'POST',headers:{'X-Studio':'1',Origin:'http://127.0.0.1:18879'},body:JSON.stringify({password:'recovery-test-password'})});const cookie=login.headers.get('set-cookie').split(';')[0];
try{
 browser=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 for(const mode of ['normal']){
 const c=await browser.newContext({permissions:['microphone','camera'],acceptDownloads:true});
 await c.addCookies([{name:cookie.split("=")[0],value:cookie.split("=")[1],domain:"127.0.0.1",path:"/podcast/"}]);
 await c.addInitScript(()=>{
 window.generated=[];window.delivered=[];
 const start=MediaRecorder.prototype.start;
 MediaRecorder.prototype.start=function(...a){this.addEventListener('dataavailable',e=>{if(e.data.size)window.generated.push(e.data)});return start.apply(this,a)};
 const put=IDBObjectStore.prototype.put,get=IDBObjectStore.prototype.get;
 const desc=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete');
 Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...desc,set(fn){const delay=this.markerDelay;desc.set.call(this,delay?function(e){window.realCommit=Date.now();setTimeout(()=>{window.delivered.push(Date.now());fn.call(this,e)},15000)}:fn)}});
 IDBObjectStore.prototype.put=function(...a){if(this.name==='chunks'&&window.failNow){if(window.mode==='quota'||window.mode==='race')throw new DOMException('test quota','QuotaExceededError');if(window.mode==='late'&&!window.delayed){window.delayed=true;window.delayStart=Date.now();this.transaction.markerDelay=true;}}return put.apply(this,a)};
 IDBObjectStore.prototype.get=function(...a){if(this.name==='meta'&&window.failNow&&window.mode==='quota')return {};if(this.name==='meta'&&window.failNow&&window.mode==='race'&&!window.metaDelayed){window.metaDelayed=true;const r=get.apply(this,a);const fake={};r.onsuccess=()=>{fake.result=r.result;setTimeout(()=>fake.onsuccess?.(),9000)};return fake;}return get.apply(this,a)};
 });
 let p=await c.newPage();await p.goto(base+'/studio');await p.getByLabel('Neues Projekt').fill(mode);await p.getByRole('button',{name:'Anlegen & aufnehmen'}).click();await p.getByRole('heading',{name:'Bereit zur Aufnahme'}).waitFor();const pid=p.url().split('/').at(-1);
 await p.getByRole('radio',{name:'Video + Ton'}).check();await p.getByTestId('studio-kamera-werte').waitFor();
 let ack=0;p.on('response',r=>{if(r.request().method()==='PUT'&&/chunks/.test(r.url())&&r.ok())ack++});
 await p.getByRole('button',{name:'Video-Aufnahme starten',exact:true}).click();await p.getByRole('heading',{name:'Aufnahme läuft'}).waitFor();
 await p.waitForFunction(()=>window.generated.length>=1);await p.waitForTimeout(700);ok(ack===1,mode+': Chunk0 echt HTTP quittiert');
 if(mode==='normal'){
 await c.setOffline(true);await p.waitForFunction(()=>generated.length>=3);await p.waitForTimeout(500);
 const idb=await p.evaluate(()=>new Promise(res=>{let r=indexedDB.open('podcast-studio-aufnahme');r.onsuccess=()=>{let q=r.result.transaction('chunks').objectStore('chunks').getAll();q.onsuccess=()=>res(q.result.map(x=>({bytes:x.size})))}}));
 results.push({mode,idb});ok(idb.length>=2,'Video-Crash: mindestens zwei echte IDB-Fragmente vor Tababbruch');
 const expected=await p.evaluate(async()=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await new Blob(generated).arrayBuffer()))).map(v=>v.toString(16).padStart(2,'0')).join(''));
 const crashed=p.waitForEvent('crash',{timeout:5000});void (await c.newCDPSession(p)).send('Page.crash').catch(()=>{});await crashed;await p.close({runBeforeUnload:false}).catch(()=>{});await c.setOffline(false);p=await c.newPage();await p.goto(base+'/studio/'+pid);
 const w=p.getByRole('region',{name:'Wiederherstellung'});await w.waitFor();await w.getByRole('button',{name:'Hochladen & abschließen'}).click();try{await w.getByText('Unterbrochene Aufnahme übertragen',{exact:true}).waitFor({timeout:30000})}catch(e){results.push({mode,body:await p.locator('body').innerText(),tracks:own.ctx.db.all('tracks')});await p.screenshot({path:out+'/recovery-normal-failure.png'});throw e;}
 let tracks=own.ctx.db.all('tracks').filter(t=>own.ctx.db.get('recordings',t.recordingId)?.projectId===pid);let t=tracks.at(-1);for(let i=0;i<60&&t.status!=='ready';i++){await p.waitForTimeout(500);t=await(await fetch(base+'/api/tracks/'+t.id,{headers:{cookie}})).json()}
 const dir=tmp+'/medien/'+pid+'/'+t.recordingId+'/'+t.id;
 ok(t.status==='ready'&&t.kind==='video','Video-Crash: Recovery ready');
 ok(createHash('sha256').update(readFileSync(dir+'/roh.webm')).digest('hex')===expected,'Video-Crash: IDB-Recovery roh SHA identisch zu allen vor Abbruch erzeugten Blobs');
 execFileSync('ffmpeg',['-v','error','-i',dir+'/original.webm','-f','null','-']);ok(true,'Video-Crash: gerettetes Original dekodiert');await c.close();continue;
 }
 else{
 await p.evaluate(m=>{window.failNow=true;window.mode=m},mode==='late'?'late':mode==='meta-race'?'race':'quota');await c.setOffline(true);
 await p.getByRole('heading',{name:'Aufnahme wird gesichert'}).waitFor({timeout:16000});await p.waitForTimeout(350);
 const state=await p.evaluate(()=>({n:generated.length,markers:Object.entries(localStorage).filter(([k])=>k.startsWith('podcast-studio:nicht-lokal:')).map(([k,v])=>JSON.parse(v)),now:Date.now(),start:window.delayStart,commit:window.realCommit}));
 results.push({mode,state,body:await p.locator('body').innerText()});
 ok(state.markers.some(m=>m.chunkCount===state.n),mode+': Marker deckt alle erzeugten Indizes ab');
 if(mode!=='late')ok(state.n===3,mode+': inklusive Schlussabschnitt vor 10s (3 erzeugt)');
 else ok(state.now-state.start>=10000&&state.now-state.start<14000&&state.commit<state.now, 'late: echte Transaktion abgeschlossen, App nach 10s-Frist gestoppt vor verspäteter Zustellung');
 const [dl]=await Promise.all([p.waitForEvent('download'),p.getByRole('button',{name:'Notfalldatei speichern'}).click()]);await dl.saveAs(out+'/'+mode+'.webm');
 execFileSync('ffmpeg',['-v','error','-i',out+'/'+mode+'.webm','-f','null','-']);ok(/mit Dateikopf aus Abschnitt 0/.test(await p.locator('body').innerText()),mode+': Notfalldownload dekodiert und ehrlich als Fragment mit Kopf angezeigt');
 await p.screenshot({path:out+'/'+mode+'.png'});
 if(mode==='quota-crash'){
 await p.close({runBeforeUnload:false});await c.setOffline(false);p=await c.newPage();await p.goto(base+'/studio/'+pid);const w=p.getByRole('region',{name:'Wiederherstellung'});await w.waitFor();await w.getByRole('button',{name:'Hochladen & abschließen'}).click();await w.getByText('Abschnitte fehlen').waitFor({timeout:30000});ok(!/Unterbrochene Aufnahme übertragen/.test(await w.innerText()),'Crash: Missing statt still verkürztem Erfolg');await p.screenshot({path:out+'/recovery.png'});await c.close();continue;
 }
 if(mode==='late'){
 await p.waitForFunction(()=>window.delivered.length===1,{},{timeout:10000});
 const later=await p.evaluate(()=>({n:generated.length,m:Object.entries(localStorage).filter(([k])=>k.startsWith('podcast-studio:nicht-lokal:')).map(([k,v])=>JSON.parse(v))}));ok(later.n===state.n&&later.m.some(m=>m.chunkCount===state.n),'late: verspätete Zustellung verliert keinen Marker, Aufnahme bleibt gestoppt');
 const [dl2]=await Promise.all([p.waitForEvent('download'),p.getByRole('button',{name:'Notfalldatei speichern'}).click()]);await dl2.saveAs(out+'/late-after.webm');ok(readFileSync(out+'/late-after.webm').equals(readFileSync(out+'/late.webm')),'late: RAM-Rettung nach verspäteter Zustellung byteidentisch');
 }
 await c.setOffline(false);
 }
 await p.getByRole('heading',{name:'Aufnahme gesichert'}).waitFor({timeout:60000});
 const href=await p.getByRole('link',{name:'Original herunterladen'}).getAttribute('href');const tid=href.split('/tracks/')[1].split('/')[0];const track=await(await fetch(base+'/api/tracks/'+tid,{headers:{cookie}})).json();
 const expected=await p.evaluate(async()=>{const a=await new Blob(generated).arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',a))).map(v=>v.toString(16).padStart(2,'0')).join('')});
 const original=Buffer.from(await(await fetch(new URL(href,base),{headers:{cookie}})).arrayBuffer());const hash=b=>createHash('sha256').update(b).digest('hex');
 ok(hash(readFileSync(tmp+'/medien/'+pid+'/'+track.recordingId+'/'+tid+'/roh.webm'))===expected&&hash(original)===track.sha256&&hash(readFileSync(tmp+'/medien/'+pid+'/'+track.recordingId+'/'+tid+'/original.webm'))===track.sha256,mode+': SHA erzeugter Blobs = Rohdatei; Original-SHA = API = Download = physische Serverdatei');
 ok(track.receivedChunks===await p.evaluate(()=>generated.length),mode+': alle erzeugten Indizes serverbestätigt');
 await p.waitForTimeout(mode==='quota-online'||mode==='meta-race'?12000:500);
 const metas=await p.evaluate(()=>new Promise((res,rej)=>{const r=indexedDB.open('podcast-studio-aufnahme');r.onsuccess=()=>{const q=r.result.transaction('meta').objectStore('meta').getAll();q.onsuccess=()=>res(q.result)}}));results.push({mode,metas});console.log('METAS',mode,JSON.stringify(metas));
 results.push({mode,final:await p.locator('body').innerText(),storage:await p.evaluate(()=>Object.entries(localStorage))});await c.close();
 }
 console.log('MARKERFIX DONE');
}finally{writeFileSync(out+'/'+(process.env.CASES?'recovery-normal-results.json':'recovery-results.json'),JSON.stringify(results,null,2));await browser?.close();own.server.closeAllConnections?.();await own.close();rmSync(tmp,{recursive:true,force:true})}
