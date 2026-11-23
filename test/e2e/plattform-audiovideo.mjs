// PA10 independent mixed audio/video concurrency and download control.
// PA7-Browserprüfung: Recorder unter Konten gegen echten PA1-Server (eigene Temp-Daten, Port 8873, Basis /podcast).
// Aufruf: DIST=<scratch-build mit VITE_BASE=/podcast/> OUT=<Berichtsordner> node src/lib/recorder/pa7.browser-check.mjs
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openDB } from '../../server/db.mjs';
import { migrate } from '../../server/migrate.mjs';
import { ownerCreate, legacyClaim } from '../../server/accounts.mjs';
import { createStudioServer } from '../../server/index.mjs';

const PORT = Number(process.env.PORT ?? 8876), ORIGIN = `http://127.0.0.1:${PORT}`, base = ORIGIN + '/podcast';
const out = path.resolve(process.env.OUT ?? '.'); mkdirSync(out, { recursive: true });
const results = [];
const ok = (v, m) => { results.push({ pass: !!v, msg: m }); console.log(v ? 'OK' : 'FAIL', m); if (!v) throw Error(m); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
await new Promise((r, j) => { const s = net.createServer(); s.on('error', j); s.listen(PORT, '127.0.0.1', () => s.close(r)); });

const tmp = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'pa7-'));
const file = path.join(tmp, 'studio.sqlite');
{ const db = openDB(file); await migrate(db, file); var setup = ownerCreate({ db, base: '/podcast' }, 'a@example.test', 'Konto A'); db.close(); }
const app = await createStudioServer({ dataDir: tmp, base: '/podcast', dist: process.env.DIST, origins: ORIGIN, cookieInsecure: true });
await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));
const db = app.ctx.db;
const H = { 'X-Studio': '1', Origin: ORIGIN };
const PW_A = 'pa7-test-kennwort-a', PW_B = 'pa7-test-kennwort-b';
let browser;
const fehler = [];
try {
  // Konten über öffentliche HTTP-Wege: Setup-Link A, Einladung B.
  const raw = async (m, p, body, cookie) => fetch(base + '/api' + p, { method: m, headers: { ...H, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
  let r = await raw('POST', '/auth/token/' + setup.url.split('/').at(-1), { password: PW_A });
  ok(r.ok, 'Konto A (Eigentümer) per Setup-Link eingerichtet');
  const cookieA = r.headers.get('set-cookie').split(';')[0]; const A = (await r.json()).user.id;
  const inv = await (await raw('POST', '/admin/invites', { planId: 'free', email: 'b@example.test' }, cookieA)).json();
  r = await raw('POST', '/auth/token/' + inv.url.split('/').at(-1), { password: PW_B, displayName: 'Konto B' });
  ok(r.ok, 'Konto B (Mitglied) per Einladung eingerichtet'); const B = (await r.json()).user.id;

  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const c = await browser.newContext({ permissions: ['microphone','camera'], viewport: { width: 1280, height: 860 } });
  await c.addInitScript(() => {
    window.generated = [];
    const start = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function (...a) { this.addEventListener('dataavailable', (e) => { if (e.data.size) window.generated.push(e.data); }); return start.apply(this, a); };
  });
  const api = async (m, p, data) => { const res = await c.request.fetch(base + '/api' + p, { method: m, headers: H, data }); return res; };
  const login = async (email, password) => { const res = await api('POST', '/auth/login', { email, password }); if (!res.ok()) throw Error('login ' + res.status()); };
  const logout = () => api('POST', '/auth/logout');
  const neuesProjekt = async (t) => (await (await api('POST', '/projects', { title: t })).json()).id;
  const watch = (p) => {
    p.on('pageerror', (e) => fehler.push('pageerror ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/401|404|Failed to load resource/.test(m.text())) fehler.push('console ' + m.text()); });
  };
  const idb = (p) => p.evaluate(() => new Promise((res) => { const q = indexedDB.open('podcast-studio-aufnahme'); q.onsuccess = () => { const tx = q.result.transaction(['meta', 'chunks']); const m = tx.objectStore('meta').getAll(); const k = tx.objectStore('chunks').getAllKeys(); tx.oncomplete = () => res({ metas: m.result, keys: k.result }); }; }));
  const genSha = (p) => p.evaluate(async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await new Blob(window.generated).arrayBuffer()))).map((v) => v.toString(16).padStart(2, '0')).join(''));
  const fertigeSpur = async (trackId) => { let t; for (let i = 0; i < 120; i++) { t = db.get('tracks', trackId); if (t?.status === 'ready' || t?.status === 'failed') break; await new Promise((x) => setTimeout(x, 500)); } return t; };
  const rohSha = (t) => { const rec = db.get('recordings', t.recordingId); return sha(readFileSync(path.join(tmp, 'medien', rec.projectId, t.recordingId, t.id, 'roh.webm'))); };

  await login('a@example.test', PW_A); let p;
  // Independent integration additions: R3, Producer isolation, M6, real fetch abort.
  p = await c.newPage(); await p.goto(base+'/');
  await p.evaluate(({A,B})=>{localStorage.setItem(`podcast-studio:${A}:sprecher`,'Producer A');localStorage.setItem(`podcast-studio:${B}:sprecher`,'Producer B');localStorage.setItem('podcast-studio:sprecher','GLOBAL FALSCH')},{A,B});
  await p.reload();
  await p.getByLabel('Dein Name auf der Spur', {exact:true}).waitFor();
  ok(await p.getByLabel('Dein Name auf der Spur',{exact:true}).inputValue()==='Producer A','Producer nutzt eigenen A-Schlüssel');
  // Synthetic own pending metadata (not media) is sufficient for logout guard; preserve snapshot.
  await p.evaluate(A=>new Promise(resolve=>{const q=indexedDB.open('podcast-studio-aufnahme');q.onsuccess=()=>{const tx=q.result.transaction('meta','readwrite');tx.objectStore('meta').put({trackId:'review-logout-own',userId:A,projectId:'review',title:'Logout-Test',chunkCount:1,startedAtMs:1,lastChunkAtMs:2,durationMs:null,mimeType:'audio/webm'});tx.oncomplete=resolve}}),A);
  const beforeLogout = await idb(p);
  await p.goto(base+'/konto');
  let dialogs=0; const cancel=d=>{dialogs++;void d.dismiss()};p.on('dialog',cancel);
  await p.getByRole('button',{name:'Abmelden',exact:true}).click();await p.waitForTimeout(700);
  ok(dialogs===1 && await p.getByRole('button',{name:'Abmelden',exact:true}).isEnabled() && (await api('GET','/session')).ok(),'R3 abbrechen: Dialog, Konto bleibt angemeldet, Knopf wieder bedienbar');
  p.off('dialog',cancel);p.once('dialog',d=>d.accept());
  await p.getByRole('button',{name:'Abmelden',exact:true}).click();await p.waitForURL('**/anmelden**');
  ok(JSON.stringify(await idb(p))===JSON.stringify(beforeLogout),'R3 bestätigen: alle lokalen Metadaten/Chunkkeys unverändert');
  await login('b@example.test',PW_B);await p.goto(base+'/');
  ok(await p.getByLabel('Dein Name auf der Spur',{exact:true}).inputValue()==='Producer B','Producer nutzt eigenen B-Schlüssel, ignoriert globalen/A-Namen');
  await login('a@example.test',PW_A);await p.close();
  // Two genuinely separate sessions/contexts recording concurrently.
  const cb=await browser.newContext({permissions:['microphone','camera']});
  await cb.request.post(base+'/api/auth/login',{headers:H,data:{email:'b@example.test',password:PW_B}});
  const pbid=(await(await cb.request.post(base+'/api/projects',{headers:H,data:{title:'M6 B'}})).json()).id;
  const paid=await neuesProjekt('M6 A');
  const pa=await c.newPage(),pb=await cb.newPage();
  await cb.addInitScript(()=>{window.generated=[];const st=MediaRecorder.prototype.start;MediaRecorder.prototype.start=function(...a){this.addEventListener('dataavailable',e=>{if(e.data.size)generated.push(e.data)});return st.apply(this,a)}});
  await Promise.all([pa.goto(base+'/studio/'+paid),pb.goto(base+'/studio/'+pbid)]);
  await pb.getByRole('radio',{name:'Video + Ton'}).check();await pb.getByTestId('studio-kamera-werte').waitFor();
  await pa.getByRole('button',{name:'Aufnahme starten',exact:true}).click();await pb.getByRole('button',{name:'Video-Aufnahme starten',exact:true}).click();
  await Promise.all([pa.waitForFunction(()=>generated.length>=3),pb.waitForFunction(()=>generated.length>=3)]);
  for(const page of [pa,pb])await page.getByRole('button',{name:'Aufnahme beenden'}).click();
  for(const page of [pa,pb])await page.getByRole('heading',{name:'Aufnahme gesichert'}).waitFor({timeout:60000});
  for(const [page,pid,uid] of [[pa,paid,A],[pb,pbid,B]]){const rec=db.all('recordings').find(r=>r.projectId===pid);const t=await fertigeSpur(db.all('tracks').find(t=>t.recordingId===rec.id).id);ok(t.status==='ready'&&t.ownerId===uid&&rohSha(t)===await genSha(page),'M6: richtige Kontozuordnung und byteidentische Rohdatei '+uid.slice(0,6));}
  for(const [ctx,uid] of [[c,A],[cb,B]]){const t=db.all('tracks').find(t=>t.ownerId===uid&&t.status==='ready');const response=await ctx.request.get(base+'/api/tracks/'+t.id+'/file?download=1');ok(sha(await response.body())===t.sha256,'M6: Download SHA = Original '+t.kind);}
  const foreign= db.all('tracks').find(t=>t.ownerId===A);
  ok((await cb.request.get(base+'/api/tracks/'+foreign.id)).status()===404,'M6: B erhält für A-Spur 404');
  await pa.close();await pb.close();await cb.close();
  // Session check must cancel fetch itself after 20s, not merely return from a race.
  p=await c.newPage();await p.goto(base+'/studio/'+paid);await p.getByRole('heading',{name:'Bereit zur Aufnahme'}).waitFor();
  await p.evaluate(()=>{window.sessionAbort=[];const f=window.fetch;window.fetch=function(input,opts){if(String(input).endsWith('/session'))opts?.signal?.addEventListener('abort',()=>sessionAbort.push(performance.now()),{once:true});return f.call(this,input,opts)}});
  await p.route('**/api/session',()=>{});
  let failedSession=0;p.on('requestfailed',r=>{if(r.url().endsWith('/api/session'))failedSession++});
  await p.getByRole('button',{name:'Aufnahme starten',exact:true}).click(); await p.getByRole('heading',{name:'Aufnahme läuft'}).waitFor(); db.sql.prepare('DELETE FROM sessions WHERE user_id=?').run(A); const startTimeout=Date.now();
  await p.waitForFunction(()=>sessionAbort.length>0,null,{timeout:35000});await p.waitForTimeout(500);
  ok(Date.now()-startTimeout>=19000 && failedSession>0,'Session-Frist: AbortSignal ausgelöst UND Browser-Sessionrequest fehlgeschlagen nach ca.20s');
  await p.unroute('**/api/session');await p.close();

} finally {
  writeFileSync(path.join(out, 'integration-results.json'), JSON.stringify({ results, fehler }, null, 1));
  await browser?.close();
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
}
