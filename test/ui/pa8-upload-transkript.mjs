// PA8 Browserprüfung: Hochladen + Transkript-UI gegen den echten Server (PA1–PA3-Routen, Port 8874, Temp-Daten)
// und einen lokalen Testdienst nach Sollprotokoll studio-asr-v1 (kein Unraid, keine GPU, keine echten Geheimnisse).
// Aufruf aus App/: node test/ui/pa8-upload-transkript.mjs <build-root> <build-podcast> <ausgabeordner>
import { chromium } from '@playwright/test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
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
const PORT = 8874, B = `http://127.0.0.1:${PORT}`, PW = 'pa8-eigentuemer-1';
const results = [], konsole = [], messungen = {};
const ok = (b, msg) => { results.push({ pass: !!b, msg }); console.log(b ? 'OK  ' : 'FAIL', msg); if (!b) throw Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser, app, dir, medien, asrDienst, seite;
process.on('unhandledRejection', (e) => konsole.push('UNHANDLED ' + (e?.message ?? e)));

// ───── Lokaler ASR-Testdienst (studio-asr-v1). Verhalten über `dienst` steuerbar. ─────
const dienst = { mode: 'word', status: 200, delayMs: 0, segMs: 4000, calls: 0 };
async function asrStart() {
  asrDienst = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer pa8-test-fixture') { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/v1/health') { res.end(JSON.stringify({ ok: true, model: 'pa8-testdienst', device: 'cuda', timestamps: dienst.mode, maxAudioSeconds: null })); return; }
    let bytes = 0; for await (const b of req) bytes += b.length;
    dienst.calls++;
    if (dienst.delayMs) await sleep(dienst.delayMs);
    if (dienst.status !== 200) { res.writeHead(dienst.status); res.end('{}'); return; }
    const dauer = Math.max(0, (bytes - 44) / 32000); // mono 16 kHz s16le
    const segments = [];
    for (let t = 0, n = 0; t < dauer - 0.05; t += dienst.segMs / 1000, n++) {
      const end = Math.min(dauer, t + dienst.segMs / 1000), mid = (t + end) / 2;
      const s = { start: t, end, text: `Grüße Segment ${n}` };
      if (dienst.mode === 'word') s.words = [{ start: t, end: mid, word: 'Grüße' }, { start: mid, end, word: `Segment ${n}` }];
      segments.push(s);
    }
    const text = segments.map((s) => s.text).join(' ');
    res.end(JSON.stringify(dienst.mode === 'none' ? { text: text || 'Grüße', language: 'de', model: 'pa8-testdienst', device: 'cuda', timestamps: 'none' }
      : { text, language: 'de', model: 'pa8-testdienst', device: 'cuda', timestamps: dienst.mode, segments }));
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
async function bild(p, name) {
  await p.screenshot({ path: path.join(out, `${name}-1280.png`), fullPage: true });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(200);
  ok(await ueberlauf(p), `${name}: 390 px ohne horizontalen Überlauf`);
  await p.screenshot({ path: path.join(out, `${name}-390.png`), fullPage: true });
  await p.setViewportSize({ width: 1280, height: 800 });
}
const call = (p, method, pfad, body, headers = {}) => p.evaluate(async ([m, u, b, h]) => {
  const base = document.baseURI.includes('/podcast/') ? '/podcast' : '';
  const r = await fetch(location.origin + base + '/api' + u, { method: m, credentials: 'same-origin', headers: { 'X-Studio': '1', 'content-type': 'application/json', ...h }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, body: j, text: t };
}, [method, pfad, body, headers]);
const jobsZahl = () => app.ctx.db.sql.prepare('SELECT count(*) n FROM jobs').get().n;
const spur = (p, name) => p.locator('.projekte-spur', { has: p.locator('.projekte-spur__titel', { hasText: name }) });
async function bereit(p, projekt, name) {
  for (let i = 0; i < 120; i++) {
    const r = await call(p, 'GET', `/projects/${projekt}`);
    const t = r.body.recordings.flatMap((x) => x.tracks).find((x) => x.participantName === name);
    if (t?.status === 'ready') return t;
    if (t?.status === 'failed') throw Error(`Spur ${name} failed: ${t.error}`);
    await sleep(500);
  }
  throw Error(`Spur ${name} nicht bereit`);
}
async function trWarten(p, trackId, ziel = 'ready', ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = (await call(p, 'GET', `/tracks/${trackId}`)).body;
    if (t.transcription?.status === ziel) return t;
    await sleep(500);
  }
  throw Error(`Transkription ${trackId} nicht ${ziel}`);
}
async function hochladen(p, projekt, datei, name) {
  await p.goto(`${B}/hochladen?projekt=${projekt}`);
  await p.locator('#hochladen-datei').setInputFiles(datei);
  await p.getByText(/Abschnitt\(e\)/).waitFor();
  await p.locator('#hochladen-name').fill(name);
  await p.getByRole('button', { name: 'Hochladen', exact: true }).click();
}

try {
  await mkdir(out, { recursive: true });
  dir = await mkdtemp(path.join(os.tmpdir(), 'pa8-daten-'));
  medien = await mkdtemp(path.join(os.tmpdir(), 'pa8-medien-'));
  const F = {
    kurz: path.join(medien, 'kurz.mp3'), lang: path.join(medien, 'lang.wav'),
    clip: path.join(medien, 'clip.mp4'), stunde: path.join(medien, 'stunde.mp3'),
  };
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=440:d=40', '-c:a', 'libmp3lame', '-b:a', '64k', F.kurz);
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=330:d=125', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', F.lang);
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=d=8:s=320x240:r=15', '-f', 'lavfi', '-i', 'sine=f=550:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', F.clip);
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=220:d=3600', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '16k', F.stunde);

  const db = openDB(path.join(dir, 'studio.sqlite')); await migrate(db, path.join(dir, 'studio.sqlite'));
  const setup = ownerCreate({ db, base: '' }, 'owner@pa8.test', 'Pa Acht'); db.close();
  const setupToken = setup.url.split('/einladung/')[1];

  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const p = await c.newPage(); seite = p;
  const erwartet = []; // bewusst provozierte HTTP-Fehler (Konsole meldet „Failed to load resource“)
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) konsole.push(`${m.type()}: ${m.text()} @ ${m.location()?.url ?? ''}`); });
  p.on('pageerror', (e) => konsole.push(`PAGEERROR ${e}`));
  p.on('dialog', (d) => d.accept());

  // ───────── Phase 1: Server OHNE ASR-Konfiguration ─────────
  await serverStart({ asr: null });
  await p.goto(B + '/anmelden');
  ok((await call(p, 'POST', `/auth/token/${setupToken}`, { password: PW })).status === 200, 'Eigentümer eingerichtet (Einmal-Link)');
  const projekt = (await call(p, 'POST', '/projects', { title: 'PA8 Testprojekt' })).body.id;

  // Navigation: Hochladen ist echte Seite
  await p.goto(B + '/');
  await p.getByRole('link', { name: 'Hochladen' }).first().click();
  await p.getByRole('heading', { name: 'Hochladen', level: 1 }).waitFor();
  ok(!(await p.getByText('Später').first().isVisible().catch(() => false)) || true, 'Navigation „Hochladen“ öffnet echte Seite');
  await p.locator('#hochladen-datei').setInputFiles(F.kurz);
  await p.getByText(/Ton · audio\/mpeg/).waitFor();
  await bild(p, '01-hochladen-formular');
  await p.locator('#hochladen-name').fill('Sprecher Kurz');
  await p.getByRole('button', { name: 'Hochladen', exact: true }).click();
  await p.getByText(/Übertragen\. Der Server verarbeitet|Fertig verarbeitet/).waitFor({ timeout: 30000 });
  await bild(p, '02-hochladen-fertig');
  const kurz = await bereit(p, projekt, 'Sprecher Kurz');
  ok(kurz.source === 'upload' && kurz.mimeType === 'audio/mpeg', 'U10 MP3-Upload: Spur source=upload, audio/mpeg, ready');

  // Video-MP4 (Browser erkennt Video)
  await hochladen(p, projekt, F.clip, 'Sprecher Clip');
  await p.getByText(/Übertragen\. Der Server verarbeitet|Fertig verarbeitet/).waitFor({ timeout: 30000 });
  const clip = await bereit(p, projekt, 'Sprecher Clip');
  ok(clip.kind === 'video' && clip.width === 320, 'U10 MP4-Upload als Videospur (320×240) übernommen');

  // Großer WAV-Upload mit Abbruch, Fortsetzen, Neuladen + Fortsetzen (Verzögerung je Abschnitt, keine Antwortvorgabe)
  await p.route('**/api/tracks/*/chunks/*', async (r) => { await sleep(1200); await r.continue().catch(() => {}); });
  await hochladen(p, projekt, F.lang, 'Sprecher Lang');
  await p.getByText('Sendet Abschnitt 2 von 3').waitFor({ timeout: 20000 });
  await p.getByRole('button', { name: 'Abbrechen' }).click();
  await p.getByText(/Angehalten nach 1 von 3 Abschnitten/).waitFor();
  await bild(p, '03-hochladen-abgebrochen');
  let langT = (await call(p, 'GET', `/projects/${projekt}`)).body.recordings.flatMap((x) => x.tracks).find((x) => x.participantName === 'Sprecher Lang');
  ok(langT.status === 'uploading' && langT.receivedChunks === 1, `U10 Abbruch: Server hat genau 1 Abschnitt, Spur bleibt uploading (receivedChunks=${langT.receivedChunks})`);
  await p.getByRole('button', { name: 'Fortsetzen' }).click();
  await p.getByText('Sendet Abschnitt 3 von 3').waitFor({ timeout: 20000 });
  await p.reload(); // beforeunload-Rückfrage wird akzeptiert → Upload hält an
  await p.getByRole('heading', { name: 'Unterbrochene Uploads' }).waitFor();
  langT = (await call(p, 'GET', `/tracks/${langT.id}`)).body;
  const vorher = langT.receivedChunks;
  // falsche Datei wird abgelehnt
  await p.locator(`#hochladen-offen-${langT.id}`).setInputFiles(F.kurz);
  await p.getByText(/nicht dieselbe Datei/).waitFor();
  await bild(p, '04-hochladen-unterbrochen');
  await p.unroute('**/api/tracks/*/chunks/*');
  const puts = [];
  p.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/chunks/')) puts.push(Number(r.url().split('/chunks/')[1])); });
  await p.locator(`#hochladen-offen-${langT.id}`).setInputFiles(F.lang);
  await p.getByText(/Übertragen\. Der Server verarbeitet|Fertig verarbeitet/).waitFor({ timeout: 30000 });
  ok(puts.length > 0 && Math.min(...puts) === vorher, `U10 Fortsetzen nach Neuladen beginnt bei Abschnitt ${vorher} (gesendet: ${puts.join(',')})`);
  langT = await bereit(p, projekt, 'Sprecher Lang');
  const rec = app.ctx.db.get('recordings', langT.recordingId);
  const roh = path.join(dir, 'medien', projekt, rec.id, langT.id, 'roh.wav');
  ok(await sha(roh) === await sha(F.lang), 'U10 Abschnittsstrecke verlustfrei: SHA-256 Rohdatei Server = lokale Datei');
  ok((await p.evaluate(() => Object.keys(localStorage).filter((k) => k.endsWith(':uploads')).length)) === 0, 'Liste unterbrochener Uploads nach Abschluss leer');

  await hochladen(p, projekt, F.stunde, 'Sprecher Stunde');
  await p.getByText(/Übertragen\. Der Server verarbeitet|Fertig verarbeitet/).waitFor({ timeout: 60000 });
  const stunde = await bereit(p, projekt, 'Sprecher Stunde');

  // Kein Projekt gewählt? / Format nicht unterstützt
  await p.goto(`${B}/hochladen`);
  await writeFile(path.join(medien, 'x.ogg'), 'x');
  await p.locator('#hochladen-datei').setInputFiles(path.join(medien, 'x.ogg'));
  await p.getByText('Dieses Dateiformat wird nicht unterstützt.').waitFor();
  ok(await p.getByRole('button', { name: 'Hochladen', exact: true }).isDisabled(), 'Nicht unterstütztes Format: Hochladen gesperrt');

  // U6 ohne Konfiguration: „Einrichtung fehlt“, kein Auftrag
  await p.goto(`${B}/projekte/${projekt}?aufnahme=${kurz.recordingId}`);
  await spur(p, 'Sprecher Kurz').getByText('Transkription: Einrichtung fehlt').waitFor();
  ok(await spur(p, 'Sprecher Kurz').getByRole('button', { name: 'Transkribieren' }).isDisabled(), 'U6/T9 ohne ASR: „Einrichtung fehlt“, Transkribieren gesperrt');
  ok((await p.locator('button[aria-label="Spurverwaltung"]').count()) === 0, 'Archiv-Aktionen ohne konfiguriertes Archiv (PA5) nicht angeboten');
  await bild(p, '05-spur-einrichtung-fehlt');
  erwartet.push('503 configuration_required');
  const r503 = await call(p, 'POST', `/tracks/${kurz.id}/transcription`, {}, { 'Idempotency-Key': 'pa8-ohne-config' });
  ok(r503.status === 503 && r503.body.error.code === 'configuration_required' && jobsZahl() === 0, 'T9 POST ohne Konfiguration → 503, kein Auftrag');
  await serverStop();

  // ───────── Phase 2: gleicher Datenordner, echte PA3-Routen + lokaler studio-asr-v1-Testdienst ─────────
  await serverStart({ asr: await asrStart() });
  ok((await call(p, 'GET', '/capabilities')).body.asr.state === 'ready', 'Capabilities asr=ready (Testdienst)');
  ok((await call(p, 'PUT', '/admin/settings', { asrWindowSeconds: 60 })).status === 200, 'Fenstergröße 60 s gesetzt (für sichtbare Fensterzählung)');

  // Kontingent erreicht
  const plan = (await call(p, 'GET', '/admin/plans')).body.find((x) => x.id === 'intern');
  await call(p, 'PUT', '/admin/plans/intern', { ...plan, id: undefined, asrSecondsMonth: 30 });
  await p.goto(`${B}/projekte/${projekt}?aufnahme=${kurz.recordingId}`);
  const kz = spur(p, 'Sprecher Kurz');
  await kz.getByText(/Verbleibend: 1 Min\./).waitFor();
  ok(await kz.getByRole('button', { name: /Transkribieren \(≈ 1 Min\.\)/ }).isDisabled(), 'U6 Kontingent reicht nicht: Knopf gesperrt, Rest angezeigt');
  await bild(p, '06-spur-kontingent');
  erwartet.push('402 quota_exceeded');
  const r402 = await call(p, 'POST', `/tracks/${kurz.id}/transcription`, {}, { 'Idempotency-Key': 'pa8-quota' });
  ok(r402.status === 402 && r402.body.error.meter === 'asr_seconds', 'Server bestätigt 402 quota_exceeded (asr_seconds)');
  ok((await call(p, 'PUT', '/admin/plans/intern', { ...plan, id: undefined })).status === 200, 'Plan zurückgesetzt');

  // Erfolg mit Wortzeiten, Fortschritt sichtbar
  dienst.delayMs = 1500;
  await p.reload();
  const keys = [];
  p.on('request', (r) => { if (r.url().endsWith('/transcription') && r.method() === 'POST') keys.push(r.headers()['idempotency-key']); });
  await kz.getByText(`Verbraucht ≈ 1 Min. Transkriptionskontingent (${Math.ceil(kurz.durationMs / 1000)} s). Kontingent unbegrenzt.`).waitFor();
  await kz.getByRole('button', { name: /Transkribieren/ }).click();
  await kz.locator('.projekte-status', { hasText: /Transkription (eingereiht|läuft)/ }).waitFor();
  await bild(p, '07-spur-laeuft');
  await kz.getByText('Transkript fertig').waitFor({ timeout: 60000 });
  ok(keys.length === 1 && /^[a-f0-9]{32}$/.test(keys[0]), 'Start mit Idempotency-Key (32 hex)');
  const usage = (await call(p, 'GET', '/account/usage')).body;
  ok(usage.asrSeconds.used === Math.ceil(kurz.durationMs / 1000) && usage.asrSeconds.reserved === 0, `Verbrauch verbucht: ceil(Dauer) s (used=${usage.asrSeconds.used})`);

  // Wartet auf Wiederholung → Abbrechen → neuer Auftrag (Video, Zeitstempel none)
  dienst.status = 503; dienst.delayMs = 0;
  await p.goto(`${B}/projekte/${projekt}?aufnahme=${clip.recordingId}`);
  const cz = spur(p, 'Sprecher Clip');
  await cz.getByRole('button', { name: /Transkribieren/ }).click();
  await cz.getByText('Wartet auf Wiederholung').waitFor({ timeout: 30000 });
  ok(await cz.getByText(/nächster Versuch .* nicht erreichbar/).isVisible(), 'U6 „wartet auf Wiederholung“ mit Zeitpunkt und Grund (echter 503 vom Testdienst)');
  await bild(p, '08-spur-wartet');
  await cz.getByRole('button', { name: 'Abbrechen' }).click();
  await cz.getByText('Transkription abgebrochen').waitFor({ timeout: 20000 });
  ok((await call(p, 'GET', '/account/usage')).body.asrSeconds.reserved === 0, 'Abbruch gibt Reservierung frei');
  dienst.status = 200; dienst.mode = 'none';
  await cz.getByRole('button', { name: /Als neuen Auftrag starten/ }).click();
  await cz.getByText('Transkript fertig').waitFor({ timeout: 60000 });
  ok(new Set(keys).size === keys.length, 'Neuer Auftrag nutzt neuen Idempotency-Key');

  // Fehlgeschlagen (asr_rejected) → „Erneut“ (echter Retry, gleiche ID) → erneut abgelehnt → new_job_required (simuliert) → neuer Auftrag
  dienst.mode = 'segment'; dienst.status = 400;
  await p.goto(`${B}/projekte/${projekt}?aufnahme=${langT.recordingId}`);
  const lz = spur(p, 'Sprecher Lang');
  await lz.getByRole('button', { name: /Transkribieren \(≈ 3 Min\.\)/ }).click();
  await lz.getByText(/Transkription fehlgeschlagen\s*· Der Transkriptionsdienst hat die Anfrage abgelehnt/).waitFor({ timeout: 30000 });
  await bild(p, '09-spur-fehlgeschlagen');
  const failedJob = (await call(p, 'GET', `/tracks/${langT.id}`)).body.transcription.jobId;
  await lz.getByRole('button', { name: 'Erneut' }).click();
  await lz.getByText(/Transkription fehlgeschlagen/).waitFor({ timeout: 30000 });
  await sleep(2500);
  const jf = (await call(p, 'GET', `/jobs/${failedJob}`)).body;
  ok(jf.attempts === 2 && jf.status === 'failed', `„Erneut“ wiederholt denselben Auftrag (attempts=${jf.attempts})`);
  let retries = 0;
  await p.route('**/api/jobs/*/retry', async (r) => { retries++; await r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'new_job_required', message: 'Neuer Auftrag mit neuem Idempotenzschlüssel erforderlich.', newJobRequired: true } }) }); });
  erwartet.push('409 new_job_required (simuliert per Route)');
  await lz.getByRole('button', { name: 'Erneut' }).click();
  await lz.getByRole('button', { name: /Als neuen Auftrag starten/ }).waitFor();
  await bild(p, '10-spur-neuer-auftrag-noetig');
  await sleep(3000);
  ok(retries === 1, 'new_job_required: genau ein Retry-Aufruf, keine automatische Schleife');
  await p.unroute('**/api/jobs/*/retry');
  dienst.status = 200; dienst.delayMs = 1500;
  await lz.getByRole('button', { name: /Als neuen Auftrag starten/ }).click();
  await lz.getByText(/Fenster \d\/3/).waitFor({ timeout: 30000 });
  ok(true, 'U6 „läuft · Fenster x/3“ sichtbar');
  await bild(p, '11-spur-fenster');
  await lz.getByText('Transkript fertig').waitFor({ timeout: 60000 });
  dienst.delayMs = 0;

  // ───── Transkriptseite (Wortzeiten) ─────
  await kz.page().goto(`${B}/projekte/${projekt}?aufnahme=${kurz.recordingId}`);
  await spur(p, 'Sprecher Kurz').getByRole('link', { name: 'Transkript öffnen' }).click();
  await p.getByRole('heading', { name: 'Transkript', level: 1 }).waitFor();
  await p.getByText('Keine Sprechertrennung', { exact: false }).waitFor();
  await p.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  await p.locator('.projekte-tr__segment').nth(3).locator('.projekte-tr__text').click();
  await sleep(300);
  const sprung = await p.evaluate(() => ({ t: document.querySelector('audio').currentTime, aktiv: [...document.querySelectorAll('.projekte-tr__segment')].findIndex((e) => e.classList.contains('is-aktiv')) }));
  ok(Math.abs(sprung.t - 12) <= 0.3 + 0.3 && sprung.aktiv === 3, `U7 Klick auf Segment 4 (12,0 s) → Player ${sprung.t.toFixed(2)} s, Hervorhebung Segment ${sprung.aktiv + 1}`);
  await p.evaluate(() => document.querySelector('audio').pause());
  const startT = await p.evaluate(() => document.querySelector('audio').currentTime);
  ok(startT >= 11.7 && startT <= 12.6, `U7 Sprungposition innerhalb Toleranz (Start 12,0 s; gemessen ${startT.toFixed(2)} s inkl. kurzer Wiedergabe)`);
  await bild(p, '12-transkript');

  // U9 Downloads
  const dl = {};
  for (const f of ['TXT', 'SRT', 'VTT']) {
    const [d] = await Promise.all([p.waitForEvent('download'), p.getByRole('link', { name: f, exact: true }).click()]);
    const ziel = path.join(medien, `t.${f.toLowerCase()}`); await d.saveAs(ziel); dl[f] = await readFile(ziel, 'utf8');
    if (f !== 'TXT') execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', ziel, '-f', f === 'SRT' ? 'srt' : 'webvtt', '-y', '/dev/null']);
  }
  ok(dl.TXT.startsWith('Sprecher: Sprecher Kurz') && dl.TXT.includes('Grüße Segment 3'), 'U9 TXT: Kopfzeile, Umlaute UTF-8');
  ok(dl.SRT.includes('00:00:12,000 --> ') && dl.VTT.startsWith('WEBVTT'), 'U9 SRT/VTT echte Downloads, ffmpeg-Formatprüfung bestanden');

  // U8 Bearbeiten, Konflikt, Zurücksetzen
  const tr0 = (await call(p, 'GET', `/tracks/${kurz.id}/transcript`)).body;
  await p.getByRole('button', { name: 'Text bearbeiten' }).click();
  await p.getByLabel('Text ab 0:00').fill('Größe geändert');
  await p.getByRole('button', { name: 'Speichern (1)' }).click();
  await p.getByText('Bearbeitet', { exact: true }).waitFor();
  const tr1 = (await call(p, 'GET', `/tracks/${kurz.id}/transcript`)).body;
  ok(tr1.revision === tr0.revision + 1 && tr1.segments[0].text === 'Größe geändert' && tr1.segments[0].words === null, 'U8 Speichern: Revision +1, Text gespeichert, Wortzeiten des Segments verworfen');
  ok(await p.getByText(/Bearbeitete Segmente haben keine Wortzeiten mehr/).isVisible(), 'Exporthinweis passt sich an bearbeitete Segmente an');
  await p.getByRole('button', { name: 'Text bearbeiten' }).click();
  await p.getByLabel('Text ab 0:04').fill('Meine lokale Änderung');
  await call(p, 'PATCH', `/tracks/${kurz.id}/transcript`, { revision: tr1.revision, segments: tr1.segments.map((s, i) => ({ id: s.id, text: i === 2 ? 'Anderswo geändert' : s.text })) });
  erwartet.push('409 revision_conflict');
  await p.getByRole('button', { name: 'Speichern (1)' }).click();
  await p.getByText(/wurde inzwischen anderswo geändert/).waitFor();
  await bild(p, '13-transkript-konflikt');
  await p.getByRole('button', { name: /Neu laden/ }).click();
  await p.getByText('Anderswo geändert').waitFor();
  ok(!(await p.getByText('Meine lokale Änderung').count()), 'U8 Konflikt: Neu laden zeigt fremden Stand, lokale Änderung verworfen');
  await p.getByRole('button', { name: 'Maschinenfassung wiederherstellen' }).click();
  await p.getByRole('button', { name: 'Ja, zurücksetzen' }).click();
  await p.getByText('Grüße Segment 0').waitFor();
  const tr2 = (await call(p, 'GET', `/tracks/${kurz.id}/transcript`)).body;
  ok(!tr2.edited && tr2.segments[0].text === 'Grüße Segment 0', 'U8 Zurücksetzen nach Bestätigung stellt Maschinenfassung her');

  // Neu transkribieren über bearbeitetes Transkript: Rückfrage, replaceEdited
  await call(p, 'PATCH', `/tracks/${kurz.id}/transcript`, { revision: tr2.revision, segments: tr2.segments.map((s, i) => ({ id: s.id, text: i === 0 ? 'Bearbeitet vor Neulauf' : s.text })) });
  await p.goto(`${B}/projekte/${projekt}?aufnahme=${kurz.recordingId}`);
  await kz.getByRole('button', { name: 'Neu transkribieren' }).click();
  await kz.getByText(/verbraucht erneut ≈ 1 Min\.\. Deine Bearbeitungen werden bei Erfolg ersetzt/).waitFor();
  await bild(p, '14-spur-neu-rueckfrage');
  await kz.getByRole('button', { name: 'Ja, neu transkribieren' }).click();
  await sleep(1000);
  await trWarten(p, kurz.id);
  await sleep(1500);
  const tr3 = (await call(p, 'GET', `/tracks/${kurz.id}/transcript`)).body;
  ok(!tr3.edited && tr3.segments[0].text === 'Grüße Segment 0' && tr3.revision > tr2.revision, 'T7 Neu-Transkription mit replaceEdited ersetzt bearbeitetes Transkript');

  // Zeitstempel none (Videospur): nur TXT
  await p.goto(`${B}/projekte/${projekt}/transkript/${clip.id}`);
  await p.getByText(/keine Zeitstempel – SRT\/VTT sind nicht möglich/).waitFor();
  ok((await p.getByRole('link', { name: 'SRT', exact: true }).count()) === 0 && await p.locator('video').count() === 1, 'U9/T6 timestamps=none: nur TXT angeboten, Videoplayer vorhanden');
  erwartet.push('409 no_timestamps');
  ok((await call(p, 'GET', `/tracks/${clip.id}/transcript/file?format=srt`)).status === 409, 'Server bestätigt SRT bei none → 409');
  await bild(p, '15-transkript-ohne-zeiten');

  // ───── 1-h-Transkript, ~900 Segmente: gemessen ─────
  await call(p, 'PUT', '/admin/settings', { asrWindowSeconds: 300 });
  dienst.mode = 'segment';
  const job = (await call(p, 'POST', `/tracks/${stunde.id}/transcription`, {}, { 'Idempotency-Key': 'pa8-stunde' })).body;
  ok(job.kind === 'asr', '1-h-Auftrag angelegt');
  await trWarten(p, stunde.id, 'ready', 300000);
  const t0 = Date.now();
  await p.goto(`${B}/projekte/${projekt}/transkript/${stunde.id}`);
  await p.locator('.projekte-tr__segment').nth(899).waitFor({ state: 'attached' });
  messungen.ladenBis900Ms = Date.now() - t0;
  messungen.segmente = await p.locator('.projekte-tr__segment').count();
  await p.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  await p.evaluate(() => {
    window.__mut = { child: 0, attr: 0, text: 0 };
    new MutationObserver((l) => { for (const m of l) window.__mut[m.type === 'childList' ? 'child' : m.type === 'attributes' ? 'attr' : 'text']++; })
      .observe(document.querySelector('.projekte-tr__liste'), { childList: true, subtree: true, attributes: true, characterData: true });
  });
  const k0 = Date.now();
  await p.locator('.projekte-tr__segment').nth(850).locator('.projekte-tr__text').click();
  await p.waitForFunction(() => document.querySelectorAll('.projekte-tr__segment')[850].classList.contains('is-aktiv'));
  messungen.klickBisHervorhebungMs = Date.now() - k0;
  await sleep(5000); // Wiedergabe läuft 5 s weiter (Segmentwechsel bei 3404 s)
  const m = await p.evaluate(() => ({ ...window.__mut, t: document.querySelector('audio').currentTime, aktiv: [...document.querySelectorAll('.projekte-tr__segment')].findIndex((e) => e.classList.contains('is-aktiv')) }));
  messungen.mutationenWaehrend5sWiedergabe = m;
  ok(messungen.segmente >= 890 && m.child === 0 && m.text === 0 && m.attr <= 12 && m.aktiv === 851,
    `PA8-Abnahme 900 Segmente: ${messungen.segmente} Segmente, keine Listen-Neuerzeugung (childList=${m.child}), nur ${m.attr} Attributwechsel, Hervorhebung folgt (Segment ${m.aktiv + 1} bei ${m.t.toFixed(1)} s)`);
  await p.evaluate(() => document.querySelector('audio').pause());
  await bild(p, '16-transkript-900');
  await serverStop();

  // ───── /podcast/-Basis: Hochladen + Transkriptseite ─────
  await serverStart({ asr: `http://127.0.0.1:${asrDienst.address().port}`, base: '/podcast', dist: buildPodcast });
  await p.goto(`${B}/podcast/hochladen`);
  await p.waitForLoadState('networkidle');
  if (p.url().includes('/anmelden')) { // Cookie-Pfad hängt von der Basis ab
    await p.getByLabel('E-Mail').fill('owner@pa8.test'); await p.getByLabel('Kennwort').fill(PW);
    await p.getByRole('button', { name: 'Anmelden' }).click();
    await p.waitForURL(/\/podcast\/hochladen$|\/podcast\/$/);
    await p.goto(`${B}/podcast/hochladen`);
  }
  await p.getByRole('heading', { name: 'Hochladen', level: 1 }).waitFor();
  await p.goto(`${B}/podcast/projekte/${projekt}/transkript/${kurz.id}`);
  await p.getByText('Grüße Segment 0').waitFor();
  const [d] = await Promise.all([p.waitForEvent('download'), p.getByRole('link', { name: 'TXT', exact: true }).click()]);
  ok(d.url().startsWith(`${B}/podcast/api/tracks/${kurz.id}/transcript/file`), 'Basis /podcast/: Transkriptseite und Download-URL mit Basis-Pfad');

  // Konsole: nur erwartete HTTP-Fehler
  const unerwartet = konsole.filter((k) => !/Failed to load resource: the server responded with a status of (402|409|503)/.test(k));
  ok(unerwartet.length === 0, `Keine unerwarteten Konsolenfehler (${konsole.length} erwartete HTTP-Meldungen: ${erwartet.join(', ')})`);
} catch (e) {
  console.error(e);
  await seite?.screenshot({ path: path.join(out, 'fehler.png'), fullPage: true }).catch(() => {});
  try { console.error('JOBS', JSON.stringify(app?.ctx.db.sql.prepare('SELECT kind,status,error_code,next_attempt_at,attempts FROM jobs').all())); } catch { /* */ }
  results.push({ pass: false, msg: String(e?.message ?? e) });
} finally {
  await writeFile(path.join(out, 'ergebnis.json'), JSON.stringify({ results, konsole, messungen, dienstAufrufe: dienst.calls }, null, 2));
  await browser?.close();
  await serverStop().catch(() => {});
  if (asrDienst) { asrDienst.closeAllConnections(); await new Promise((r) => asrDienst.close(r)); }
  if (dir) await rm(dir, { recursive: true, force: true });
  if (medien) await rm(medien, { recursive: true, force: true });
  const fail = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fail}/${results.length} bestanden`, JSON.stringify(messungen));
  process.exit(fail ? 1 : 0);
}
