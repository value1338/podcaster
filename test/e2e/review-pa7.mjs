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
  const c = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 860 } });
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

  // ---------- R2: Sitzung läuft während der Aufnahme ab; falsches Konto; dasselbe Konto setzt lückenlos fort ----------
  await login('a@example.test', PW_A);
  const p1 = await neuesProjekt('PA7 Ablauf');
  let p = await c.newPage(); watch(p);
  let navs = 0; p.on('framenavigated', (f) => { if (f === p.mainFrame()) navs++; });
  await p.goto(base + '/studio/' + p1);
  await p.getByRole('heading', { name: 'Bereit zur Aufnahme' }).waitFor();
  await p.getByLabel('Name auf der Spur').fill('Sprecherin A');
  const navsVorStart = navs;
  let acks = 0; const putsNachB = []; let phaseB = false;
  const authLog = []; p.on('response', (x) => { if (/\/api\/(auth|session)/.test(x.url())) authLog.push(x.request().method() + ' ' + x.url().split('/api')[1] + ' ' + x.status()); });
  p.on('response', (x) => { if (x.request().method() === 'PUT' && /chunks/.test(x.url())) { if (x.ok()) acks++; if (phaseB) putsNachB.push(x.status()); } });
  await p.getByRole('button', { name: 'Aufnahme starten', exact: true }).click();
  await p.getByRole('heading', { name: 'Aufnahme läuft' }).waitFor();
  await p.waitForFunction(() => window.generated.length >= 2); await p.waitForTimeout(600);
  ok(acks >= 2, `R2: vor Ablauf ${acks} Abschnitte vom Server bestätigt`);
  const key = await p.evaluate((a) => localStorage.getItem(`podcast-studio:${a}:sprecher`), A);
  ok(key === 'Sprecherin A' && (await p.evaluate(() => localStorage.getItem('podcast-studio:sprecher'))) === null, 'Sprecherpräferenz unter podcast-studio:<userId>:sprecher, kein globaler Schlüssel');
  const trackR2 = db.all('tracks').at(-1).id;
  db.sql.prepare('DELETE FROM sessions WHERE user_id=?').run(A); // Sitzungszeile im Test gelöscht
  await p.getByTestId('studio-reauth').waitFor({ timeout: 15000 });
  const n0 = await p.evaluate(() => window.generated.length);
  await p.waitForFunction((n) => window.generated.length >= n + 2, n0, { timeout: 15000 });
  ok(await p.getByRole('heading', { name: 'Aufnahme läuft' }).count() === 1, 'R2: Aufnahme läuft unter der Überlagerung weiter (Engine gemountet)');
  let lokal = await idb(p);
  ok(lokal.keys.filter((k) => k[0] === trackR2).length >= 2 && lokal.metas.find((m) => m.trackId === trackR2)?.userId === A, 'R2: Abschnitte ohne Sitzung lokal in IndexedDB, Meta mit userId A');
  await p.screenshot({ path: path.join(out, 'r2-reauth-1280.png') });
  await p.setViewportSize({ width: 390, height: 844 }); await p.screenshot({ path: path.join(out, 'r2-reauth-390.png') }); await p.setViewportSize({ width: 1280, height: 860 });

  // falsches Konto
  phaseB = true;
  const empfangenVorB = db.get('tracks', trackR2).receivedChunks;
  const bSitzungen = () => db.sql.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(B).n;
  const bVorher = bSitzungen(); // B hat eine Sitzung vom Einlösen der Einladung (Skript), die bleibt

  await p.getByLabel('E-Mail').fill('b@example.test'); await p.getByLabel('Kennwort').fill(PW_B);
  await p.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await p.getByText('Falsches Konto').waitFor({ timeout: 15000 });
  await p.waitForTimeout(5000);
  results.push({ authLog });
  ok(bSitzungen() === bVorher && authLog.filter((x) => x.startsWith('POST')).slice(-2).join() === 'POST /auth/login 200,POST /auth/logout 204', 'Falsches Konto: im Studio erzeugte Sitzung von B sofort wieder entfernt (Logout 204)');
  ok(db.get('tracks', trackR2).receivedChunks === empfangenVorB && putsNachB.length === 0, `Falsches Konto: keine Abschnitts-Uploads (PUTs ${putsNachB.length}, Server ${empfangenVorB})`);
  ok(await p.getByTestId('studio-reauth').isVisible(), 'Falsches Konto: Überlagerung bleibt (keine Ansicht/Fortsetzung)');
  await p.screenshot({ path: path.join(out, 'r2-falsches-konto-1280.png') });
  phaseB = false;

  // richtiges Konto
  await p.getByLabel('E-Mail').fill('a@example.test'); await p.getByLabel('Kennwort').fill(PW_A);
  await p.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await p.getByTestId('studio-reauth').waitFor({ state: 'detached', timeout: 15000 });
  await p.waitForFunction(() => window.generated.length >= 1); await p.waitForTimeout(4500);
  await p.getByRole('button', { name: 'Aufnahme beenden' }).click();
  await p.getByRole('heading', { name: 'Aufnahme gesichert' }).waitFor({ timeout: 60000 });
  const tR2 = await fertigeSpur(trackR2);
  const erwartet = await genSha(p), anzahl = await p.evaluate(() => window.generated.length);
  ok(tR2.status === 'ready' && tR2.receivedChunks === anzahl && rohSha(tR2) === erwartet, `R2: lückenlos – ${anzahl} Abschnitte, roh-SHA identisch zu allen erzeugten Blobs, Dauer ${tR2.durationMs} ms`);
  ok(tR2.durationMs >= (anzahl - 1) * 4000 - 1500, 'R2: ffprobe-Dauer deckt alle Abschnitte ab');
  execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(tmp, 'medien', p1, tR2.recordingId, tR2.id, 'original.webm'), '-f', 'null', '-']);
  ok(navs === navsVorStart, `R2: keine Navigation/kein Neuladen während Ablauf und Reauth (${navs - navsVorStart})`);
  ok((await idb(p)).metas.every((m) => m.trackId !== trackR2), 'R2: lokale Kopie nach Serverannahme aufgeräumt');
  await p.close();

  // ---------- R1: A bricht ab (Tab hart geschlossen), B sieht keine Wiederherstellung; A birgt vollständig ----------
  const p2 = await neuesProjekt('PA7 Absturz');
  p = await c.newPage(); watch(p);
  await p.goto(base + '/studio/' + p2);
  await p.getByRole('heading', { name: 'Bereit zur Aufnahme' }).waitFor();
  await p.getByRole('button', { name: 'Aufnahme starten', exact: true }).click();
  await p.getByRole('heading', { name: 'Aufnahme läuft' }).waitFor();
  await p.waitForFunction(() => window.generated.length >= 1); await p.waitForTimeout(500);
  await c.setOffline(true);
  await p.waitForFunction(() => window.generated.length >= 3, null, { timeout: 15000 }); await p.waitForTimeout(500);
  const erwartetR1 = await genSha(p);
  const trackR1 = db.all('tracks').at(-1).id;
  await p.close({ runBeforeUnload: false }); await c.setOffline(false);
  await logout(); await login('b@example.test', PW_B);
  p = await c.newPage(); watch(p);
  await p.goto(base + '/'); await p.waitForLoadState('networkidle'); await p.waitForTimeout(1000);
  ok(await p.getByRole('region', { name: 'Unterbrochene Aufnahmen' }).count() === 0 && !(await p.locator('body').innerText()).includes('PA7 Absturz'), 'R1: Konto B sieht auf der Startseite keine Wiederherstellung von A');
  const pB = await neuesProjekt('B eigenes');
  await p.goto(base + '/studio/' + pB); await p.getByRole('heading', { name: 'Bereit zur Aufnahme' }).waitFor(); await p.waitForTimeout(1500);
  ok(await p.getByRole('region', { name: 'Wiederherstellung' }).count() === 0, 'R1: Konto B sieht im eigenen Studio keine fremde Wiederherstellung');
  ok((await p.getByLabel('Name auf der Spur').inputValue()) === '', 'Sprecher: B erhält nicht den Namen von A');
  lokal = await idb(p);
  ok(lokal.metas.some((m) => m.trackId === trackR1 && m.userId === A) && lokal.keys.some((k) => k[0] === trackR1), 'R1: A-Abschnitte und Meta nach B-Anmeldung unverändert vorhanden');
  ok(await p.evaluate((t) => localStorage.getItem('podcast-studio:nicht-lokal:' + t) !== null, trackR1), 'R1: Erzeugt-Marker von A unangetastet');
  await p.screenshot({ path: path.join(out, 'r1-konto-b-1280.png') });
  await p.close();
  await logout(); await login('a@example.test', PW_A);
  p = await c.newPage(); watch(p);
  await p.goto(base + '/studio/' + p2);
  const w = p.getByRole('region', { name: 'Wiederherstellung' }); await w.waitFor({ timeout: 15000 });
  await w.getByRole('button', { name: 'Hochladen & abschließen' }).click();
  await w.getByText('Unterbrochene Aufnahme übertragen', { exact: true }).waitFor({ timeout: 30000 });
  const tR1 = await fertigeSpur(trackR1);
  ok(tR1.status === 'ready' && rohSha(tR1) === erwartetR1, 'R1: A birgt nach erneuter Anmeldung vollständig (roh-SHA identisch)');
  await p.close();

  // ---------- R4: Alt-Einträge ohne userId; fremde lokale Einträge ----------
  const webm = path.join(tmp, 'ton.webm');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libopus', '-f', 'webm', webm]);
  const bytes = [...readFileSync(webm)];
  const p3 = await neuesProjekt('PA7 Altbestand');
  const anl = await (await api('POST', `/projects/${p3}/recordings`, { title: 'Alt', kind: 'audio', mimeType: 'audio/webm;codecs=opus', participantName: 'Alt', startedAtMs: Date.now() })).json();
  const altId = anl.track.id;
  for (const [t, id] of [['projects', p3], ['recordings', anl.recording.id], ['tracks', altId]]) { const row = db.get(t, id); delete row.ownerId; db.put(t, row); } // wie vor der Migration
  p = await c.newPage(); watch(p);
  await p.goto(base + '/'); await p.waitForLoadState('networkidle');
  await p.evaluate(async ({ altId, bytes, B }) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'audio/webm' });
    const db = await new Promise((res) => { const q = indexedDB.open('podcast-studio-aufnahme'); q.onsuccess = () => res(q.result); });
    const tx = db.transaction(['meta', 'chunks'], 'readwrite');
    const m = (trackId, title, userId) => ({ trackId, ...(userId ? { userId } : {}), projectId: 'x', title, mimeType: 'audio/webm;codecs=opus', startedAtMs: Date.now() - 600000, chunkCount: 1, lastChunkAtMs: Date.now() - 600000, durationMs: 3000 });
    tx.objectStore('meta').put(m(altId, 'Alt-Eintrag', null)); tx.objectStore('chunks').put(blob, [altId, 0]);
    tx.objectStore('meta').put(m('unbekannt-alt', 'Unbekannt-Alt', null)); tx.objectStore('chunks').put(blob, ['unbekannt-alt', 0]);
    tx.objectStore('meta').put(m('b-lokal', 'B-Lokal', B)); tx.objectStore('chunks').put(blob, ['b-lokal', 0]);
    await new Promise((r) => { tx.oncomplete = r; });
  }, { altId, bytes, B });
  const banner = async () => { await p.goto(base + '/'); await p.waitForLoadState('networkidle'); await p.waitForTimeout(1200); return p.locator('body').innerText(); };
  let txt = await banner();
  ok(!/Alt-Eintrag|Unbekannt-Alt|B-Lokal/.test(txt), 'R4: vor legacy:claim sieht A weder Alt-Einträge noch B-Eintrag');
  ok(legacyClaim(app.ctx, A, true).counts.tracks >= 1, 'R4: legacy:claim --confirm ordnet Altbestand A zu');
  txt = await banner();
  ok(/Alt-Eintrag/.test(txt) && !/Unbekannt-Alt|B-Lokal/.test(txt), 'R4: nach Claim sieht A nur den eigenen Alt-Eintrag');
  await p.screenshot({ path: path.join(out, 'r4-konto-a-1280.png') });
  await p.close(); await logout(); await login('b@example.test', PW_B);
  p = await c.newPage(); watch(p);
  txt = await banner();
  ok(/B-Lokal/.test(txt) && !/Alt-Eintrag|Unbekannt-Alt/.test(txt), 'R4: Mitglied B sieht Alt-Eintrag von A nicht, nur eigenen Eintrag');
  await p.close(); await logout(); await login('a@example.test', PW_A);
  p = await c.newPage(); watch(p);
  await banner();
  const eintrag = p.locator('.start-banner__eintrag', { hasText: 'Alt-Eintrag' });
  await eintrag.getByRole('button', { name: 'Wiederherstellen' }).click();
  await eintrag.getByText(/Wiederhergestellt/).waitFor({ timeout: 30000 });
  const tAlt = await fertigeSpur(altId);
  ok(tAlt.status === 'ready' && tAlt.ownerId === A && rohSha(tAlt) === sha(readFileSync(webm)), 'R4: eigener Alt-Eintrag nach Claim bergbar, Datei byteidentisch');
  lokal = await idb(p);
  ok(['unbekannt-alt', 'b-lokal'].every((id) => lokal.metas.some((m) => m.trackId === id) && lokal.keys.some((k) => k[0] === id)), 'R4: fremde und unbestätigte lokale Einträge weder gelöscht noch verändert');
  await p.close();

  // ---------- R7 (Ergänzung): Cookiewechsel in anderem Tab (Login B, dann Einladungslink C) während A aufnimmt ----------
  {
    // Tab 2 hat die Anmeldeseite schon offen, bevor A sich anmeldet (sonst leitet /anmelden mit Sitzung weiter).
    await logout();
    const t2b = await c.newPage(); watch(t2b);
    await t2b.goto(base + '/anmelden'); await t2b.getByLabel('E-Mail').waitFor();
    await login('a@example.test', PW_A);
    const pX = await neuesProjekt('PA7 Zwei Tabs');
    const t1 = await c.newPage(); watch(t1);
    let navs1 = 0; t1.on('framenavigated', (f) => { if (f === t1.mainFrame()) navs1++; });
    const puts = []; t1.on('response', (x) => { if (x.request().method() === 'PUT' && /chunks/.test(x.url())) puts.push(x.status()); });
    await t1.goto(base + '/studio/' + pX);
    await t1.getByRole('heading', { name: 'Bereit zur Aufnahme' }).waitFor();
    const navsStart = navs1;
    await t1.getByRole('button', { name: 'Aufnahme starten', exact: true }).click();
    await t1.getByRole('heading', { name: 'Aufnahme läuft' }).waitFor();
    await t1.waitForFunction(() => window.generated.length >= 2); await t1.waitForTimeout(600);
    const trackX = db.all('tracks').at(-1).id;
    ok(puts.filter((x) => x === 200).length >= 2, 'R7: Tab 1 (A) nimmt auf, Abschnitte bestätigt');

    const fremdWechsel = async (name, t2, wechsel) => {
      await wechsel(t2);
      const putsVor = puts.length, empfVor = db.get('tracks', trackX).receivedChunks, genVor = await t1.evaluate(() => window.generated.length);
      await t1.getByTestId('studio-reauth').waitFor({ timeout: 20000 });
      await t1.getByText('anderes Konto angemeldet').waitFor({ timeout: 5000 });
      await t1.waitForFunction((n) => window.generated.length >= n + 2, genVor, { timeout: 15000 }); await t1.waitForTimeout(4500);
      const p404 = puts.slice(putsVor).filter((x) => x === 404).length, pOk = puts.slice(putsVor).filter((x) => x === 200).length;
      ok(p404 <= 1 && pOk === 0 && db.get('tracks', trackX).receivedChunks === empfVor, `R7 ${name}: höchstens eine Besitz-404, danach kein weiterer Sendeversuch (PUTs seit Wechsel: ${puts.length - putsVor}), Server unverändert`);
      ok(await t1.getByRole('heading', { name: 'Aufnahme läuft' }).count() === 1, `R7 ${name}: Aufnahme läuft weiter`);
      const l = await idb(t1);
      ok(l.keys.filter((k) => k[0] === trackX).length >= 2 && l.metas.find((m) => m.trackId === trackX)?.userId === A, `R7 ${name}: ungesicherte Abschnitte lokal (IndexedDB) unter userId A`);
      await t2.goto(base + '/'); await t2.waitForLoadState('networkidle'); await t2.waitForTimeout(1000);
      const txt2 = await t2.locator('body').innerText();
      results.push({ name, tab2: txt2.slice(0, 1500) });
      ok(!/PA7 Zwei Tabs|PA7 Absturz|PA7 Ablauf|PA7 Altbestand|Alt-Eintrag|Unbekannt-Alt/.test(txt2) && (name === 'login-b' || !/B-Lokal|B eigenes/.test(txt2)), `R7 ${name}: Tab 2 zeigt keine Projekte/Recovery anderer Konten (nur eigene)`);
      await t1.screenshot({ path: path.join(out, `r7-${name}-1280.png`) });
      await t1.getByLabel('E-Mail').fill('a@example.test'); await t1.getByLabel('Kennwort').fill(PW_A);
      await t1.getByRole('button', { name: 'Anmelden', exact: true }).click();
      await t1.getByTestId('studio-reauth').waitFor({ state: 'detached', timeout: 15000 });
      await t1.waitForFunction(() => true); await t1.waitForTimeout(3000);
      ok(db.get('tracks', trackX).receivedChunks > empfVor, `R7 ${name}: nach Reauth mit A wird nachgesendet`);
      return t2;
    };
    await fremdWechsel('login-b', t2b, async (t2) => {
      await t2.getByLabel('E-Mail').fill('b@example.test'); await t2.getByLabel('Kennwort').fill(PW_B);
      await Promise.all([t2.waitForURL((u) => !/anmelden/.test(u.pathname)), t2.getByRole('button', { name: 'Anmelden', exact: true }).click()]);
    });
    await t2b.close();
    const invC = await (await api('POST', '/admin/invites', { planId: 'free', email: 'c@example.test' })).json();
    const t2c = await c.newPage(); watch(t2c);
    await fremdWechsel('einladung-c', t2c, async (t2) => {
      await t2.goto(ORIGIN + invC.url);
      await t2.getByLabel('Anzeigename').fill('Konto C');
      await t2.getByLabel('Neues Kennwort').fill('pa7-test-kennwort-c'); await t2.getByLabel('Kennwort wiederholen').fill('pa7-test-kennwort-c');
      await Promise.all([t2.waitForURL((u) => !/einladung/.test(u.pathname), { timeout: 20000 }), t2.getByRole('button', { name: 'Konto anlegen' }).click()]);
    });
    await t2c.close();
    await t1.getByRole('button', { name: 'Aufnahme beenden' }).click();
    await t1.getByRole('heading', { name: 'Aufnahme gesichert' }).waitFor({ timeout: 60000 });
    const tX = await fertigeSpur(trackX), nX = await t1.evaluate(() => window.generated.length);
    ok(tX.status === 'ready' && tX.receivedChunks === nX && rohSha(tX) === (await genSha(t1)), `R7: lückenlos nach zwei fremden Wechseln – ${nX} Abschnitte, roh-SHA identisch`);
    ok(navs1 === navsStart, 'R7: Tab 1 ohne Navigation/Neuladen');
    await t1.close();
  }

  // ---------- R6: Start bei erreichtem Speicherkontingent ----------
  const plaene = await (await api('GET', '/admin/plans')).json();
  const plan = plaene.find((x) => x.id === db.sql.prepare('SELECT plan_id FROM users WHERE id=?').get(A).plan_id);
  const { id: planId, ...rest } = plan;
  ok((await api('PUT', '/admin/plans/' + planId, { ...rest, storageBytes: 1 })).ok(), 'R6: Testplan von A auf 1 Byte Speicher begrenzt (nur Temp-DB)');
  p = await c.newPage(); watch(p);
  await p.goto(base + '/studio/' + p1);
  await p.getByRole('heading', { name: 'Bereit zur Aufnahme' }).waitFor();
  const vorR6 = db.all('tracks').length, idbVorR6 = (await idb(p)).metas.length;
  await p.getByRole('button', { name: 'Aufnahme starten', exact: true }).click();
  await p.getByText('Speicherkontingent erreicht').waitFor({ timeout: 15000 });
  const r6 = await p.locator('body').innerText();
  ok(/Belegt .* von 1 B/.test(r6) && !/Aufnahme nicht möglich/.test(r6) && db.all('tracks').length === vorR6, 'R6: eigener Zustand mit Verbrauchsangabe, keine Spur angelegt, kein generischer Fehler');
  ok((await idb(p)).metas.length === idbVorR6, 'R6: nichts Neues lokal angelegt');
  await p.screenshot({ path: path.join(out, 'r6-kontingent-1280.png') });
  await p.close();

  ok(fehler.length === 0, 'keine Seiten-/Konsolenfehler' + (fehler.length ? ': ' + fehler.join(' | ') : ''));
} finally {
  writeFileSync(path.join(out, 'pa7-results.json'), JSON.stringify({ results, fehler }, null, 1));
  await browser?.close();
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
}
