import {firefox} from '@playwright/test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import net from 'node:net';
const out='../Pruefungen/Video-Recheck',base='http://127.0.0.1:8865/podcast',results=[];
const ok=(v,m)=>{results.push({pass:!!v,msg:m});console.log(v?'OK':'FAIL',m);if(!v)throw Error(m)};
await new Promise((r,j)=>{const s=net.createServer();s.on('error',j);s.listen(8865,'127.0.0.1',()=>s.close(r))});
const temp=mkdtempSync(out+'/temp-ff-');const {createStudioServer}=await import('../../server/index.mjs');const own=await createStudioServer({dataDir:temp,base:'/podcast',dist:process.env.DIST});await new Promise(r=>own.server.listen(8865,'127.0.0.1',r));let b;
try{
b=await firefox.launch({firefoxUserPrefs:{'media.navigator.streams.fake':true,'media.navigator.permission.disabled':true}});const p=await b.newPage();
await p.goto(base+'/studio');await p.getByLabel('Neues Projekt').fill('Firefox Zusatz');await p.getByRole('button',{name:'Anlegen & aufnehmen'}).click();await p.getByRole('heading',{name:'Bereit zur Aufnahme'}).waitFor();
await p.evaluate(()=>history.replaceState({usr:{brief:'Recheck Aufnahmebrief bleibt erhalten'},key:'recheck',idx:0},'',location.pathname+'?titel=Producerfolge&name=Pruefer'));await p.reload();await p.getByRole('heading',{name:'Bereit zur Aufnahme'}).waitFor();
await p.getByRole('radio',{name:'Video + Ton'}).check();await p.getByTestId('studio-kamera-werte').waitFor();
ok(await p.getByLabel('Titel der Aufnahme').inputValue()==='Producerfolge'&&await p.getByLabel('Name auf der Spur').inputValue()==='Pruefer','Firefox: Producer Titel/Name nach Video erhalten');
await p.locator('details').evaluate(e=>e.open=true);ok((await p.locator('body').innerText()).includes('Recheck Aufnahmebrief bleibt erhalten'),'Firefox: Aufnahmebrief nach Videowahl erhalten');
await p.getByRole('button',{name:'Video-Aufnahme starten'}).click();await p.getByRole('heading',{name:'Aufnahme läuft'}).waitFor();await p.waitForTimeout(6000);await p.getByRole('button',{name:'Aufnahme beenden'}).click();await p.getByRole('heading',{name:'Aufnahme gesichert'}).waitFor({timeout:60000});
const href=await p.getByRole('link',{name:'Original herunterladen'}).getAttribute('href');const t=await(await fetch(base+'/api/tracks/'+href.split('/tracks/')[1].split('/')[0])).json();results.push({track:t});ok(t.kind==='video'&&t.width>0&&t.status==='ready','Firefox: echtes Video kurz bis ready');await p.screenshot({path:out+'/firefox.png'});
const start=performance.now();let e=await(await fetch(base+'/api/tracks/'+t.id+'/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format:'mp4'})})).json();
for(let i=0;i<120&&!['ready','failed'].includes(e.status);i++){await p.waitForTimeout(500);e=await(await fetch(base+'/api/exports/'+e.id)).json()}
results.push({export:e,wallMs:performance.now()-start});ok(e.status==='ready','Firefox: kurzer MP4-Export fertig, Dauer separat gemessen');
}finally{writeFileSync(out+'/firefox-results.json',JSON.stringify(results,null,2));await b?.close();own.server.closeAllConnections?.();await own.close();rmSync(temp,{recursive:true,force:true})}
