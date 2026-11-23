// PA9 Browserprüfung: Text-KI-Oberfläche gegen den echten Server (PA1–PA4-Routen, Port 8875, Temp-Daten).
// LLM über Treiber `openai` gegen einen LOKALEN OpenAI-kompatiblen Testanbieter (Loopback, Testschlüssel-Fixture) –
// kein echter Anbieter, keine Kosten. ASR über lokalen studio-asr-v1-Testdienst wie PA8 (nur um echte Transkripte zu erzeugen).
// Aufruf aus App/: node test/ui/pa9-ki.mjs <build-root> <build-podcast> <ausgabeordner>
import { chromium } from '@playwright/test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDB } from '../../server/db.mjs';
import { migrate } from '../../server/migrate.mjs';
import { ownerCreate } from '../../server/accounts.mjs';
import { createStudioServer } from '../../server/index.mjs';

const [buildRoot, buildPodcast, out] = process.argv.slice(2).map((p) => path.resolve(p));
const PORT = 8875, B = `http://127.0.0.1:${PORT}`, PW = 'pa9-eigentuemer-1', EMAIL = 'owner@pa9.test', KEY = 'pa9-test-fixture-key';
const results = [], konsole = [];
const ok = (b, msg) => { results.push({ pass: !!b, msg }); console.log(b ? 'OK  ' : 'FAIL', msg); if (!b) throw Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser, app, dir, medien, asrDienst, llmDienst;
const offen = new Set();
process.on('unhandledRejection', (e) => konsole.push('UNHANDLED ' + (e?.message ?? e)));

// ───── ASR-Testdienst (studio-asr-v1, Segmente à 4 s) ─────
async function asrStart() {
  asrDienst = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer pa9-asr-fixture') { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/v1/health') { res.end(JSON.stringify({ ok: true, model: 'pa9-asr-testdienst', device: 'cuda', timestamps: 'segment', maxAudioSeconds: null })); return; }
    let bytes = 0; for await (const b of req) bytes += b.length;
    const dauer = Math.max(0, (bytes - 44) / 32000), segments = [];
    for (let t = 0, n = 0; t < dauer - 0.05; t += 4, n++) segments.push({ start: t, end: Math.min(dauer, t + 4), text: `Wir sprechen über Thema ${n}.` });
    res.end(JSON.stringify({ text: segments.map((s) => s.text).join(' '), language: 'de', model: 'pa9-asr-testdienst', device: 'cuda', segments }));
  });
  await new Promise((r) => asrDienst.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${asrDienst.address().port}`;
}

// ───── OpenAI-kompatibler Testanbieter (zeichnet Körper auf, Verhalten über `llm.mode`) ─────
const llm = { mode: 'ok', calls: [], auth: [] };
async function llmStart() {
  llmDienst = http.createServer(async (req, res) => {
    offen.add(res);
    let raw = ''; for await (const b of req) raw += b;
    const body = JSON.parse(raw); llm.calls.push(body); llm.auth.push(req.headers.authorization === `Bearer ${KEY}`);
    const system = body.messages[0].content, user = JSON.parse(body.messages[1].content);
    if (llm.mode === 'hang') { res.writeHead(200); res.write('{'); return; }
    if (llm.mode === 'delay') await sleep(4000);
    const starts = (user.segments ?? []).map((s) => s.startMs).filter((x) => x !== undefined);
    let antwort;
    if (system.includes('Kapitel')) antwort = { content: 'x', data: { chapters: llm.mode === 'bad' ? [{ startMs: 1234, title: 'Erfunden' }] : [{ startMs: starts[0], title: 'Einstieg' }, { startMs: starts[2], title: 'Hauptteil' }, { startMs: starts[5], title: 'Ausblick' }] } };
    else if (system.includes('zehn Titel')) antwort = { content: 'x', data: { titles: Array.from({ length: 10 }, (_, i) => `Titel ${i + 1}`) } };
    else antwort = { content: `## Entwurf\n\n<script>window.__xss=1</script> **Äpfel & Birnen** – ${user.brief ? 'aus Brief' : 'aus Transkript'}`, data: null };
    res.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(antwort) } }],
      ...(llm.mode === 'nousage' ? {} : { usage: { prompt_tokens: 120, completion_tokens: 80 } }) }));
    offen.delete(res);
  });
  await new Promise((r) => llmDienst.listen(0, '127.0.0.1', r));
  return { STUDIO_LLM_DRIVER: 'openai', OPENAI_API_KEY: KEY, STUDIO_LLM_BASE_URL: `http://127.0.0.1:${llmDienst.address().port}/v1`, STUDIO_LLM_TIMEOUT_MS: '6000' };
}

async function serverStart({ asr, llmEnv, base = '', dist = buildRoot }) {
  app = await createStudioServer({
    origins: B, cookieInsecure: true, dataDir: dir, base, dist,
    asrEnv: { STUDIO_ASR_DRIVER: 'studio-asr-v1', STUDIO_ASR_URL: asr, STUDIO_ASR_TOKEN: 'pa9-asr-fixture' },
    llmEnv: llmEnv ?? {},
  });
  await new Promise((res, rej) => { app.server.once('error', rej); app.server.listen(PORT, '127.0.0.1', res); });
}
async function serverStop() { if (app) { app.server.closeAllConnections(); await app.close(); } app = null; }

const ffmpeg = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const ueberlauf = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function bild(p, name, { breite = true } = {}) {
  await p.screenshot({ path: path.join(out, `${name}-1280.png`), fullPage: true });
  if (!breite) return;
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(250);
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
const rolle = (p, name) => p.locator('.start-agent', { has: p.locator('.start-agent__name', { hasText: name }) }).click();
const llmJobs = () => app.ctx.db.sql.prepare("SELECT * FROM jobs WHERE kind='llm' ORDER BY created_at").all();

try {
  await mkdir(out, { recursive: true });
  dir = await mkdtemp(path.join(os.tmpdir(), 'pa9-daten-'));
  medien = await mkdtemp(path.join(os.tmpdir(), 'pa9-medien-'));
  const mp3 = path.join(medien, 'folge.mp3');
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=440:d=40', '-c:a', 'libmp3lame', '-b:a', '64k', mp3);

  const db = openDB(path.join(dir, 'studio.sqlite')); await migrate(db, path.join(dir, 'studio.sqlite'));
  const setup = ownerCreate({ db, base: '' }, EMAIL, 'Pa Neun'); db.close();
  const setupToken = setup.url.split('/einladung/')[1];

  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await c.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
  const p = await c.newPage();
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) konsole.push(`${m.type()}: ${m.text()} @ ${m.location()?.url ?? ''}`); });
  p.on('pageerror', (e) => konsole.push(`PAGEERROR ${e}`));
  // Jeder KI-Aufruf des Browsers wird mitgeschrieben (Beleg: nichts beim Laden/Rollenwechsel).
  const kiReq = [];
  p.on('request', (r) => { if (r.method() === 'POST' && /\/api\/(llm\/estimate|projects\/[^/]+\/generations)$/.test(r.url())) kiReq.push({ url: r.url(), key: r.headers()['idempotency-key'] ?? null, body: r.postData() }); });
  const asr = await asrStart();

  // ───────── Phase 1: ohne LLM-Konfiguration ─────────
  await serverStart({ asr });
  await p.goto(B + '/anmelden');
  ok((await call(p, 'POST', `/auth/token/${setupToken}`, { password: PW })).status === 200, 'Eigentümer eingerichtet (Einmal-Link)');
  const me = (await call(p, 'GET', '/session')).body.user;
  const projekt = (await call(p, 'POST', '/projects', { title: 'PA9 Testprojekt' })).body.id;
  await p.goto(`${B}/hochladen?projekt=${projekt}`);
  await p.locator('#hochladen-datei').setInputFiles(mp3);
  await p.getByText(/Abschnitt\(e\)/).waitFor();
  await p.locator('#hochladen-name').fill('Sprecherin Eins');
  await p.getByRole('button', { name: 'Hochladen', exact: true }).click();
  let spur;
  for (let i = 0; i < 120 && spur?.status !== 'ready'; i++) { await sleep(500); spur = (await call(p, 'GET', `/projects/${projekt}`)).body.recordings.flatMap((x) => x.tracks)[0]; }
  ok(spur?.status === 'ready', 'Testspur hochgeladen und verarbeitet');
  ok((await call(p, 'POST', `/tracks/${spur.id}/transcription`, {}, { 'Idempotency-Key': 'pa9-asr-1' })).status === 202, 'Transkription gestartet (ASR-Testdienst)');
  for (let i = 0; i < 120 && spur.transcription?.status !== 'ready'; i++) { await sleep(500); spur = (await call(p, 'GET', `/tracks/${spur.id}`)).body; }
  ok(spur.transcription.status === 'ready', 'Transkript fertig (10 Segmente à 4 s, Testdienst)');

  const cap0 = (await call(p, 'GET', '/capabilities')).body.llm;
  ok(cap0.state === 'configuration_required', `capabilities.llm = configuration_required (fehlt: ${cap0.missing.join(', ')})`);
  await p.goto(`${B}/projekte/${projekt}/erstellt`);
  await p.getByText(/Text-KI: Einrichtung fehlt/).waitFor();
  ok(await p.getByRole('button', { name: 'Prüfen und erstellen' }).isDisabled(), 'U14 Reiter: „Einrichtung fehlt“, Auslöser gesperrt');
  ok(await p.getByText('Noch nichts erstellt').isVisible(), 'U14 keine Attrappe: leere Ergebnisliste');
  await bild(p, '01-erstellt-einrichtung-fehlt');
  await p.goto(B + '/');
  await p.locator('.start-chip', { hasText: 'Aufnahme ausarbeiten' }).getByText('Einrichtung fehlt').waitFor();
  await rolle(p, 'Marketer');
  await p.locator('.start-chip', { hasText: 'Shownotes schreiben' }).getByText('Einrichtung fehlt').waitFor();
  ok((await p.locator('[aria-label="Marketer"] button.start-chip').count()) === 0, 'U14 Marketer-Aufgaben ohne Schlüssel sichtbar „Einrichtung fehlt“, nicht klickbar');
  await bild(p, '02-agenten-einrichtung-fehlt');
  await rolle(p, 'Editor');
  ok(await p.getByText('Editor: noch nicht verfügbar').isVisible() && await p.locator('.start-chip', { hasText: 'Episode schneiden' }).getByText('TBD').isVisible(), 'Editor bleibt TBD (kein Schnitt aus Text)');
  await rolle(p, 'Clipper');
  ok(await p.locator('.start-chip', { hasText: 'Kurze Clips finden' }).getByText('TBD').isVisible(), 'Clipper bleibt TBD');
  ok(kiReq.length === 0 && llmJobs().length === 0, 'Phase 1: kein Schätz-/Erzeugungsaufruf, kein LLM-Auftrag');
  await serverStop();

  // ───────── Phase 2: echter Server mit Treiber openai → lokaler Testanbieter ─────────
  await serverStart({ asr, llmEnv: await llmStart() });
  ok((await call(p, 'PUT', '/admin/settings', { llmModel: 'pa9-testmodell', llmPrices: { inputMicroPerMTok: 1000000, outputMicroPerMTok: 5000000 } })).status === 200, 'Modell/Preise als Testwerte gepflegt (Verwaltung)');
  ok((await call(p, 'GET', '/capabilities')).body.llm.state === 'ready', 'capabilities.llm = ready');

  await p.goto(B + '/');
  for (const r of ['Marketer', 'Editor', 'Clipper', 'Producer', 'Marketer']) { await rolle(p, r); await p.waitForTimeout(150); }
  ok(await p.locator('button.start-chip', { hasText: 'Shownotes schreiben' }).isEnabled(), 'Marketer-Aufgaben bei llm.ready auslösbar');
  await p.goto(`${B}/projekte/${projekt}/erstellt`);
  await p.getByRole('button', { name: 'Prüfen und erstellen' }).waitFor();
  await p.waitForTimeout(500);
  ok(kiReq.length === 0 && llm.calls.length === 0, 'Kein Senden beim Seitenladen/Rollenwechsel (0 Schätzungen, 0 Anbieteraufrufe)');

  // U11 Bestätigungsdialog, Abbrechen sendet nichts
  await p.getByRole('button', { name: 'Prüfen und erstellen' }).click();
  const dlg = p.locator('dialog.ki-dialog');
  await dlg.getByRole('heading', { name: 'An KI-Anbieter senden?' }).waitFor();
  const dtext = await dlg.innerText();
  ok(/OpenAI/.test(dtext) && /pa9-testmodell/.test(dtext) && /Transkripttext.*kein Audio, kein Video/s.test(dtext) && /Token/.test(dtext) && /Restkontingent/.test(dtext),
    'U11 Dialog: Anbieter, Modell, gesendeter Datenumfang (kein Audio/Video), Tokenbedarf, Restkontingent');
  ok(!/USD|\$|€/.test(dtext), 'U11 keine Preise in der UI (nur Token aus Estimate)');
  ok(await dlg.getByRole('button', { name: 'Senden' }).isDisabled(), 'U11 Senden erst nach ausdrücklicher Einwilligung');
  await bild(p, '03-dialog', { breite: false });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(200);
  ok(await ueberlauf(p), '03-dialog: 390 px ohne horizontalen Überlauf');
  await p.screenshot({ path: path.join(out, '03-dialog-390.png') });
  await p.setViewportSize({ width: 1280, height: 800 });
  await dlg.getByRole('button', { name: 'Abbrechen' }).click();
  ok(kiReq.filter((r) => r.url.endsWith('/generations')).length === 0 && llm.calls.length === 0 && llmJobs().length === 0, 'U11 Abbrechen: nur Schätzung, kein Auftrag, kein Anbieteraufruf');

  // Erfolg Shownotes
  await p.getByRole('button', { name: 'Prüfen und erstellen' }).click();
  await dlg.getByRole('checkbox').check();
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await p.locator('.projekte-ergebnis').waitFor({ timeout: 20000 });
  const gens = kiReq.filter((r) => r.url.endsWith('/generations'));
  ok(gens.length === 1 && /^[a-f0-9]{32}$/.test(gens[0].key), 'Genau ein Erzeugungsaufruf mit Idempotency-Key');
  const gesendet = JSON.parse(gens[0].body);
  ok(JSON.stringify(gesendet) === JSON.stringify({ task: 'shownotes', trackId: spur.id, consent: { provider: 'openai', model: 'pa9-testmodell', dataScope: 'transcript_text' } }), 'Gesendet = unveränderte geschätzte Eingabe + Einwilligung aus Estimate');
  const anbieter = JSON.stringify(llm.calls[0]);
  ok(llm.calls.length === 1 && llm.auth[0] && !anbieter.includes(EMAIL) && !anbieter.includes(me.id) && anbieter.includes('Thema 3') && !/audio|base64/i.test(JSON.stringify(llm.calls[0].messages[1])),
    'L3 Anbieter erhielt genau 1 Anfrage: Transkripttext, keine E-Mail/Konto-ID, kein Audio');
  const ergebnisText = await p.locator('.projekte-ergebnis__text').innerText();
  ok(ergebnisText.includes('<script>window.__xss=1</script>') && (await p.locator('.projekte-ergebnis script').count()) === 0 && !(await p.evaluate(() => window.__xss)),
    'Ergebnis nur als Text (Skript-Tag sichtbar, nicht ausgeführt, kein innerHTML)');
  ok(await p.getByText('KI-Entwurf').isVisible() && /200 Token/.test(await p.locator('.projekte-ergebnis__kopf').innerText()), 'U12 Detail: KI-Entwurf, Modell, gemeldeter Verbrauch');
  await p.getByRole('button', { name: 'Kopieren' }).click();
  await p.getByText('In die Zwischenablage kopiert.').waitFor();
  const gen = (await call(p, 'GET', `/projects/${projekt}/generations`)).body[0];
  ok(await p.evaluate(() => navigator.clipboard.readText()) === gen.content, 'U12 Kopieren = Ergebnistext');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('link', { name: 'Textdatei herunterladen' }).click()]);
  const dlPfad = path.join(medien, 'dl.md'); await dl.saveAs(dlPfad);
  ok((await readFile(dlPfad, 'utf8')) === gen.content && dl.url().endsWith(`/api/generations/${gen.id}/file`), `U12 Download über eigene API (${dl.suggestedFilename()}) = Ergebnistext, UTF-8`);
  await bild(p, '04-ergebnis-shownotes');

  // Kapitel + U13 springen
  await p.locator('.projekte-ki select').first().selectOption('chapters');
  await p.getByRole('button', { name: 'Prüfen und erstellen' }).click();
  await dlg.getByRole('checkbox').check();
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await p.locator('.projekte-kapitel__knopf').first().waitFor({ timeout: 20000 });
  const kap = p.locator('.projekte-kapitel__knopf');
  ok((await kap.count()) === 3 && /00:00:08\s*Hauptteil/.test(await kap.nth(1).innerText()), 'Kapitelliste mit echten Segmentanfängen');
  await p.locator('.projekte-kapitel audio').evaluate((a) => new Promise((r) => (a.readyState >= 1 ? r() : a.addEventListener('loadedmetadata', r, { once: true }))));
  await kap.nth(2).click();
  await p.waitForTimeout(400);
  const t = await p.locator('.projekte-kapitel audio').evaluate((a) => { a.pause(); return a.currentTime; });
  ok(Math.abs(t - 20) <= 0.6, `U13 Kapitel „Ausblick“ springt im Player auf 20 s (ist ${t.toFixed(2)} s)`);
  await bild(p, '05-kapitel');

  // Titel
  await p.locator('.projekte-ki select').first().selectOption('titles');
  await p.getByRole('button', { name: 'Prüfen und erstellen' }).click();
  await dlg.getByRole('checkbox').check();
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await p.locator('.projekte-ergebnis h3', { hasText: 'Titelvorschläge' }).waitFor({ timeout: 20000 });
  ok(/10\. Titel 10/.test(await p.locator('.projekte-ergebnis__text').innerText()), 'Titelvorschläge (10) angezeigt');
  ok((await p.locator('.projekte-ergebnisse__liste li').count()) === 3, 'U12 Ergebnisliste: 3 Ergebnisse, neueste zuerst');

  // Ungültige Antwort (erfundene Kapitelzeit) → fehlgeschlagen, kein Retry-Knopf
  llm.mode = 'bad';
  await p.locator('.projekte-ki select').first().selectOption('chapters');
  await p.getByRole('button', { name: 'Prüfen und erstellen' }).click();
  await dlg.getByRole('checkbox').check();
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await p.locator('.ki-job__status--fehlgeschlagen').waitFor({ timeout: 20000 });
  ok(/erfundene Kapitelzeit/.test(await p.locator('.projekte-ki__jobs').innerText()) && (await p.locator('.projekte-ki__jobs').getByRole('button', { name: /Erneut/ }).count()) === 0, 'L5 llm_bad_response sichtbar, kein automatisches/gleiches Wiederholen');

  // Unklar nach Versand (Anbieter hängt) → konservativ, kein zweiter Versand
  llm.mode = 'hang';
  await p.locator('.projekte-ki select').first().selectOption('social');
  await p.getByRole('button', { name: 'Prüfen und erstellen' }).click();
  await dlg.getByRole('checkbox').check();
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await p.locator('.ki-job__status--unklar').waitFor({ timeout: 20000 });
  const vor = llm.calls.length;
  await p.waitForTimeout(6000);
  ok(llm.calls.length === vor && /nicht.*automatisch erneut gesendet/s.test(await p.locator('.projekte-ki__jobs').innerText()) && await p.locator('.projekte-ki__jobs').getByText('Verbrauch geschätzt').first().isVisible(),
    'L6 „Ergebnis unklar“ + Verbrauch geschätzt, nach 6 s kein zweiter Anbieteraufruf');
  const unklar = llmJobs().at(-1);
  {
    const r = await call(p, 'POST', `/jobs/${unklar.id}/retry`, {});
    ok(r.status === 409 && r.body.error.code === 'new_job_required', 'Server: unklarer Auftrag nur als neuer Auftrag (409 new_job_required)');
  }
  await p.reload();
  await p.locator('.ki-job__status--unklar').waitFor();
  ok(await p.locator('.ki-job__status--fehlgeschlagen').count() >= 1, 'Nach Neuladen: unklare/fehlgeschlagene Aufträge weiter sichtbar (nur gelesen)');
  await bild(p, '06-auftraege-fehler-unklar');

  // Abbrechen während Verarbeitung
  llm.mode = 'delay';
  await p.getByRole('button', { name: 'Prüfen und erstellen' }).click();
  await dlg.getByRole('checkbox').check();
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await p.locator('.projekte-ki__jobs').getByRole('button', { name: 'Abbrechen' }).first().click();
  await p.locator('.ki-job__status--abgebrochen').waitFor({ timeout: 20000 });
  const abg = llmJobs().at(-1);
  ok(abg.status === 'canceled' && JSON.parse(abg.state).sent === true, 'Laufender (bereits gesendeter) Auftrag abgebrochen → „Abgebrochen“');
  const abgZeile = p.locator('.projekte-ki__job', { has: p.locator('.ki-job__status--abgebrochen') }).first();
  ok(await abgZeile.getByText('Verbrauch geschätzt').isVisible() && /nicht.*automatisch erneut gesendet/s.test(await abgZeile.innerText()), 'Abbruch nach Versand: Hinweis „möglicherweise berechnet, kein automatischer Neuversand“');
  llm.mode = 'ok';

  // Einwilligung veraltet (Modell inzwischen umgestellt) → 400, nichts gesendet
  const vorCalls = llm.calls.length;
  await p.getByRole('button', { name: 'Prüfen und erstellen' }).click();
  await dlg.getByRole('checkbox').check();
  ok((await call(p, 'PUT', '/admin/settings', { llmModel: 'pa9-testmodell-neu' })).status === 200, 'Modell im Hintergrund umgestellt');
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await p.getByText(/Anbieter oder Modell haben sich geändert/).waitFor();
  ok(llm.calls.length === vorCalls, 'L2 veraltete Einwilligung: 400 consent_required sichtbar, kein Anbieteraufruf');
  await call(p, 'PUT', '/admin/settings', { llmModel: 'pa9-testmodell' });

  // Kontingent reicht nicht → Senden gesperrt
  const plan = (await call(p, 'GET', '/admin/plans')).body.find((x) => x.id === 'intern');
  await call(p, 'PUT', '/admin/plans/intern', { ...plan, id: undefined, llmTokensMonth: 100 });
  await p.getByRole('button', { name: 'Prüfen und erstellen' }).click();
  await dlg.getByText('Kontingent reicht nicht – senden ist nicht möglich.').waitFor();
  ok(await dlg.getByRole('checkbox').isDisabled() && await dlg.getByRole('button', { name: 'Senden' }).isDisabled() && /Restkontingent\s*0 Token/.test(await dlg.innerText()), 'L7 Kontingent: Rest 0, Senden gesperrt');
  await p.screenshot({ path: path.join(out, '07-dialog-kontingent-1280.png') });
  await dlg.getByRole('button', { name: 'Abbrechen' }).click();
  await call(p, 'PUT', '/admin/plans/intern', { ...plan, id: undefined });

  // Producer › Aufnahme ausarbeiten (Brief) über Startseite
  const vorBrief = kiReq.length;
  await p.goto(B + '/');
  await p.locator('#start-prod-brief').fill('Gast: Bäckerin Anna. Themen: Sauerteig, Ausbildung.');
  await p.locator('#start-prod-projekt').selectOption(projekt);
  ok(kiReq.length === vorBrief, 'Brief tippen sendet nichts');
  await p.locator('button.start-chip', { hasText: 'Aufnahme ausarbeiten' }).click();
  await p.getByRole('button', { name: 'Aufnahme ausarbeiten …' }).click();
  await dlg.getByRole('heading', { name: 'An KI-Anbieter senden?' }).waitFor();
  ok(/Aufnahmebrief und der Projekttitel – kein Audio, kein Video/.test(await dlg.innerText()), 'Producer: Datenumfang Aufnahmebrief angezeigt');
  await dlg.getByRole('checkbox').check();
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await p.getByRole('link', { name: /Ausarbeitung öffnen/ }).waitFor({ timeout: 20000 });
  ok(JSON.parse(kiReq.at(-1).body).brief === 'Gast: Bäckerin Anna. Themen: Sauerteig, Ausbildung.' && JSON.parse(llm.calls.at(-1).messages[1].content).brief.includes('Bäckerin'), 'Producer: Brief unverändert gesendet');
  await bild(p, '08-producer-ausarbeitung');
  await p.getByRole('link', { name: /Ausarbeitung öffnen/ }).click();
  await p.locator('.projekte-ergebnis h3', { hasText: 'Aufnahme ausarbeiten' }).waitFor();
  ok(/aus Aufnahmebrief/.test(await p.locator('.projekte-ergebnis__kopf').innerText()), 'Producer-Ergebnis im Projekt unter „Erstellt für Dich“');

  // Marketer-Chip → Reiter mit Vorauswahl, ohne Senden
  const vorM = kiReq.length;
  await p.goto(B + '/');
  await rolle(p, 'Marketer');
  await p.locator('button.start-chip', { hasText: 'Social-Media-Posts entwerfen' }).click();
  await p.waitForURL(/\/erstellt\?aufgabe=social/);
  ok(await p.locator('.projekte-ki select').first().inputValue() === 'social' && kiReq.length === vorM, 'Marketer-Chip öffnet Reiter mit Vorauswahl, sendet nichts');
  await serverStop();

  // ───────── Basis /podcast/ ─────────
  await serverStart({ asr, llmEnv: await (async () => ({ STUDIO_LLM_DRIVER: 'openai', OPENAI_API_KEY: KEY, STUDIO_LLM_BASE_URL: `http://127.0.0.1:${llmDienst.address().port}/v1` }))(), base: '/podcast', dist: buildPodcast });
  await p.goto(`${B}/podcast/projekte/${projekt}/erstellt?ergebnis=${gen.id}`);
  if (await p.locator('input[type=email]').isVisible({ timeout: 3000 }).catch(() => false)) { // Sitzung gilt evtl. nicht für die Basis
    await p.locator('input[type=email]').fill(EMAIL); await p.locator('input[type=password]').fill(PW);
    await p.getByRole('button', { name: /Anmelden/ }).click();
    await p.waitForTimeout(1000);
    await p.goto(`${B}/podcast/projekte/${projekt}/erstellt?ergebnis=${gen.id}`);
  }
  await p.locator('.projekte-ergebnis').waitFor();
  ok((await p.getByRole('link', { name: 'Textdatei herunterladen' }).getAttribute('href')) === `/podcast/api/generations/${gen.id}/file`, 'Basis /podcast/: Reiter lädt, Download-URL mit Basis-Pfad');
  ok(await p.getByRole('link', { name: 'Erstellt für Dich' }).getAttribute('href') === `/podcast/projekte/${projekt}/erstellt`, 'Basis /podcast/: Reiter-Link relativ zur Basis');
  await serverStop();

  const unerwartet = konsole.filter((k) => !/Failed to load resource: the server responded with a status of (400|409|503)/.test(k));
  ok(unerwartet.length === 0, `Konsole ohne unerwartete Fehler (${konsole.length} erwartete HTTP-Fehlermeldungen)`);
} catch (e) {
  console.error('ABBRUCH', e?.stack ?? e);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(out, 'ergebnis.json'), JSON.stringify({ results, konsole, llmAufrufe: llm.calls.length }, null, 2)).catch(() => {});
  await browser?.close().catch(() => {});
  await serverStop().catch(() => {});
  for (const r of offen) r.destroy();
  asrDienst?.closeAllConnections?.(); asrDienst?.close();
  llmDienst?.closeAllConnections?.(); llmDienst?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  if (medien) await rm(medien, { recursive: true, force: true });
  const fail = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fail}/${results.length} bestanden`);
  if (fail) process.exitCode = 1;
}
