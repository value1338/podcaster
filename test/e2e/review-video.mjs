// AP9-Browserprüfung Video: echter Server (Port 8862), echtes Chromium mit Schein-Kamera/-Mikrofon, echte MediaRecorder-Blobs.
// Aufruf aus App/: VITE_BASE=/podcast/ npx vite build --outDir <SCRATCH>/dist-podcast
//                  DIST=<SCRATCH>/dist-podcast node src/lib/recorder/video.browser-check.mjs
// Daten isoliert unter ../Pruefungen/temp-video-* (Projekt-Dateisystem, >10 GB frei), am Ende entfernt. Keine Produktionsdaten, kein Produktions-dist.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';

const PORT = Number(process.env.PORT ?? 8877), base = `http://127.0.0.1:${PORT}/podcast`, out = process.env.OUT ?? '../Pruefungen/Plattform/Review-Konto-Recorder/video';
const DIST = process.env.DIST;
const SEK = Number(process.env.SEK ?? 25);
if (!DIST) throw Error('DIST fehlt (Scratch-Build, nicht App/dist).');
mkdirSync(out, { recursive: true });
await new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(PORT, '127.0.0.1', () => s.close(res)); });
const temp = mkdtempSync('../Pruefungen/temp-video-');
const { createStudioServer } = await import('../../server/index.mjs');
const { openDB } = await import('../../server/db.mjs');
const { migrate } = await import('../../server/migrate.mjs');
const { ownerCreate } = await import('../../server/accounts.mjs');
const dbfile = temp+'/studio.sqlite', db = openDB(dbfile); await migrate(db,dbfile);
const setup = ownerCreate({db,base:'/podcast'},'video@example.test','Video'); db.close();
const origin = `http://127.0.0.1:${PORT}`;
const own = await createStudioServer({ dataDir: temp, base: '/podcast', dist: DIST, origins: origin, cookieInsecure: true });
await new Promise((r) => own.server.listen(PORT, '127.0.0.1', r));

const auth = await fetch(base+'/api/auth/token/'+setup.url.split('/').at(-1), {method:'POST',headers:{'X-Studio':'1',Origin:origin},body:JSON.stringify({password:'video-review-password'})});
const cookie = auth.headers.get('set-cookie').split(';')[0];
const loginContext = c => c.addCookies([{name:cookie.split('=')[0],value:cookie.split('=')[1],domain:'127.0.0.1',path:'/podcast/'}]);
const log = [];
const ok = (b, m, extra) => { log.push({ pass: !!b, msg: m, ...(extra ? { extra } : {}) }); console.log(b ? 'OK  ' : 'FAIL', m, extra ? JSON.stringify(extra) : ''); if (!b) throw new Error(m); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const api = async (p) => (await fetch(base + '/api' + p, {headers:{cookie}})).json();
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', f]).toString());
const decode = (f) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', f, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const sichtbar = async (p, text) => {
  await p.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: 15_000 });
  return p.evaluate((t) => { const el = [...document.querySelectorAll('.error__title')].find((e) => e.textContent === t); const r = el?.getBoundingClientRect(); return { w: r?.width, h: r?.height, vis: el && getComputedStyle(el).visibility }; }, text);
};
const ueberlauf = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// Erzeugte Blobs mitschneiden (nur Beobachtung, App-Code unverändert); optional Streams für das simulierte ended-Ereignis.
const beobachten = () => {
  window.generated = [];
  const start = MediaRecorder.prototype.start;
  MediaRecorder.prototype.start = function (...a) {
    window.recOpts = { mimeType: this.mimeType, videoBps: this.videoBitsPerSecond, audioBps: this.audioBitsPerSecond, tracks: this.stream.getTracks().map((t) => t.kind) };
    this.addEventListener('dataavailable', (e) => { if (e.data.size) window.generated.push(e.data); });
    return start.apply(this, a);
  };
  window.streams = [];
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (c?.video && window.camFehler) throw new DOMException('simuliert', window.camFehler);
    const s = await gum(c); window.streams.push(s); return s;
  };
};
const generatedSha = (p) => p.evaluate(async () => {
  const a = await new Blob(window.generated).arrayBuffer();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', a))).map((v) => v.toString(16).padStart(2, '0')).join('');
});

async function projekt(p, name) {
  await p.goto(base + '/studio');
  await p.getByLabel('Neues Projekt').fill(name);
  await p.getByRole('button', { name: 'Anlegen & aufnehmen' }).click();
  await p.getByRole('heading', { name: 'Bereit zur Aufnahme' }).waitFor();
  return p.url().split('/').at(-1);
}
async function warteFertig(p) {
  await p.getByRole('heading', { name: 'Aufnahme gesichert' }).waitFor({ timeout: 180_000 });
  const href = await p.getByRole('link', { name: 'Original herunterladen' }).getAttribute('href');
  return href.split('/tracks/')[1].split('/')[0];
}
const spurDir = (pid, t) => `${temp}/medien/${pid}/${t.recordingId}/${t.id}`;

let browser, browser2, aktiv;
const res = {};
try {
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], acceptDownloads: true, viewport: { width: 1280, height: 860 } });
  await loginContext(ctx); await ctx.addInitScript(beobachten);
  const p = await ctx.newPage();
  aktiv = p;
  const fehlerSeite = [];
  p.on('pageerror', (e) => fehlerSeite.push(String(e)));

  // ---- A: Video + Ton, echte Aufnahme ----
  const pid = await projekt(p, 'Video-Prüfung AP9');
  ok(await p.evaluate(() => window.streams.every((s) => s.getVideoTracks().length === 0)), 'A: Standard Nur Ton – keine Kamera angefragt');
  await p.getByRole('radio', { name: 'Video + Ton' }).check();
  await p.getByTestId('studio-kamera-werte').waitFor();
  const live = await p.evaluate(async () => {
    const v = document.querySelector('video[aria-label="Live-Vorschau der Kamera"]');
    await new Promise((r) => (v.videoWidth ? r() : v.addEventListener('loadedmetadata', r, { once: true })));
    const t0 = v.currentTime; await new Promise((r) => setTimeout(r, 600));
    return { srcObject: !!v.srcObject, muted: v.muted, playsInline: v.playsInline, w: v.videoWidth, h: v.videoHeight, laeuft: v.currentTime > t0, videoTracks: v.srcObject.getVideoTracks().length, audioTracks: v.srcObject.getAudioTracks().length };
  });
  ok(live.srcObject && live.muted && live.playsInline && live.w > 0 && live.laeuft && live.videoTracks === 1 && live.audioTracks === 0, 'A: Live-Vorschau per srcObject, stumm, inline, Bild läuft', live);
  const werte = await p.getByTestId('studio-kamera-werte').innerText();
  ok(werte.includes(`${live.w}×${live.h}`), 'A: angezeigte Auflösung = tatsächliche Kamerawerte', { werte });
  ok((await p.getByLabel('Kamera', { exact: true }).locator('option').count()) >= 1, 'A: Kamerawahl vorhanden');
  await p.screenshot({ path: out + '/a-warteraum-video-1280.png' });
  await p.setViewportSize({ width: 390, height: 844 });
  ok(await ueberlauf(p) <= 0, 'A: 390 px Warteraum Video ohne horizontalen Überlauf');
  await p.screenshot({ path: out + '/a-warteraum-video-390.png', fullPage: true });
  await p.setViewportSize({ width: 1280, height: 860 });

  await p.getByRole('button', { name: 'Video-Aufnahme starten' }).click();
  await p.getByRole('heading', { name: 'Aufnahme läuft' }).waitFor({ timeout: 15_000 });
  ok((await p.getByLabel('Kamera', { exact: true }).count()) === 0 && (await p.getByRole('radio').count()) === 0, 'A: Geräte-/Modussteuerung während der Aufnahme gesperrt (nicht angeboten)');
  const opts = await p.evaluate(() => window.recOpts);
  ok(opts.mimeType.startsWith('video/webm') && opts.tracks.includes('audio') && opts.tracks.includes('video'), 'A: MediaRecorder video/webm mit Audio+Video-Spur', opts);
  await p.waitForTimeout(SEK * 1000 / 2);
  await p.screenshot({ path: out + '/a-aufnahme-1280.png' });
  await p.waitForTimeout(SEK * 1000 / 2);
  await p.getByRole('button', { name: 'Aufnahme beenden' }).click();
  const tid = await warteFertig(p);
  const t = await api('/tracks/' + tid);
  res.track = t;
  ok(t.kind === 'video' && t.status === 'ready' && t.width > 0 && t.height > 0, 'A: Server-Spur video/ready mit Auflösung', { kind: t.kind, w: t.width, h: t.height, mime: t.mimeType, dauer: t.durationMs, bytes: t.bytes });
  ok(Math.abs(t.durationMs - SEK * 1000) < 3000, 'A: Dauer ≈ Aufnahmezeit', { durationMs: t.durationMs, soll: SEK * 1000 });
  ok(t.receivedChunks === await p.evaluate(() => window.generated.length), 'A: alle erzeugten Abschnitte serverbestätigt', { n: t.receivedChunks });
  const fakten = await p.locator('.studio-fakten').innerText();
  ok(fakten.includes(`${t.width}×${t.height}`) && fakten.includes('Video + Ton'), 'A: Ergebnis zeigt echte Art/Auflösung', { fakten });

  // Ergebnis-Player: echtes Video vom Server, spulbar
  const spiel = await p.evaluate(async () => {
    const v = document.querySelector('[data-testid="studio-ergebnis-video"]');
    if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    const d = v.duration;
    v.currentTime = Math.min(10, d / 2);
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    return { src: v.currentSrc, srcObject: !!v.srcObject, duration: d, nach: v.currentTime, w: v.videoWidth, h: v.videoHeight };
  });
  ok(!spiel.srcObject && /\/api\/tracks\/.+\/file$/.test(spiel.src) && Math.abs(spiel.duration * 1000 - t.durationMs) < 600 && Math.abs(spiel.nach - Math.min(10, spiel.duration / 2)) < 0.6 && spiel.w === t.width,
    'A: Ergebnis-Player spielt Serverdatei (keine Kameravorschau), Dauer bekannt, Spulen funktioniert', spiel);
  await p.screenshot({ path: out + '/a-fertig-1280.png' });
  await p.setViewportSize({ width: 390, height: 844 });
  ok(await ueberlauf(p) <= 0, 'A: 390 px Ergebnis ohne horizontalen Überlauf');
  await p.screenshot({ path: out + '/a-fertig-390.png', fullPage: true });
  await p.setViewportSize({ width: 1280, height: 860 });

  // Original herunterladen (UI-Klick) → SHA = API = Serverdatei; Rohdatei = erzeugte Blobs
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('link', { name: 'Original herunterladen' }).click()]);
  const orig = temp + '/download-original.webm';
  await dl.saveAs(orig);
  const dir = spurDir(pid, t);
  const hDl = sha(readFileSync(orig)), hSrv = sha(readFileSync(dir + '/original.webm'));
  ok(hDl === t.sha256 && hSrv === t.sha256, 'A: SHA Download = API = Serverdatei original.webm', { sha256: t.sha256 });
  ok(sha(readFileSync(dir + '/roh.webm')) === await generatedSha(p), 'A: SHA erzeugte Browser-Blobs = Server roh.webm');
  const pr = probe(orig);
  const v = pr.streams.find((s) => s.codec_type === 'video'), a = pr.streams.find((s) => s.codec_type === 'audio');
  res.probeOriginal = { format: pr.format.format_name, duration: pr.format.duration, video: v && { codec: v.codec_name, w: v.width, h: v.height, fps: v.avg_frame_rate || v.r_frame_rate }, audio: a && { codec: a.codec_name, rate: a.sample_rate, ch: a.channels } };
  ok(v && a && v.width === t.width && v.height === t.height && Math.abs(Number(pr.format.duration) * 1000 - t.durationMs) < 50, 'A: ffprobe Original: Audio+Video, Dimension, Dauer', res.probeOriginal);
  const dec = decode(orig);
  ok(dec.trim() === '', 'A: ffmpeg dekodiert Original vollständig ohne Fehler');

  // Exporte über die Projektseite (vorhandene Serverpipeline): MP4, MP3, WAV
  await p.getByRole('link', { name: 'Zum Projekt' }).first().click();
  await p.getByRole('heading', { name: 'Video-Prüfung AP9' }).waitFor();
  const pv = await p.evaluate(async () => { const v = document.querySelector('.projekte-player video'); if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true })); return { d: v.duration, w: v.videoWidth }; });
  ok(pv.w === t.width && pv.d > 0, 'A: Projekt-Player zeigt Video', pv);
  const zeile = await p.locator('.projekte-spur').first().innerText();
  ok(zeile.includes(`${t.width}×${t.height}`) && zeile.includes('WebM (VP'), 'A: Spurzeile zeigt Auflösung und Codec', { zeile });
  for (const [name, fmt] of [[/^MP4 \(H\.264\)/, 'mp4'], [/^MP3 · nur Ton/, 'mp3'], [/^WAV · nur Ton/, 'wav']]) {
    await p.getByRole('button', { name: 'Herunterladen' }).first().click();
    await p.getByRole('menuitem', { name }).click();
    await p.waitForFunction(async ([id, f]) => { const r = await fetch(location.pathname.split('/projekte')[0] + '/api/tracks/' + id); const j = await r.json(); return j.exports.some((e) => e.format === f); }, [tid, fmt], { timeout: 15_000 });
  }
  const t2 = await (async () => { for (;;) { const x = await api('/tracks/' + tid); if (x.exports.length === 3 && x.exports.every((e) => e.status === 'ready' || e.status === 'failed')) return x; await new Promise((r) => setTimeout(r, 1000)); } })();
  ok(t2.exports.every((e) => e.status === 'ready'), 'A: Exporte MP4/MP3/WAV fertig', t2.exports.map((e) => [e.format, e.status, e.bytes]));
  res.exporte = {};
  for (const e of t2.exports) {
    const f = `${temp}/export.${e.format}`;
    writeFileSync(f, Buffer.from(await (await fetch(base + '/api/exports/' + e.id + '/file', {headers:{cookie}})).arrayBuffer()));
    const q = probe(f);
    const qv = q.streams.find((s) => s.codec_type === 'video'), qa = q.streams.find((s) => s.codec_type === 'audio');
    res.exporte[e.format] = { video: qv && { codec: qv.codec_name, w: qv.width, h: qv.height, pix: qv.pix_fmt }, audio: qa && { codec: qa.codec_name, rate: qa.sample_rate }, duration: q.format.duration };
    const dOk = Math.abs(Number(q.format.duration) * 1000 - t.durationMs) <= 500;
    if (e.format === 'mp4') ok(qv?.codec_name === 'h264' && qa?.codec_name === 'aac' && qv.width === t.width && dOk, 'A: MP4-Export H.264+AAC, Dimension, Dauer ±0,5 s', res.exporte.mp4);
    if (e.format === 'mp3') ok(!qv && qa?.codec_name === 'mp3' && dOk, 'A: MP3-Export nur Ton aus Video', res.exporte.mp3);
    if (e.format === 'wav') ok(!qv && qa?.codec_name === 'pcm_s16le' && dOk, 'A: WAV-Export nur Ton aus Video', res.exporte.wav);
    ok(decode(f).trim() === '', `A: ${e.format.toUpperCase()}-Export vollständig dekodierbar`);
  }
  await p.screenshot({ path: out + '/a-projekt-1280.png' });

  // ---- D: Kamera während der Aufnahme verloren (ended-Ereignis simuliert) → kontrollierter Stopp, Stand gesichert ----
  await p.goto(base + '/studio/' + pid);
  await p.getByRole('heading', { name: 'Bereit zur Aufnahme' }).waitFor();
  await p.getByRole('radio', { name: 'Video + Ton' }).check();
  await p.getByTestId('studio-kamera-werte').waitFor();
  await p.evaluate(() => { window.generated = []; });
  await p.getByRole('button', { name: 'Video-Aufnahme starten' }).click();
  await p.getByRole('heading', { name: 'Aufnahme läuft' }).waitFor({ timeout: 15_000 });
  await p.waitForTimeout(6000);
  await p.evaluate(() => { const t = window.streams.flatMap((s) => s.getVideoTracks()).find((x) => x.readyState === 'live'); t.dispatchEvent(new Event('ended')); });
  const tidD = await warteFertig(p);
  const tD = await api('/tracks/' + tidD);
  ok(tD.status === 'ready' && tD.kind === 'video' && tD.receivedChunks === await p.evaluate(() => window.generated.length) && /Kamera wurde während der Aufnahme getrennt/.test(await p.locator('body').innerText()),
    'D: Kamera verloren (simuliertes ended) → Aufnahme beendet, alle Abschnitte gesichert, Warnung sichtbar', { dauer: tD.durationMs });
  ok(await p.evaluate(() => window.streams.flatMap((s) => s.getTracks()).every((x) => x.readyState === 'ended')), 'D: Kamera und Mikrofon nach Abschluss freigegeben');

  // ---- C: keine Kamera (NotFoundError simuliert) → Meldung, Start gesperrt, „Nur Ton“ möglich ----
  await p.goto(base + '/studio/' + pid);
  await p.getByRole('heading', { name: 'Bereit zur Aufnahme' }).waitFor();
  await p.evaluate(() => { window.camFehler = 'NotFoundError'; });
  await p.getByRole('radio', { name: 'Video + Ton' }).check();
  console.log('SICHTBAR', JSON.stringify(await sichtbar(p, 'Keine Kamera gefunden')));
  ok(await p.getByRole('button', { name: 'Video-Aufnahme starten' }).isDisabled(), 'C: kein Kameragerät → verständliche Meldung, Start gesperrt');
  await p.evaluate(() => { window.camFehler = 'NotReadableError'; });
  await p.getByRole('button', { name: 'Kamera erneut versuchen' }).click();
  console.log('SICHTBAR', JSON.stringify(await sichtbar(p, 'Kamera ist belegt')));
  ok(true, 'C: Kamera belegt → eigene Meldung');
  await p.screenshot({ path: out + '/c-kamera-belegt-1280.png' });
  await p.getByRole('button', { name: 'Ohne Kamera, nur Ton' }).click();
  ok(await p.getByRole('button', { name: 'Aufnahme starten', exact: true }).isEnabled(), 'C: Wechsel zu Nur Ton → Start wieder möglich');
  ok(fehlerSeite.length === 0, 'A–D: keine Seitenfehler', fehlerSeite);
  await ctx.close();

  // ---- B: echte Kameraverweigerung (Kamera-Berechtigung nicht erteilt, kein Fake-UI) → Audio-only-Aufnahme ----
  // Neuer Headless-Modus ohne Fake-UI: nur Mikrofon erteilt → Kamera wird vom Browser echt verweigert (NotAllowedError).
  browser2 = await chromium.launch({ channel: 'chromium', args: ['--use-fake-device-for-media-stream'] });
  const ctx2 = await browser2.newContext({ permissions: ['microphone'], acceptDownloads: true, viewport: { width: 390, height: 844 } });
  await loginContext(ctx2); await ctx2.addInitScript(beobachten);
  const q = await ctx2.newPage();
  aktiv = q;
  const pidB = await projekt(q, 'Kamera verweigert');
  await q.getByRole('radio', { name: 'Video + Ton' }).check();
  console.log('SICHTBAR', JSON.stringify(await sichtbar(q, 'Kein Zugriff auf die Kamera')));
  ok(await q.getByRole('button', { name: 'Video-Aufnahme starten' }).isDisabled(), 'B: Kamera verweigert → Meldung, Video-Start gesperrt, Mikrofon bleibt (Pegel/Warteraum)');
  ok(await ueberlauf(q) <= 0, 'B: 390 px Kamerafehler ohne Überlauf');
  await q.screenshot({ path: out + '/b-kamera-verweigert-390.png', fullPage: true });
  await q.getByRole('button', { name: 'Ohne Kamera, nur Ton' }).click();
  await q.getByRole('button', { name: 'Aufnahme starten', exact: true }).click();
  await q.getByRole('heading', { name: 'Aufnahme läuft' }).waitFor({ timeout: 15_000 });
  ok((await q.evaluate(() => window.recOpts)).mimeType.startsWith('audio/webm'), 'B: Audio-only-Aufnahme audio/webm');
  await q.waitForTimeout(6000);
  await q.getByRole('button', { name: 'Aufnahme beenden' }).click();
  const tidB = await warteFertig(q);
  const tB = await api('/tracks/' + tidB);
  const prB = probe(`${temp}/medien/${pidB}/${tB.recordingId}/${tB.id}/original.webm`);
  ok(tB.kind === 'audio' && tB.status === 'ready' && !prB.streams.some((s) => s.codec_type === 'video') && tB.receivedChunks === await q.evaluate(() => window.generated.length),
    'B: Audio-only ready, keine Videospur, alle Abschnitte bestätigt', { dauer: tB.durationMs, mime: tB.mimeType });
  ok(await q.evaluate(() => !document.querySelector('[data-testid="studio-ergebnis-video"]')), 'B: Audio-Ergebnis ohne Videoplayer');
  await q.screenshot({ path: out + '/b-audio-fertig-390.png', fullPage: true });
  await ctx2.close();
  console.log('VIDEO-PRÜFUNG FERTIG');
} catch (e) {
  await aktiv?.screenshot({ path: out + '/fehler-letzter-zustand.png', fullPage: true }).catch(() => {});
  log.push({ pass: false, msg: String(e?.message ?? e).split('\n')[0], body: await aktiv?.locator('body').innerText().catch(() => null) });
  throw e;
} finally {
  writeFileSync(out + '/results.json', JSON.stringify({ log, res }, null, 2));
  await browser?.close();
  await browser2?.close();
  own.server.closeAllConnections?.();
  await own.close();
  rmSync(temp, { recursive: true, force: true });
}
