// PA6 Browserprüfung gegen den echten PA1-Server (isoliert, Port 8872, Testdaten im Temp-Ordner).
// Aufruf aus App/: node test/ui/pa6-konto.mjs <build-root> <build-podcast> <ausgabeordner>
import { chromium } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDB } from '../../server/db.mjs';
import { migrate } from '../../server/migrate.mjs';
import { ownerCreate } from '../../server/accounts.mjs';
import { createStudioServer } from '../../server/index.mjs';

const [buildRoot, buildPodcast, out] = process.argv.slice(2).map((p) => path.resolve(p));
const PORT = 8872, ORIGIN = `http://127.0.0.1:${PORT}`;
const results = [], konsole = [];
const ok = (b, msg) => { results.push({ pass: !!b, msg }); console.log(b ? 'OK  ' : 'FAIL', msg); if (!b) throw Error(msg); };
const PW = { a: 'eigentuemer-pass-1', b1: 'mitglied-pass-01', b2: 'mitglied-pass-02', b3: 'mitglied-pass-03' };
let browser, app, dir;

async function server(base, dist) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pa6-daten-'));
  const db = openDB(path.join(dir, 'studio.sqlite')); await migrate(db, path.join(dir, 'studio.sqlite')); db.close();
  app = await createStudioServer({ origins: ORIGIN, cookieInsecure: true, dataDir: dir, base, dist });
  await new Promise((res, rej) => { app.server.once('error', rej); app.server.listen(PORT, '127.0.0.1', res); });
}
async function stop() { if (app) await app.close(); app = null; if (dir) await rm(dir, { recursive: true, force: true }); dir = null; }
function owner(base) { const db = openDB(path.join(dir, 'studio.sqlite')); try { return ownerCreate({ db, base }, 'owner@pa6.test', 'Test Owner'); } finally { db.close(); } }

async function kontext(name, extra = {}) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...extra });
  await c.addInitScript(() => {
    window.__geschuetzt = false;
    new MutationObserver(() => { if (document.querySelector('.shell, .studio-block__titel, .verwaltung')) window.__geschuetzt = true; })
      .observe(document, { childList: true, subtree: true });
  });
  const p = await c.newPage();
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) konsole.push(`[${name}] ${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => konsole.push(`[${name}] PAGEERROR ${e}`));
  p.on('dialog', (d) => d.accept());
  return { c, p };
}
const marke = (p) => p.evaluate(() => { window.__marke = 1; });
const neuGeladen = async (p) => (await p.evaluate(() => window.__marke)) === undefined;
const speicherLeer = (p, token) => p.evaluate((t) => {
  const alles = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + JSON.stringify(history.state ?? null) + location.href;
  return !alles.includes(t);
}, token);
const ueberlauf = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function bild(p, name) {
  await p.screenshot({ path: path.join(out, `${name}-1280.png`), fullPage: true });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(150);
  ok(await ueberlauf(p), `${name}: 390 px ohne horizontalen Überlauf`);
  await p.screenshot({ path: path.join(out, `${name}-390.png`), fullPage: true });
  await p.setViewportSize({ width: 1280, height: 800 });
}
const projektAnlegen = (p, title) => p.evaluate(async (t) => {
  const r = await fetch(location.origin + (document.baseURI.includes('/podcast/') ? '/podcast' : '') + '/api/projects', { method: 'POST', credentials: 'same-origin', headers: { 'X-Studio': '1', 'content-type': 'application/json' }, body: JSON.stringify({ title: t }) });
  return (await r.json()).id;
}, title);
async function anmelden(p, base, email, pw) {
  await p.goto(base + '/anmelden');
  await p.getByLabel('E-Mail').fill(email); await p.getByLabel('Kennwort').fill(pw);
  await p.getByRole('button', { name: 'Anmelden' }).click();
}
async function token(p, url, base) { // liefert Token aus einem angezeigten Link
  return new URL(url).pathname.slice((base + '/einladung/').length);
}

try {
  await mkdir(out, { recursive: true });
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  // ───────────── Wurzel-Build, Basis "/" ─────────────
  await server('', buildRoot);
  const B = ORIGIN;
  // U5 setup_required
  const x = await kontext('ohne-owner');
  await x.p.goto(B + '/projekte');
  await x.p.waitForURL(/\/anmelden\?weiter=%2Fprojekte$/);
  await x.p.getByText('Das Studio ist noch nicht eingerichtet.').waitFor();
  ok(!(await x.p.evaluate(() => window.__geschuetzt)), 'U5/Gate: /projekte ohne Sitzung → /anmelden, geschützter Inhalt nie im DOM');
  ok(await x.p.getByLabel('Kennwort').count() === 0, 'U5: setup_required zeigt Hinweis, kein Formular');
  await bild(x.p, 'u5-setup-required');
  await x.c.close();

  // Owner-Einrichtung per Einmal-Link
  const setup = owner('');
  const setupToken = await token(null, B + setup.url, '');
  const A = await kontext('owner');
  await A.p.goto(B + setup.url);
  await A.p.getByRole('heading', { name: 'Studio einrichten' }).waitFor();
  ok(new URL(A.p.url()).pathname === '/einladung', 'Token sofort aus Adresszeile entfernt (' + new URL(A.p.url()).pathname + ')');
  ok(await speicherLeer(A.p, setupToken), 'Setup-Token weder in local-/sessionStorage, history.state noch URL');
  await bild(A.p, 'u2-einrichtung');
  await A.p.getByLabel(/^Neues Kennwort/).fill(PW.a); await A.p.getByLabel('Kennwort wiederholen').fill(PW.a);
  await marke(A.p);
  await A.p.getByRole('button', { name: 'Kennwort speichern' }).click();
  await A.p.waitForURL(B + '/'); await A.p.locator('.sidebar__konto-name', { hasText: 'Test Owner' }).waitFor();
  ok(await neuGeladen(A.p), 'Nach Einrichtung vollständiges Neuladen, Owner angemeldet');
  ok(await speicherLeer(A.p, setupToken), 'Setup-Token auch nach Anmeldung nicht im Browserspeicher');
  const wieder = await kontext('token-reuse');
  await wieder.p.goto(B + setup.url); await wieder.p.getByRole('heading', { name: 'Link nicht verwendbar' }).waitFor();
  ok(true, 'Benutzter Setup-Link → „Link nicht verwendbar“'); await wieder.c.close();

  // U4 Verwaltung: Einladungen
  await A.p.getByRole('link', { name: 'Verwaltung' }).click();
  await A.p.getByRole('heading', { name: 'Verwaltung' }).waitFor();
  await A.p.locator('.verwaltung-zeile', { hasText: 'owner@pa6.test' }).waitFor();
  await A.p.getByRole('tab', { name: 'Einladungen' }).click();
  await A.p.getByLabel(/E-Mail \(optional/).fill('b@pa6.test');
  await A.p.getByLabel('Plan').selectOption('pro');
  await A.p.getByRole('button', { name: 'Einladungslink erzeugen' }).click();
  const linkB = await A.p.getByLabel('Einladungslink (Adresse)').inputValue();
  ok(linkB.startsWith(B + '/einladung/'), 'Einladungslink absolut: ' + linkB.slice(0, 40) + '…');
  await bild(A.p, 'u4-einladung-erzeugt');
  await A.p.getByRole('button', { name: 'Schließen' }).click();
  await A.p.getByRole('button', { name: 'Einladungslink erzeugen' }).click(); // ungebunden, wird widerrufen
  const linkWeg = await A.p.getByLabel('Einladungslink (Adresse)').inputValue();
  await A.p.getByRole('button', { name: 'Schließen' }).click();
  ok(await A.p.locator('.verwaltung-zeile', { hasText: 'ohne feste E-Mail' }).count() === 1, 'Ungebundene Einladung gelistet (ohne Token)');
  ok(!(await A.p.locator('body').innerText()).includes(linkWeg.split('/').at(-1)), 'Liste zeigt kein Token');
  await A.p.locator('.verwaltung-zeile', { hasText: 'ohne feste E-Mail' }).getByRole('button', { name: 'Widerrufen' }).click();
  await A.p.locator('.verwaltung-zeile', { hasText: 'ohne feste E-Mail' }).waitFor({ state: 'detached' });
  const wd = await kontext('widerrufen'); await wd.p.goto(linkWeg); await wd.p.getByRole('heading', { name: 'Link nicht verwendbar' }).waitFor();
  ok(true, 'Widerrufene Einladung → „Link nicht verwendbar“'); await wd.c.close();
  for (const [tab, id] of [['Pläne', 'plaene'], ['Verbrauch', 'verbrauch'], ['Einstellungen', 'einstellungen'], ['Archiv', 'archiv']]) {
    await A.p.getByRole('tab', { name: tab }).click();
    const panel = A.p.locator(`#vw-panel[aria-labelledby="vw-tab-${id}"]`);
    await panel.locator('.error, .verwaltung-formular, .konto-zaehler, .konto-daten').first().waitFor();
    const zustand = await panel.locator('.error').count() ? 'Zustand „' + (await panel.locator('.error__title').first().innerText()) + '“' : 'echte Serverdaten';
    ok(true, `Verwaltung/${tab}: ${zustand}`);
    await bild(A.p, 'u4-' + tab.toLowerCase().replace('ä', 'ae'));
    if (tab === 'Pläne' && zustand === 'echte Serverdaten') {
      const form = A.p.locator('.verwaltung-formular', { hasText: 'free' }), feld = form.getByLabel('Transkription / Monat (min)');
      const vorher = await feld.inputValue();
      await feld.fill('61'); await form.getByRole('button', { name: 'Plan speichern' }).click(); await form.getByText('Gespeichert.').waitFor();
      await A.p.reload(); await A.p.locator('.verwaltung-formular', { hasText: 'free' }).getByLabel('Transkription / Monat (min)').waitFor();
      ok(await A.p.locator('.verwaltung-formular', { hasText: 'free' }).getByLabel('Transkription / Monat (min)').inputValue() === '61', 'Plan free gespeichert und neu geladen (61 min)');
      const f2 = A.p.locator('.verwaltung-formular', { hasText: 'free' });
      await f2.getByLabel('Transkription / Monat (min)').fill(vorher); await f2.getByRole('button', { name: 'Plan speichern' }).click(); await f2.getByText('Gespeichert.').waitFor();
    }
    if (tab === 'Einstellungen' && zustand === 'echte Serverdaten') {
      const fe = A.p.getByLabel('Fenstergröße (Sekunden, 60–1200)'), vorher = await fe.inputValue();
      await fe.fill('30'); await A.p.getByRole('button', { name: 'Einstellungen speichern' }).click(); await A.p.getByText(/ASR-Fenster: ganze Sekunden/).waitFor();
      await fe.fill('310'); await A.p.getByRole('button', { name: 'Einstellungen speichern' }).click(); await A.p.getByText('Gespeichert.').waitFor();
      await fe.fill(vorher); await A.p.getByRole('button', { name: 'Einstellungen speichern' }).click(); await A.p.getByText('Gespeichert.').waitFor();
      ok(true, 'Einstellungen: Clientprüfung (30 s abgewiesen), Speichern 310 s und Rücksetzen');
    }
  }

  // U2 Einladung einlösen (Konto B)
  const Bk = await kontext('mitglied', { permissions: ['microphone', 'camera'] });
  const tokenB = await token(null, linkB, '');
  await Bk.p.goto(linkB); await Bk.p.getByRole('heading', { name: 'Einladung annehmen' }).waitFor();
  ok(await Bk.p.getByLabel('E-Mail').inputValue() === 'b@pa6.test' && await Bk.p.getByLabel('E-Mail').getAttribute('readonly') !== null, 'Gebundene E-Mail fest, nicht änderbar');
  await bild(Bk.p, 'u2-einladung');
  await Bk.p.getByLabel('Anzeigename').fill('B Mitglied');
  await Bk.p.getByLabel(/^Neues Kennwort/).fill('zu-kurz'); await Bk.p.getByLabel('Kennwort wiederholen').fill('zu-kurz');
  await Bk.p.getByRole('button', { name: 'Konto anlegen' }).click();
  await Bk.p.getByText(/mindestens 10 Zeichen/).waitFor(); ok(true, 'Zu kurzes Kennwort clientseitig abgewiesen');
  await Bk.p.getByLabel(/^Neues Kennwort/).fill(PW.b1); await Bk.p.getByLabel('Kennwort wiederholen').fill(PW.b1);
  await marke(Bk.p); await Bk.p.getByRole('button', { name: 'Konto anlegen' }).click();
  await Bk.p.waitForURL(B + '/'); await Bk.p.locator('.sidebar__konto-name', { hasText: 'B Mitglied' }).waitFor();
  ok(await neuGeladen(Bk.p) && await speicherLeer(Bk.p, tokenB), 'U2: Einladung eingelöst, Neuladen, Token nicht gespeichert');
  ok(await Bk.p.getByRole('link', { name: 'Verwaltung' }).count() === 0, 'Mitglied: kein Verwaltungseintrag');
  await Bk.p.goto(B + '/verwaltung'); await Bk.p.getByRole('heading', { name: 'Seite nicht gefunden' }).waitFor();
  ok(true, 'Mitglied: /verwaltung → nicht gefunden');

  // Fremddatenfreiheit
  const pidA = await projektAnlegen(A.p, 'A-Geheimprojekt'), pidB = await projektAnlegen(Bk.p, 'B-Projekt');
  await Bk.p.goto(B + '/projekte'); await Bk.p.getByText('B-Projekt').first().waitFor();
  ok(!(await Bk.p.locator('body').innerText()).includes('A-Geheimprojekt'), 'B sieht nur eigene Projekte');
  await Bk.p.goto(B + '/projekte/' + pidA); await Bk.p.waitForTimeout(800);
  ok(!(await Bk.p.locator('body').innerText()).includes('A-Geheimprojekt'), 'B: fremdes Projekt per ID nicht sichtbar');
  await A.p.goto(B + '/projekte'); await A.p.getByText('A-Geheimprojekt').first().waitFor();
  ok(!(await A.p.locator('body').innerText()).includes('B-Projekt'), 'A sieht B-Projekt nicht');
  await A.p.goto(B + '/verwaltung'); await A.p.locator('.verwaltung-zeile', { hasText: 'b@pa6.test' }).waitFor();
  await bild(A.p, 'u4-konten');

  // U3 Konto
  await Bk.p.goto(B + '/konto'); await Bk.p.getByRole('heading', { name: 'Konto', exact: true }).waitFor();
  await Bk.p.getByText('Verbrauch: noch nicht verfügbar').or(Bk.p.locator('.konto-zaehler').first()).first().waitFor();
  ok(true, 'U3: Konto ' + ((await Bk.p.getByText('Verbrauch: noch nicht verfügbar').count()) ? 'zeigt „Verbrauch: noch nicht verfügbar“ (kein erfundener Wert)' : 'zeigt Serververbrauch'));
  ok((await Bk.p.locator('.konto-daten').innerText()).includes('b@pa6.test'), 'U3: Profil mit eigener E-Mail');
  await bild(Bk.p, 'u3-konto');

  // Studio: studio:abgemeldet darf nichts abbauen
  await Bk.p.goto(B + '/studio/' + pidB);
  await Bk.p.locator('.studio-block__titel').first().waitFor({ timeout: 15000 });
  await Bk.p.evaluate(() => { window.__marke = 1; window.__el = document.querySelector('.studio'); });
  const studioUrl = Bk.p.url();
  await Bk.p.evaluate(() => window.dispatchEvent(new Event('studio:abgemeldet'))); await Bk.p.waitForTimeout(1500);
  const diag = { url: Bk.p.url() === studioUrl, reload: await neuGeladen(Bk.p), verbunden: await Bk.p.evaluate(() => window.__el?.isConnected) };
  ok(diag.url && !diag.reload && diag.verbunden, 'studio:abgemeldet auf /studio/:id: kein Redirect, kein Reload, kein Unmount ' + JSON.stringify(diag));
  await Bk.p.evaluate(() => window.dispatchEvent(new Event('studio:angemeldet'))); await Bk.p.waitForTimeout(800);
  ok(Bk.p.url() === studioUrl && await Bk.p.evaluate(() => window.__el.isConnected), 'studio:angemeldet: Studio bleibt gemountet');
  await Bk.p.evaluate(() => window.dispatchEvent(new Event('studio:abgemeldet')));
  const overlay = await Bk.p.locator('[data-testid="studio-reauth"]').count();
  ok(true, 'Studio-eigene Anmeldeüberlagerung (PA7) sichtbar: ' + (overlay ? 'ja – PA6 baut keine zweite' : 'nein (PA7 noch nicht integriert)'));
  // Überlagerung fängt Zeiger ab; Navigation per DOM-Klick auf den Router-Link simuliert „Studio verlassen“.
  await Bk.p.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Zum Projekt')).click());
  await Bk.p.waitForURL(B + '/projekte/' + pidB); await Bk.p.getByText('B-Projekt').first().waitFor();
  ok(await neuGeladen(Bk.p), 'Studio mit abgelaufener Sitzung verlassen → vollständiges Neuladen über /anmelden (Sitzung noch gültig → zurück zum Ziel)');

  // Rücksetz-Link durch Eigentümer, alte Sitzung endet
  await A.p.locator('.verwaltung-zeile', { hasText: 'b@pa6.test' }).getByRole('button', { name: 'Rücksetz-Link' }).click();
  const linkReset = await A.p.getByLabel(/Rücksetz-Link für B Mitglied/).inputValue();
  await A.p.getByRole('button', { name: 'Schließen' }).click();
  const B2 = await kontext('mitglied-2');
  await B2.p.goto(linkReset); await B2.p.getByRole('heading', { name: 'Neues Kennwort festlegen' }).waitFor();
  await B2.p.getByLabel(/^Neues Kennwort/).fill(PW.b2); await B2.p.getByLabel('Kennwort wiederholen').fill(PW.b2);
  await B2.p.getByRole('button', { name: 'Kennwort speichern' }).click();
  await B2.p.waitForURL(B + '/'); await B2.p.locator('.sidebar__konto-name', { hasText: 'B Mitglied' }).waitFor();
  ok(true, 'Rücksetz-Link eingelöst, neues Kennwort aktiv');
  await marke(Bk.p);
  await Bk.p.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Projekte' }).click(); // clientseitig → 401 → studio:abgemeldet
  await Bk.p.waitForURL(/\/anmelden\?weiter=%2Fprojekte&grund=abgelaufen$/);
  await Bk.p.getByText(/Sitzung ist abgelaufen/).waitFor();
  ok(await neuGeladen(Bk.p), 'Alte Sitzung nach Rücksetzen: 401 → Neuladen auf /anmelden mit Hinweis');

  // Sperren / Entsperren
  await A.p.locator('.verwaltung-zeile', { hasText: 'b@pa6.test' }).getByRole('button', { name: 'Sperren' }).click();
  await A.p.locator('.verwaltung-zeile', { hasText: 'b@pa6.test' }).getByText('gesperrt').waitFor();
  await B2.p.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Projekte' }).click();
  await B2.p.waitForURL(/grund=abgelaufen/); ok(true, 'Gesperrtes Konto: laufende Sitzung endet → Anmeldeseite');
  await anmelden(B2.p, B, 'b@pa6.test', PW.b2); await B2.p.getByText('E-Mail oder Kennwort ist falsch.').waitFor();
  ok(true, 'Gesperrtes Konto: Anmeldung abgewiesen (gleiche Meldung)');
  await A.p.locator('.verwaltung-zeile', { hasText: 'b@pa6.test' }).getByRole('button', { name: 'Entsperren' }).click();
  await A.p.locator('.verwaltung-zeile', { hasText: 'b@pa6.test' }).getByText('aktiv', { exact: true }).waitFor();
  await anmelden(B2.p, B, 'b@pa6.test', PW.b2); await B2.p.waitForURL(B + '/'); ok(true, 'U1: Nach Entsperren Anmeldung möglich');

  // Kennwortwechsel beendet auch aktuelle Sitzung
  await B2.p.goto(B + '/konto'); await marke(B2.p);
  await B2.p.getByLabel('Aktuelles Kennwort').fill(PW.b2);
  await B2.p.getByLabel(/^Neues Kennwort \(/).fill(PW.b3); await B2.p.getByLabel('Neues Kennwort wiederholen').fill(PW.b3);
  await B2.p.getByRole('button', { name: 'Kennwort ändern' }).click();
  await B2.p.waitForURL(/\/anmelden\?grund=kennwort$/); await B2.p.getByText(/Kennwort geändert/).waitFor();
  ok(await neuGeladen(B2.p), 'Kennwortwechsel → alle Sitzungen beendet, Neuladen auf /anmelden');
  await B2.p.goto(B + '/konto'); await B2.p.waitForURL(/\/anmelden\?weiter=%2Fkonto$/); ok(true, 'Alte Sitzung nach Kennwortwechsel ungültig');
  await B2.p.getByLabel('E-Mail').fill('b@pa6.test'); await B2.p.getByLabel('Kennwort').fill(PW.b3);
  await marke(B2.p); await B2.p.getByRole('button', { name: 'Anmelden' }).click();
  await B2.p.waitForURL(B + '/konto'); await B2.p.getByRole('heading', { name: 'Konto', exact: true }).waitFor();
  ok(await neuGeladen(B2.p), 'U1: Anmelden mit neuem Kennwort → Neuladen, Rücksprung zu /konto');

  // Abmelden über Kontomenü
  await marke(B2.p);
  await B2.p.getByRole('button', { name: 'Kontomenü' }).click(); await B2.p.getByRole('menuitem', { name: 'Abmelden' }).click();
  await B2.p.waitForURL(/\/anmelden\?grund=abgemeldet$/); await B2.p.getByText('Du wurdest abgemeldet.').waitFor();
  ok(await neuGeladen(B2.p), 'U1: Abmelden → vollständiges Neuladen auf /anmelden');
  await B2.p.evaluate(() => { window.__geschuetzt = false; });
  await B2.p.goto(B + '/projekte'); await B2.p.waitForURL(/\/anmelden/);
  ok(!(await B2.p.evaluate(() => window.__geschuetzt)), 'Nach Abmelden kein geschützter Inhalt');
  await bild(B2.p, 'u1-anmelden');
  // 390-px-Schublade mit Kontomenü
  await A.p.setViewportSize({ width: 390, height: 844 }); await A.p.goto(B + '/');
  await A.p.getByRole('button', { name: 'Navigation öffnen' }).click(); await A.p.getByRole('button', { name: 'Kontomenü' }).click();
  await A.p.getByRole('menuitem', { name: 'Verwaltung' }).waitFor();
  ok(await ueberlauf(A.p), 'Schublade + Kontomenü 390 px ohne Überlauf');
  await A.p.screenshot({ path: path.join(out, 'kontomenue-390.png') });
  await browser.close(); browser = await chromium.launch();
  await stop();

  // ───────────── /podcast-Build ─────────────
  await server('/podcast', buildPodcast);
  const P = ORIGIN + '/podcast';
  const s2 = owner('/podcast');
  ok(s2.url.startsWith('/podcast/einladung/'), 'Setup-Link mit Basis /podcast');
  const Q = await kontext('podcast');
  await Q.p.goto(ORIGIN + s2.url); await Q.p.getByRole('heading', { name: 'Studio einrichten' }).waitFor();
  ok(new URL(Q.p.url()).pathname === '/podcast/einladung', '/podcast: Token aus Adresse entfernt');
  await Q.p.getByLabel(/^Neues Kennwort/).fill(PW.a); await Q.p.getByLabel('Kennwort wiederholen').fill(PW.a);
  await Q.p.getByRole('button', { name: 'Kennwort speichern' }).click();
  await Q.p.waitForURL(P + '/'); await Q.p.locator('.sidebar__konto-name', { hasText: 'Test Owner' }).waitFor();
  ok(true, '/podcast: Einrichtung + Anmeldung');
  await Q.p.goto(P + '/verwaltung?bereich=einladungen'); await Q.p.getByRole('button', { name: 'Einladungslink erzeugen' }).click();
  ok((await Q.p.getByLabel('Einladungslink (Adresse)').inputValue()).startsWith(P + '/einladung/'), '/podcast: Einladungslink mit Basis');
  await Q.p.getByRole('button', { name: 'Kontomenü' }).click(); await Q.p.getByRole('menuitem', { name: 'Abmelden' }).click();
  await Q.p.waitForURL(P + '/anmelden?grund=abgemeldet'); ok(true, '/podcast: Abmelden → /podcast/anmelden');
  for (let i = 0; i < 5; i++) {
    await Q.p.getByLabel('E-Mail').fill('owner@pa6.test'); await Q.p.getByLabel('Kennwort').fill('falsches-kennwort-' + i);
    await Q.p.getByRole('button', { name: 'Anmelden' }).click(); await Q.p.getByText('E-Mail oder Kennwort ist falsch.').waitFor();
  }
  await Q.p.getByLabel('Kennwort').fill('falsches-kennwort-x'); await Q.p.getByRole('button', { name: 'Anmelden' }).click();
  await Q.p.getByText(/Zu viele Versuche\. Bitte in \d+ Minuten erneut/).waitFor();
  ok(await Q.p.getByRole('button', { name: 'Anmelden' }).isDisabled(), 'Ratenbegrenzung: Wartezeit sichtbar, Knopf gesperrt');
  await bild(Q.p, 'u1-zu-viele-versuche');
  await Q.p.goto(P + '/projekte'); await Q.p.waitForURL(P + '/anmelden?weiter=%2Fprojekte'); ok(true, '/podcast: Gate leitet auf /podcast/anmelden');
} catch (e) { console.error(e); results.push({ pass: false, msg: String(e) }); process.exitCode = 1; }
finally {
  await browser?.close(); await stop();
  const csp = konsole.filter((k) => /Content Security Policy|Refused to/.test(k));
  const sonst = konsole.filter((k) => !/Failed to load resource: the server responded with a status of (401|404|429|503)/.test(k));
  console.log(`Konsole: ${konsole.length} Meldungen, davon CSP ${csp.length}, außer erwarteten 401/404/429/503-Ressourcenmeldungen ${sonst.length}`);
  for (const k of sonst) console.log('  ', k);
  await writeFile(path.join(out, 'ergebnis.json'), JSON.stringify({ results, konsole }, null, 2));
}
