// PA8-Reviewfixes R1–R4: Browserrepros gegen den echten Server (Port 8874, Temp-DB/-Medien) + lokalen ASR-Testdienst.
// Aufruf aus App/: node test/ui/pa8-reviewfixes.mjs <build-root> <build-podcast> <ausgabeordner>
import { chromium } from '@playwright/test';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDB } from '../../server/db.mjs';
import { migrate } from '../../server/migrate.mjs';
import { ownerCreate } from '../../server/accounts.mjs';
import { createStudioServer } from '../../server/index.mjs';

const [buildRoot, buildPodcast, out] = process.argv.slice(2).map((p) => path.resolve(p));
const PORT = 8874, B = `http://127.0.0.1:${PORT}`, PW = 'pa8-fix-eigentuemer-1';
const results = [], konsole = [];
const ok = (b, msg) => { results.push({ pass: !!b, msg }); console.log(b ? 'OK  ' : 'FAIL', msg); if (!b) throw Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser, app, dir, medien, asrDienst, seite;

const dienst = { status: 200, delayMs: 0, calls: 0 };
async function asrStart() {
  asrDienst = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer pa8-test-fixture') { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/v1/health') { res.end(JSON.stringify({ ok: true, model: 'pa8-testdienst', device: 'cuda', timestamps: 'segment', maxAudioSeconds: null })); return; }
    let bytes = 0; for await (const b of req) bytes += b.length;
    dienst.calls++;
    if (dienst.delayMs) await sleep(dienst.delayMs);
    if (dienst.status !== 200) { res.writeHead(dienst.status); res.end('{}'); return; }
    const dauer = Math.max(0, (bytes - 44) / 32000), segments = [];
    for (let t = 0, n = 0; t < dauer - 0.05; t += 4, n++) segments.push({ start: t, end: Math.min(dauer, t + 4), text: `Segment ${n}` });
    res.end(JSON.stringify({ text: segments.map((s) => s.text).join(' '), language: 'de', model: 'pa8-testdienst', device: 'cuda', timestamps: 'segment', segments }));
  });
  await new Promise((r) => asrDienst.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${asrDienst.address().port}`;
}
async function serverStart({ asr, base = '', dist = buildRoot }) {
  app = await createStudioServer({
    origins: B, cookieInsecure: true, dataDir: dir, base, dist,
    asrEnv: asr ? { STUDIO_ASR_DRIVER: 'studio-asr-v1', STUDIO_ASR_URL: asr, STUDIO_ASR_TOKEN: 'pa8-test-fixture' } : {},
  });
  await new Promise((res, rej) => { app.server.once('error', rej); app.server.listen(PORT, '127.0.0.1', res); });
}
async function serverStop() { if (app) { app.server.closeAllConnections(); await app.close(); } app = null; }

const ffmpeg = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const sha = async (f) => createHash('sha256').update(await readFile(f)).digest('hex');
const ueberlauf = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function bild(p, name, ziel) {
  if (ziel) await ziel.scrollIntoViewIfNeeded();
  await p.screenshot({ path: path.join(out, `${name}-1280.png`), fullPage: true });
  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(200);
  ok(await ueberlauf(p), `${name}: 390 px ohne horizontalen Überlauf`);
  await p.screenshot({ path: path.join(out, `${name}-390.png`), fullPage: true });
  await p.setViewportSize({ width: 1280, height: 800 });
}
const call = (p, method, pfad, body, headers = {}) => p.evaluate(async ([m, u, b, h]) => {
  const base = document.baseURI.includes('/podcast/') ? '/podcast' : '';
  const r = await fetch(location.origin + base + '/api' + u, { method: m, credentials: 'same-origin', headers: { 'X-Studio': '1', 'content-type': 'application/json', ...h }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, body: j };
}, [method, pfad, body, headers]);
const spuren = async (p, projekt) => (await call(p, 'GET', `/projects/${projekt}`)).body.recordings.flatMap((r) => r.tracks.map((t) => ({ ...t, recordingId: r.id })));
async function bereit(p, projekt, name) {
  for (let i = 0; i < 120; i++) {
    const t = (await spuren(p, projekt)).find((x) => x.participantName === name);
    if (t?.status === 'ready') return t;
    if (t?.status === 'failed') throw Error(`Spur ${name} failed: ${t.error}`);
    await sleep(500);
  }
  throw Error(`Spur ${name} nicht bereit`);
}
async function rohSha(projekt, t) {
  const d = path.join(dir, 'medien', projekt, t.recordingId, t.id);
  const f = (await readdir(d)).find((x) => x.startsWith('roh.'));
  return sha(path.join(d, f));
}
async function formular(p, projekt, datei, name) {
  await p.goto(`${B}/hochladen?projekt=${projekt}`);
  await p.locator('#hochladen-datei').setInputFiles(datei);
  await p.getByText(/Abschnitt\(e\)/).waitFor();
  await p.locator('#hochladen-name').fill(name);
  await p.locator('#hochladen-titel').fill(name);
}
const lsSchluessel = (id) => `podcast-studio:${id}:uploads`;
const lsLesen = (p, id) => p.evaluate((k) => localStorage.getItem(k), lsSchluessel(id));
const lsSetzen = (p, id, v) => p.evaluate(([k, w]) => localStorage.setItem(k, w), [lsSchluessel(id), JSON.stringify(v)]);
const spur = (p, name) => p.locator('.projekte-spur', { has: p.locator('.projekte-spur__titel', { hasText: name }) });

try {
  await mkdir(out, { recursive: true });
  dir = await mkdtemp(path.join(os.tmpdir(), 'pa8fix-daten-'));
  medien = await mkdtemp(path.join(os.tmpdir(), 'pa8fix-medien-'));
  // A: 125 s Stereo-WAV (24.000.078 Bytes, 3 Abschnitte). B1/B2: gleicher Name, gleiche Größe, gleiches mtime, andere Bytes.
  const A = path.join(medien, 'lang.wav'), B1 = path.join(medien, 'vorne', 'lang.wav'), B2 = path.join(medien, 'hinten', 'lang.wav');
  const kurz = path.join(medien, 'kurz.mp3');
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=330:d=125', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', A);
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=440:d=20', '-c:a', 'libmp3lame', '-b:a', '64k', kurz);
  await mkdir(path.dirname(B1)); await mkdir(path.dirname(B2));
  const roh = await readFile(A);
  const b1 = Buffer.from(roh); for (let i = 100; i < b1.length; i++) b1[i] ^= 127; // Reviewer-Repro: alles ab Byte 100 anders
  const b2 = Buffer.from(roh); for (let i = b2.length - 4096; i < b2.length; i++) b2[i] ^= 85; // nur hinten (letzter Abschnitt)
  await writeFile(B1, b1); await writeFile(B2, b2);
  for (const f of [A, B1, B2]) await utimes(f, 1700000000, 1700000000);
  ok(roh.length === b1.length && roh.length === b2.length && roh.subarray(0, 8388608).equals(b2.subarray(0, 8388608)),
    'Fixture: A/B1/B2 gleiche Größe + mtime + Name; B2 erster Abschnitt identisch mit A');

  const db = openDB(path.join(dir, 'studio.sqlite')); await migrate(db, path.join(dir, 'studio.sqlite'));
  const setup = ownerCreate({ db, base: '' }, 'owner@pa8fix.test', 'Pa Acht'); db.close();

  browser = await chromium.launch();
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await c.newPage(); seite = p; p.setDefaultTimeout(20000);
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) konsole.push(`${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => konsole.push(`PAGEERROR ${e}`));
  p.on('dialog', (d) => d.accept());
  let puts = 0; p.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/chunks/')) puts++; });

  await serverStart({ asr: await asrStart() });
  await p.goto(B + '/anmelden');
  await call(p, 'POST', `/auth/token/${setup.url.split('/einladung/')[1]}`, { password: PW });
  const projekt = (await call(p, 'POST', '/projects', { title: 'Fix A privat' })).body.id;
  const uid = (await call(p, 'GET', '/session')).body.user.id;

  // ── Normalfall mit Fingerabdruck: MP3 komplett, Server-SHA = Datei ──
  await formular(p, projekt, kurz, 'Kurz');
  await p.getByRole('button', { name: 'Hochladen', exact: true }).click();
  await p.getByText(/Fertig verarbeitet|Übertragen\. Der Server/).waitFor();
  const tk = await bereit(p, projekt, 'Kurz');
  ok(await rohSha(projekt, tk) === await sha(kurz), 'Normalfall: Server-Rohdatei SHA-256 = lokale Datei');

  // ── Abbruch während der Prüfung: nichts angelegt, nichts gesendet ──
  const vorher = (await spuren(p, projekt)).length; puts = 0;
  await formular(p, projekt, A, 'Abbruch');
  await p.evaluate(() => { const o = crypto.subtle.digest.bind(crypto.subtle); crypto.subtle.digest = async (...a) => { await new Promise((r) => setTimeout(r, 600)); return o(...a); }; });
  await p.getByRole('button', { name: 'Hochladen', exact: true }).click();
  await p.getByText(/Datei wird geprüft \(Prüfsumme\)/).waitFor();
  await bild(p, '01-pruefung-laeuft');
  await p.getByRole('button', { name: 'Prüfung abbrechen' }).click();
  await p.getByText(/Prüfung abgebrochen – es wurde nichts angelegt/).waitFor();
  ok((await spuren(p, projekt)).length === vorher && puts === 0, 'Abbruch während Prüfung: keine Spur angelegt, kein PUT');
  ok(await p.locator('#hochladen-name').inputValue() === 'Abbruch', 'Abbruch während Prüfung: Formular und Eingaben bleiben erhalten');

  // ── R1: A beginnen, nach Abschnitt 1 anhalten, neu laden ──
  await p.reload();
  await p.route('**/api/tracks/*/chunks/*', async (r) => { await sleep(1200); await r.continue().catch(() => {}); });
  await formular(p, projekt, A, 'Kollision');
  await p.getByRole('button', { name: 'Hochladen', exact: true }).click();
  await p.getByText('Sendet Abschnitt 2 von 3').waitFor();
  await p.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await p.getByText(/Angehalten nach 1/).waitFor();
  await p.unroute('**/api/tracks/*/chunks/*');
  const tc = (await spuren(p, projekt)).find((t) => t.participantName === 'Kollision');
  const eintrag = JSON.parse(await lsLesen(p, uid)).find((e) => e.trackId === tc.id);
  ok(eintrag?.v === 2 && /^[0-9a-f]{64}$/.test(eintrag.fingerprint) && eintrag.chunkCount === 3, 'Fingerabdruck (v2, 3 Abschnitte) vor dem ersten Abschnitt persistiert');
  await p.reload();
  const zeile = p.locator('.hochladen__offen-zeile', { hasText: 'Kollision' });
  await zeile.getByText('1 von 3 Abschnitten').waitFor();
  await bild(p, '02-unterbrochen-geprueft', zeile);

  for (const [name, datei] of [['B1 (ab Byte 100 anders)', B1], ['B2 (nur letzter Abschnitt anders)', B2]]) {
    puts = 0;
    await p.locator(`#hochladen-offen-${tc.id}`).setInputFiles(datei);
    await zeile.getByText(/Inhalt stimmt nicht mit der begonnenen Datei überein/).waitFor();
    const s = (await call(p, 'GET', `/tracks/${tc.id}`)).body;
    ok(puts === 0 && s.status === 'uploading' && s.receivedChunks === 1, `R1 ${name}: abgewiesen, 0 PUT, Server weiter uploading mit 1 Abschnitt`);
  }
  await bild(p, '03-falscher-inhalt-abgewiesen', zeile);

  // Richtige Datei A (nach Inhaltsprüfung) setzt fort; Ergebnis = A, kein Hybrid.
  puts = 0;
  await p.locator(`#hochladen-offen-${tc.id}`).setInputFiles(A);
  await p.getByText(/Fertig verarbeitet|Übertragen\. Der Server/).waitFor({ timeout: 30000 });
  const tr = await bereit(p, projekt, 'Kollision');
  const hs = { A: await sha(A), B1: await sha(B1), B2: await sha(B2), server: await rohSha(projekt, tr) };
  console.log('SHA', JSON.stringify(hs));
  ok(hs.server === hs.A && puts === 2, 'R1 abgesicherter Resume: genau 2 PUT (Abschnitt 2+3), Server-SHA = A (kein Hybrid mit B1/B2)');
  ok(!(await lsLesen(p, uid))?.includes(tc.id), 'Nach Abschluss Eintrag aus lokaler Liste entfernt');

  // ── Alt-Eintrag ohne Fingerabdruck: kein Fortsetzen, Neu hochladen ohne Spur zu löschen ──
  await p.route('**/api/tracks/*/chunks/*', async (r) => { await sleep(1500); await r.continue().catch(() => {}); });
  await formular(p, projekt, A, 'Alt');
  await p.getByRole('button', { name: 'Hochladen', exact: true }).click();
  await p.getByText('Sendet Abschnitt 2 von 3').waitFor();
  await p.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await p.getByText(/Angehalten nach 1/).waitFor();
  await p.unroute('**/api/tracks/*/chunks/*');
  const ta = (await spuren(p, projekt)).find((t) => t.participantName === 'Alt');
  const v2 = JSON.parse(await lsLesen(p, uid)).find((e) => e.trackId === ta.id);
  const { v: _v, fingerprint: _f, chunkCount: _c, ...alt } = v2;
  await lsSetzen(p, uid, [alt]);
  await p.reload();
  const az = p.locator('.hochladen__offen-zeile', { hasText: 'Alt' });
  await az.getByText(/Begonnen ohne Inhaltsprüfung/).waitFor();
  ok(await p.locator(`#hochladen-offen-${ta.id}`).count() === 0, 'Alt-Eintrag: keine Dateiwahl zum Fortsetzen');
  await bild(p, '04-alt-eintrag', az);
  const anderes = (await call(p, 'POST', '/projects', { title: 'Anderes Projekt' })).body.id;
  await p.reload();
  await p.locator('#hochladen-projekt').selectOption(anderes);
  await az.getByRole('button', { name: 'Neu hochladen' }).click();
  ok(await p.locator('#hochladen-projekt').inputValue() === projekt, 'Alt-Eintrag: „Neu hochladen“ wählt das ursprüngliche Projekt vor');
  const ta2 = (await call(p, 'GET', `/tracks/${ta.id}`)).body;
  ok(ta2.status === 'uploading' && ta2.receivedChunks === 1, 'Alt-Eintrag: bestehende Spur unverändert (nicht gelöscht, nichts gesendet)');

  // ── R2: beschädigte Einträge ──
  const fremdKey = 'podcast-studio:anderes-konto:uploads', fremdWert = '[{"trackId":"y","title":{"bad":1}}]';
  await p.evaluate(([k, w]) => localStorage.setItem(k, w), [fremdKey, fremdWert]);
  await lsSetzen(p, uid, [{ trackId: 'x', title: { bad: true }, name: 'x' }, { ...v2, size: 'gross' }, alt, 7, null]);
  await p.reload();
  await p.getByText(/4 beschädigte Einträge/).waitFor();
  ok(!(await p.locator('body').innerText()).includes('Unexpected Application Error') && await az.isVisible(), 'R2: Seite rendert, gültiger Eintrag sichtbar, 4 beschädigte ignoriert');
  await bild(p, '05-beschaedigt', p.getByText(/4 beschädigte Einträge/));
  await p.getByRole('button', { name: 'Verwerfen' }).click();
  const nachher = JSON.parse(await lsLesen(p, uid));
  ok(nachher.length === 1 && nachher[0].trackId === ta.id && await p.evaluate((k) => localStorage.getItem(k), fremdKey) === fremdWert,
    'R2: Verwerfen entfernt nur beschädigte eigene Einträge, anderer Kontoschlüssel unangetastet');
  await lsSetzen(p, uid, { kein: 'array' }); await p.reload();
  await p.getByText(/Ein beschädigter Eintrag/).waitFor();
  ok(true, 'R2: Nicht-Array im Speicher → Hinweis statt Absturz');
  await lsSetzen(p, uid, [v2]);

  // ── R4: Pollfehler sichtbar + Erholung; transcript_edited-Text bei R7 ──
  let j = (await call(p, 'POST', `/tracks/${tr.id}/transcription`, {}, { 'Idempotency-Key': 'fix-initial' })).body;
  for (let i = 0; i < 120 && (await call(p, 'GET', `/jobs/${j.id}`)).body.status !== 'succeeded'; i++) await sleep(500);
  const vor = (await call(p, 'GET', `/tracks/${tr.id}/transcript`)).body;
  dienst.delayMs = 4000;
  j = (await call(p, 'POST', `/tracks/${tr.id}/transcription`, { replaceEdited: true }, { 'Idempotency-Key': 'fix-r7' })).body;
  let polls = 0;
  await p.route('**/api/jobs/*', async (r) => { if (r.request().method() === 'GET') { polls++; await r.abort('connectionfailed'); } else await r.continue(); });
  await p.goto(`${B}/projekte/${projekt}?aufnahme=${tr.recordingId}`);
  await spur(p, 'Kollision').getByText(/Aktualisierung fehlgeschlagen/).waitFor();
  ok(polls >= 1, 'R4: Pollfehler wird sichtbar angezeigt (veralteter Stand)');
  await bild(p, '06-pollfehler', spur(p, 'Kollision').getByText(/Aktualisierung fehlgeschlagen/));
  await call(p, 'PATCH', `/tracks/${tr.id}/transcript`, { revision: vor.revision, segments: vor.segments.map((s, i) => ({ id: s.id, text: i === 0 ? 'R7 erhalten' : s.text })) });
  await sleep(5000);
  await p.unroute('**/api/jobs/*');
  await spur(p, 'Kollision').getByRole('button', { name: 'Jetzt aktualisieren' }).click();
  await spur(p, 'Kollision').getByText(/Letzte Neu-Transkription fehlgeschlagen: .*neuere Bearbeitung/).waitFor();
  ok(await spur(p, 'Kollision').getByText(/Aktualisierung fehlgeschlagen/).count() === 0, 'R4: nach Erholung verschwindet der Hinweis');
  ok((await call(p, 'GET', `/tracks/${tr.id}/transcript`)).body.segments[0].text === 'R7 erhalten', 'R4/R7: Text nennt neuere Bearbeitung; Bearbeitung erhalten');
  await bild(p, '07-r7-text', spur(p, 'Kollision').getByText(/Letzte Neu-Transkription/));

  // ── R3: Kontowechsel A → B ──
  const aWert = await lsLesen(p, uid);
  const inv = (await call(p, 'POST', '/admin/invites', { email: 'b@pa8fix.test', planId: 'free' })).body;
  await call(p, 'POST', '/auth/logout');
  await call(p, 'POST', '/auth/token/' + inv.url.split('/einladung/')[1], { password: PW, displayName: 'B' });
  const bid = (await call(p, 'GET', '/session')).body.user.id;
  await lsSetzen(p, bid, [{ ...v2, title: 'FREMDER EINTRAG' }]);
  await p.goto(B + '/hochladen');
  await p.getByText(/Unbekannte Spur: gehört nicht zu diesem Konto/).waitFor();
  const text = await p.locator('body').innerText();
  ok(!text.includes('FREMDER EINTRAG') && !text.includes('lang.wav') && await p.locator(`#hochladen-offen-${ta.id}`).count() === 0,
    'R3: fremder Eintrag (Server 404) ohne Titel/Dateiname und nicht fortsetzbar');
  ok(await lsLesen(p, uid) === aWert && JSON.parse(await lsLesen(p, bid)).length === 1, 'R3: A-Einträge unangetastet, B-Eintrag nicht automatisch gelöscht');
  await bild(p, '08-fremder-eintrag', p.getByText(/Unbekannte Spur/));
  await p.getByRole('button', { name: 'Aus Liste entfernen' }).click();
  ok(await lsLesen(p, bid) === null && await lsLesen(p, uid) === aWert, 'R3: Entfernen betrifft nur B-Schlüssel');
  ok((await call(p, 'GET', `/tracks/${ta.id}`)).status === 404, 'R3: Server verweigert B den Zugriff auf A-Spur (404)');

  // ── Basis /podcast/: Hochladen mit Prüfung funktioniert ──
  await serverStop(); await serverStart({ base: '/podcast', dist: buildPodcast });
  await p.goto(`${B}/podcast/hochladen`); await p.waitForLoadState('networkidle');
  if (p.url().includes('/anmelden')) { // Cookie-Pfad hängt von der Basis ab
    await p.getByLabel('E-Mail').fill('b@pa8fix.test'); await p.getByLabel('Kennwort').fill(PW);
    await p.getByRole('button', { name: 'Anmelden' }).click();
    await p.waitForURL(/\/podcast\/(hochladen)?$/);
  }
  const pb = (await call(p, 'POST', '/projects', { title: 'Basis' })).body.id;
  await p.goto(`${B}/podcast/hochladen?projekt=${pb}`);
  await p.locator('#hochladen-datei').setInputFiles(kurz);
  await p.getByText(/Abschnitt\(e\)/).waitFor();
  await p.getByRole('button', { name: 'Hochladen', exact: true }).click();
  await p.getByText(/Fertig verarbeitet|Übertragen\. Der Server/).waitFor();
  ok(true, 'Basis /podcast/: Upload mit Inhaltsprüfung abgeschlossen');

  const unerwartet = konsole.filter((k) => !/Failed to load resource|ERR_FAILED|net::ERR_CONNECTION/.test(k));
  ok(unerwartet.length === 0, `Konsole ohne unerwartete Fehler (${konsole.length} erwartete Netz-/HTTP-Meldungen)`);
} catch (e) {
  console.error(e);
  await seite?.screenshot({ path: path.join(out, 'fehler.png'), fullPage: true }).catch(() => {});
  results.push({ pass: false, msg: String(e?.message ?? e) });
} finally {
  await writeFile(path.join(out, 'ergebnis.json'), JSON.stringify({ results, konsole, dienstAufrufe: dienst.calls }, null, 2));
  await browser?.close();
  await serverStop().catch(() => {});
  if (asrDienst) { asrDienst.closeAllConnections(); await new Promise((r) => asrDienst.close(r)); }
  if (dir) await rm(dir, { recursive: true, force: true });
  if (medien) await rm(medien, { recursive: true, force: true });
  const fail = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fail}/${results.length} bestanden`);
  process.exit(fail ? 1 : 0);
}
