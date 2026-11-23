import { test, expect } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStudioServer } from '../../server/index.mjs';
import { openDB } from '../../server/db.mjs';

const origin = 'http://127.0.0.1:8871';
async function start(dir, setupEnv) {
  const app = await createStudioServer({ dataDir: dir, origins: origin, cookieInsecure: true, base: '/podcast', setupEnv });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const req = (m, p, b) => fetch('http://127.0.0.1:' + app.server.address().port + '/api' + p, { method: m, headers: { Origin: origin, 'X-Studio': '1', 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { app, req };
}

test('Erststart: frische DB, Admin-Einrichtungslink idempotent, Einlösung legt owner an', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-setup-test-'));
  const file = path.join(dir, 'admin-einrichtung.txt');
  const env = { STUDIO_ADMIN_EMAIL: 'Admin@Example.test', STUDIO_PUBLIC_URL: 'https://studio.example.test/podcast/' };
  try {
    let { app, req } = await start(dir, env);
    const text = await readFile(file, 'utf8');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const url = text.match(/https:\/\/studio\.example\.test\/podcast\/einladung\/[A-Za-z0-9_-]+/)?.[0];
    expect(url).toBeTruthy();
    expect(await (await req('GET', '/session')).json()).toEqual({ user: null, setupRequired: true });
    expect((await req('POST', '/auth/login', { email: 'admin@example.test', password: 'x' })).status).toBe(503);
    await app.close();

    // Zweiter Start: kein neuer Link, Datei unverändert.
    ({ app, req } = await start(dir, env));
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(app.ctx.db.sql.prepare("SELECT count(*) AS n FROM tokens WHERE kind='setup'").get().n).toBe(1);

    const token = url.split('/').at(-1);
    expect((await (await req('GET', '/auth/token/' + token)).json()).kind).toBe('setup');
    const redeemed = await req('POST', '/auth/token/' + token, { password: 'admin-test-password' });
    expect(redeemed.status).toBe(200);
    expect((await redeemed.json()).user).toMatchObject({ email: 'admin@example.test', role: 'owner' });
    expect((await req('POST', '/auth/token/' + token, { password: 'admin-test-password' })).status).toBe(404);
    expect((await (await req('GET', '/session')).json()).setupRequired).toBe(false);
    expect((await req('POST', '/auth/login', { email: 'admin@example.test', password: 'admin-test-password' })).status).toBe(200);
    await app.close();

    // Nach Einrichtung: kein neuer Link, Hinweisdatei bleibt, Link ungültig.
    ({ app, req } = await start(dir, env));
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(app.ctx.db.sql.prepare("SELECT count(*) AS n FROM tokens WHERE kind='setup'").get().n).toBe(1);
    await app.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Erststart ohne STUDIO_ADMIN_EMAIL: kein Link; Altbestand ohne Migration startet nicht', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-setup-test-'));
  const legacy = await mkdtemp(path.join(os.tmpdir(), 'studio-setup-test-'));
  try {
    const { app, req } = await start(dir, {});
    await expect(stat(path.join(dir, 'admin-einrichtung.txt'))).rejects.toThrow();
    expect((await (await req('GET', '/session')).json()).setupRequired).toBe(true);
    await app.close();
    const db = openDB(path.join(legacy, 'studio.sqlite'));
    db.put('projects', { id: 'p1', title: 'Alt' });
    db.close();
    await expect(createStudioServer({ dataDir: legacy, origins: origin, cookieInsecure: true, setupEnv: {} })).rejects.toThrow('Explizite Migration erforderlich');
  } finally { await rm(dir, { recursive: true, force: true }); await rm(legacy, { recursive: true, force: true }); }
});
