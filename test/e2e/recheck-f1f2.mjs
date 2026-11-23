// F1/F2-Browserprüfung (Fixes nach AP7): echter Server, echte Chromium-IndexedDB, nur chunks-put simuliert fehlerhaft.
// Aufruf aus App/: VITE_BASE=/podcast/ npm run build && node src/lib/recorder/f1f2.browser-check.mjs
// Port 8862, isolierte Daten unter ../Pruefungen/Recheck-F1-F2/temp-*, wird am Ende entfernt. Keine Produktionsdaten.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const PORT = 8865, base = `http://127.0.0.1:${PORT}/podcast`, out = '../Pruefungen/Recheck-F1-F2';
await new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(PORT, '127.0.0.1', () => s.close(res)); });
const temp = mkdtempSync('../Pruefungen/Recheck-F1-F2/temp-');
const { createStudioServer } = await import('../../server/index.mjs');
const own = await createStudioServer({ dataDir: temp, base: '/podcast' });
await new Promise((r) => own.server.listen(PORT, '127.0.0.1', r));

const log = [];
const ok = (b, m) => { log.push({ pass: !!b, msg: m }); console.log(b ? 'OK  ' : 'FAIL', m); if (!b) throw new Error(m); };
const quota = () => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...a) { if (this.name === 'chunks') throw new DOMException('F1-Test quota', 'QuotaExceededError'); return put.apply(this, a); };
};
let browser;
try {
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ permissions: ['microphone'], acceptDownloads: true });
  await ctx.addInitScript(quota);
  let page = await ctx.newPage();
  await page.goto(base + '/studio');
  await page.getByLabel('Neues Projekt').fill('F1F2 Prüfung');
  await page.getByRole('button', { name: 'Anlegen & aufnehmen' }).click();
  await page.waitForURL(/\/studio\/[0-9a-f-]{36}$/);
  const pid = page.url().split('/').at(-1);
  const phase = () => page.locator('[data-phase]').getAttribute('data-phase');
  const body = () => page.locator('body').innerText();

  // --- A: Quota + offline → sofortiger Stopp, ehrliche Anzeige, Notfalldatei, Upload-Rettung ---
  await page.getByRole('heading', { name: 'Bereit zur Aufnahme' }).waitFor();
  await page.getByLabel('Titel der Aufnahme').fill('Quota offline Rettung');
  await page.getByRole('button', { name: 'Aufnahme starten', exact: true }).click();
  await page.getByRole('heading', { name: 'Aufnahme läuft' }).waitFor();
  await ctx.setOffline(true);
  await page.getByRole('heading', { name: 'Aufnahme wird gesichert' }).waitFor({ timeout: 9000 });
  ok(await phase() === 'abschluss', 'A: erster Persistenzfehler beendet die Aufnahme sofort (Phase abschluss nach erstem 4-s-Abschnitt)');
  const t1 = await body();
  const zaehler = () => body().then((b) => b.match(/(\d+)\/(\d+) Abschnitte auf dem Server/)?.slice(1).map(Number));
  const z1 = await zaehler();
  await page.waitForTimeout(9000);
  const z2 = await zaehler();
  ok(z1 && z2 && z1[1] === z2[1] && z2[1] <= 2, `A: Aufnahme wächst seit dem Fehler nicht weiter (${JSON.stringify(z1)} → ${JSON.stringify(z2)})`);
  const t2 = await body();
  ok(/nur im Arbeitsspeicher/.test(t2) && /Tab vorher geschlossen/.test(t2), 'A: RAM-only-Hinweis mit ehrlicher Tababbruch-Grenze sichtbar');
  ok(!/wird lokal gesichert|\(lokal gesichert\)|Abschnitte bleiben lokal gespeichert/.test(t1 + t2), 'A: keine Zusage „lokal gesichert“ ohne Nachweis');
  ok(/0 lokal gesichert, \d+ nur im Arbeitsspeicher/.test(t2), 'A: Zählung lokal=0 / nurRam>0 angezeigt');
  await page.screenshot({ path: out + '/a-quota-offline-stopp.png' });
  const studioUrl=page.url();
  for(const action of ['marke','back']){
    const dialog=page.waitForEvent('dialog');
    if(action==='marke') await page.getByRole('link',{name:'Podcast-Studio – Startseite'}).click({noWaitAfter:true});
    else await page.evaluate(()=>history.back());
    const d=await dialog; ok(d.type()==='confirm'&&/Arbeitsspeicher/.test(d.message()),'Navigation '+action+': native RAM-Rückfrage');
    await d.dismiss(); await page.waitForTimeout(700);
    ok(page.url()===studioUrl && await phase()==='abschluss' && JSON.stringify(await zaehler())===JSON.stringify(z2),'Navigation '+action+': dismiss erhält Studio und RAM-Zähler');
  }

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Notfalldatei speichern' }).click()]);
  const notfall = `${temp}/notfall.webm`;
  await dl.saveAs(notfall);
  execFileSync('ffmpeg', ['-v', 'error', '-i', notfall, '-f', 'null', '-'], { stdio: 'pipe' });
  // Rohes MediaRecorder-WebM trägt keine Gesamtdauer → letzte Paketzeit als dekodierte Dauer.
  const dauer = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', notfall]).toString().trim().split('\n').at(-1);
  ok(true, `A: Notfalldatei über UI-Download erhalten, vollständig dekodierbar (${dl.suggestedFilename()}, letzte Paketzeit ${dauer} s)`);
  ok(/Ob die Datei gespeichert wurde, kann die Seite nicht feststellen/.test(await body()), 'A: Download wird nicht als bestätigte Sicherung ausgegeben');
  await ctx.setOffline(false);
  await page.getByRole('heading', { name: 'Aufnahme gesichert' }).waitFor({ timeout: 60000 });

  const href=await page.getByRole('link',{name:'Original herunterladen'}).getAttribute('href');
  const tid=href.split('/tracks/')[1].split('/')[0];
  const track=await (await fetch(base+'/api/tracks/'+tid)).json();
  const [origDl]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Original herunterladen'}).click()]);
  await origDl.saveAs(temp+'/original.webm');
  const hash=f=>createHash('sha256').update(readFileSync(f)).digest('hex');
  ok(hash(temp+'/original.webm')===track.sha256 && hash(temp+'/medien/'+pid+'/'+track.recordingId+'/'+tid+'/original.webm')===track.sha256,'A: UI Original = API SHA = physische Serverdatei');
  execFileSync('ffmpeg',['-v','error','-i',temp+'/original.webm','-f','null','-']);
  const t3 = await body();
  ok(/Alle betroffenen Abschnitte hat der Server inzwischen bestätigt/.test(t3) && !/nur im Arbeitsspeicher dieses Tabs/.test(t3), 'A: nach bestätigtem Upload RAM-Zahl abgebaut, Hinweis umgestellt');
  await page.screenshot({ path: out + '/a-rettung-gesichert.png' });

  // --- B: Quota + offline + harter Tababbruch → Bergung meldet fehlende Abschnitte statt still/leer ---
  await page.goto(base + '/studio/' + pid);
  await page.getByRole('heading', { name: 'Bereit zur Aufnahme' }).waitFor();
  const wieder = page.getByRole('region', { name: 'Wiederherstellung' });
  if (await wieder.count()) await wieder.getByRole('button', { name: 'Später' }).click();
  await page.getByLabel('Titel der Aufnahme').fill('Quota offline Abbruch');
  await page.getByRole('button', { name: 'Aufnahme starten', exact: true }).click();
  await page.getByRole('heading', { name: 'Aufnahme läuft' }).waitFor();
  await ctx.setOffline(true);
  await page.getByRole('heading', { name: 'Aufnahme wird gesichert' }).waitFor({ timeout: 9000 });
  await page.waitForTimeout(1500);
  await page.close({ runBeforeUnload: false });
  await ctx.setOffline(false);
  page = await ctx.newPage();
  await page.goto(base + '/studio/' + pid);
  const w = page.getByRole('region', { name: 'Wiederherstellung' });
  await w.waitFor();
  const wt = await w.innerText();
  ok(/nicht im Browser gesichert werden/.test(wt), 'B: Bergungshinweis nennt nicht lokal gesicherte Abschnitte');
  await w.getByRole('button', { name: 'Hochladen & abschließen' }).click();
  await w.getByText('Abschnitte fehlen').waitFor({ timeout: 20000 });
  const wt2 = await w.innerText();
  ok(!/keine Daten|fertig verarbeitet|verarbeitet sie jetzt/.test(wt2), 'B: keine stille erfolgreiche/leer gemeldete Bergung – chunks_missing sichtbar');
  await page.screenshot({ path: out + '/b-tababbruch-bergung.png' });
  log.push({ bBody: wt2 });
  await w.getByRole('button', { name: 'Verwerfen …' }).click();
  await w.getByRole('button', { name: 'Ja, verwerfen' }).click();
  // Bewusstes Verlassen bei erneutem Quota/RAM-Zustand.
  await page.getByLabel('Titel der Aufnahme').fill('Bewusst verlassen');
  await page.getByRole('button',{name:'Aufnahme starten',exact:true}).click();
  await page.getByRole('heading',{name:'Aufnahme läuft'}).waitFor();
  await ctx.setOffline(true);
  await page.getByRole('heading',{name:'Aufnahme wird gesichert'}).waitFor({timeout:9000});
  const accepted=page.waitForEvent('dialog');
  await page.getByRole('link',{name:'Podcast-Studio – Startseite'}).click({noWaitAfter:true});
  await (await accepted).accept();
  await page.waitForURL(u=>u.pathname==='/podcast'||u.pathname==='/podcast/');
  ok(true,'Navigation: accept verlässt bewusst zur Startseite unter /podcast/');
  await page.close();
  await ctx.close();

  // --- C: hängendes finalize (Verbindung offen, keine Antwort) → Frist bricht ab, Retry sichert ---
  const c2 = await browser.newContext({ permissions: ['microphone'] });
  page = await c2.newPage();
  let haengend = 0, abgebrochen = false, erneut = 0;
  await page.route('**/finalize', async (r) => {
    if (haengend++ === 0) { r.request().response().catch(() => {}); page.once('requestfailed', (q) => { if (q.url().endsWith('/finalize')) abgebrochen = true; }); return; } // nie beantworten
    erneut++; await r.continue();
  });
  await page.goto(base + '/studio/' + pid);
  await page.getByRole('heading', { name: 'Bereit zur Aufnahme' }).waitFor();
  await page.getByLabel('Titel der Aufnahme').fill('Finalize hängt');
  await page.getByRole('button', { name: 'Aufnahme starten', exact: true }).click();
  await page.getByRole('heading', { name: 'Aufnahme läuft' }).waitFor();
  await page.waitForTimeout(5000);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Aufnahme beenden' }).click();
  await page.getByRole('heading', { name: 'Aufnahme gesichert' }).waitFor({ timeout: 120000 });
  ok(abgebrochen && erneut >= 1, `C: hängendes finalize nach Frist im Browser abgebrochen (requestfailed) und wiederholt; gesichert nach ${Math.round((Date.now() - t0) / 1000)} s`);
  await page.screenshot({ path: out + '/c-finalize-frist.png' });
  await c2.close();
  console.log('RECHECK DONE');
} finally {
  writeFileSync(out + '/browser-ergebnis.json', JSON.stringify(log, null, 2));
  await browser?.close();
  own.server.closeAllConnections?.();
  await own.close();
  rmSync(temp, { recursive: true, force: true });
}
