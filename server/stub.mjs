// API-Stub für AP3/AP4/AP5/AP6 bis AP1/AP2 stehen (Umsetzung.md §10).
// In-Memory, keine Laufzeit-Abhängigkeiten, speichert NICHTS auf Platte, liefert KEINE Mediendateien.
// Wird von AP1 nicht weiterverwendet und in AP7 entfernt.
//
//   STUDIO_PORT=8862 node server/stub.mjs          (Standard 8850, nur 127.0.0.1)
//   STUDIO_BASE_PATH=/podcast  → Präfix wird vorne abgeschnitten (beide Formen erlaubt)
//   STUB_DELAY_MS=2000         → simulierte Dauer für processing/queued
//   STUB_FREE_BYTES=…          → freeBytes in /api/health (z. B. 1e9 für Zustand speicher-knapp)
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.STUDIO_PORT ?? 8850);
const HOST = process.env.STUDIO_HOST ?? "127.0.0.1";
const BASE = (process.env.STUDIO_BASE_PATH ?? "").replace(/\/$/, "");
const DELAY = Number(process.env.STUB_DELAY_MS ?? 2000);
const FREE = Number(process.env.STUB_FREE_BYTES ?? 500e9);
const MAX_CHUNK = 64 * 1024 * 1024;
const MIME = new Map([["audio/webm", "webm"], ["video/webm", "webm"], ["audio/mp4", "m4a"], ["video/mp4", "mp4"]]);

const projects = new Map(); // id → {id,title,createdAt}
const recordings = new Map(); // id → {id,projectId,title,createdAt}
const tracks = new Map(); // id → Track ohne exports + _chunks:Set
const exportsById = new Map();
const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); Object.assign(this, { status, code, extra }); }
}
const notFound = () => new HttpError(404, "not_found", "Nicht gefunden.");

function trackOut(t) {
  const { _chunks, ...rest } = t;
  return { ...rest, exports: [...exportsById.values()].filter((e) => e.trackId === t.id) };
}
function recordingOut(r) {
  return { ...r, tracks: [...tracks.values()].filter((t) => t.recordingId === r.id).map(trackOut) };
}
function projectOut(p) {
  const recs = [...recordings.values()].filter((r) => r.projectId === p.id);
  const last = recs.map((r) => r.createdAt).sort().at(-1) ?? null;
  return { ...p, recordingCount: recs.length, lastRecordingAt: last };
}
function title(body) {
  const t = typeof body?.title === "string" ? body.title.trim() : "";
  if (t.length < 1 || t.length > 120) throw new HttpError(400, "invalid_title", "Titel muss 1–120 Zeichen lang sein.");
  return t;
}
function get(map, id) { const v = map.get(id); if (!v) throw notFound(); return v; }
function contiguous(set) { let n = 0; while (set.has(n)) n++; return n; }

async function readJson(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 1e6) throw new HttpError(413, "too_large", "Anfrage zu groß."); }
  try { return s ? JSON.parse(s) : {}; } catch { throw new HttpError(400, "invalid_json", "Ungültiges JSON."); }
}
async function drain(req) {
  let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_CHUNK) throw new HttpError(413, "chunk_too_large", "Abschnitt größer als 64 MB."); }
  return n;
}

const routes = [
  ["GET", /^\/api\/health$/, () => ({ ok: true, version: "stub", freeBytes: FREE, ffmpeg: true })],
  ["GET", /^\/api\/projects$/, () => [...projects.values()].map(projectOut).sort((a, b) => b.createdAt.localeCompare(a.createdAt))],
  ["POST", /^\/api\/projects$/, async (req, res) => {
    const p = { id: randomUUID(), title: title(await readJson(req)), createdAt: now() };
    projects.set(p.id, p); res.statusCode = 201; return projectOut(p);
  }],
  ["GET", /^\/api\/projects\/([^/]+)$/, (req, res, [id]) => {
    const p = get(projects, id);
    const recs = [...recordings.values()].filter((r) => r.projectId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { ...projectOut(p), recordings: recs.map(recordingOut) };
  }],
  ["PATCH", /^\/api\/projects\/([^/]+)$/, async (req, res, [id]) => {
    const p = get(projects, id); p.title = title(await readJson(req)); return projectOut(p);
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/recordings$/, async (req, res, [id]) => {
    get(projects, id);
    const b = await readJson(req);
    const base = String(b.mimeType ?? "").split(";")[0].trim().toLowerCase();
    if (!MIME.has(base)) throw new HttpError(415, "unsupported_type", "Dateityp nicht unterstützt.");
    const kind = b.kind === "video" ? "video" : "audio";
    const r = { id: randomUUID(), projectId: id, title: title(b), createdAt: now() };
    const t = {
      id: randomUUID(), recordingId: r.id, participantName: String(b.participantName ?? "").slice(0, 120) || "Ich",
      kind, source: "studio", mimeType: String(b.mimeType), status: "uploading", error: null, receivedChunks: 0,
      bytes: 0, durationMs: null, width: null, height: null, sha256: null,
      startedAtMs: Number.isFinite(b.startedAtMs) ? b.startedAtMs : null, lastChunkAt: null, hasRaw: false, _chunks: new Set(),
    };
    recordings.set(r.id, r); tracks.set(t.id, t);
    res.statusCode = 201;
    return { recording: recordingOut(r), track: trackOut(t) };
  }],
  ["PUT", /^\/api\/tracks\/([^/]+)\/chunks\/(\d{1,5})$/, async (req, res, [id, idx]) => {
    const t = get(tracks, id);
    if (t.status !== "uploading") throw new HttpError(409, "not_uploading", "Spur nimmt keine Abschnitte mehr an.");
    const n = await drain(req);
    const i = Number(idx);
    if (!t._chunks.has(i)) t.bytes += n;
    t._chunks.add(i); t.receivedChunks = contiguous(t._chunks); t.lastChunkAt = now();
    return { receivedChunks: t.receivedChunks };
  }],
  ["GET", /^\/api\/tracks\/([^/]+)$/, (req, res, [id]) => trackOut(get(tracks, id))],
  ["POST", /^\/api\/tracks\/([^/]+)\/finalize$/, async (req, res, [id]) => {
    const t = get(tracks, id);
    const b = await readJson(req);
    if (t.status === "processing" || t.status === "ready") return trackOut(t);
    const count = Number(b.chunkCount);
    if (!Number.isInteger(count) || count < 1) throw new HttpError(400, "invalid_chunk_count", "chunkCount fehlt.");
    const missing = [];
    for (let i = 0; i < count; i++) if (!t._chunks.has(i)) missing.push(i);
    if (missing.length && !b.allowPartial) throw new HttpError(409, "chunks_missing", "Es fehlen Abschnitte.", { missing });
    t.status = "processing"; t.error = null;
    setTimeout(() => {
      t.status = "ready"; t.durationMs = Number(b.durationMs) || null;
      if (t.kind === "video") { t.width = 1280; t.height = 720; } // ponytail: Stub-Festwert, echte Werte liefert ffprobe in AP1
    }, DELAY);
    res.statusCode = 202; return trackOut(t);
  }],
  ["GET", /^\/api\/tracks\/([^/]+)\/file$/, (req, res, [id]) => {
    get(tracks, id); throw new HttpError(501, "stub_no_media", "Der Entwicklungs-Stub liefert keine Mediendateien.");
  }],
  ["POST", /^\/api\/tracks\/([^/]+)\/exports$/, async (req, res, [id]) => {
    const t = get(tracks, id);
    const { format } = await readJson(req);
    if (!["mp3", "wav", "mp4"].includes(format) || (format === "mp4" && t.kind !== "video"))
      throw new HttpError(400, "invalid_format", "Format nicht möglich.");
    if (t.status !== "ready") throw new HttpError(409, "track_not_ready", "Spur ist noch nicht bereit.");
    const dup = [...exportsById.values()].find((e) => e.trackId === id && e.format === format && e.status !== "failed");
    res.statusCode = 202;
    if (dup) return dup;
    const e = { id: randomUUID(), trackId: id, format, status: "queued", error: null, bytes: null, createdAt: now(), finishedAt: null };
    exportsById.set(e.id, e);
    setTimeout(() => { e.status = "processing"; }, DELAY / 2);
    setTimeout(() => { e.status = "ready"; e.finishedAt = now(); }, DELAY * 2);
    return e;
  }],
  ["GET", /^\/api\/exports\/([^/]+)$/, (req, res, [id]) => get(exportsById, id)],
  ["GET", /^\/api\/exports\/([^/]+)\/file$/, (req, res, [id]) => {
    const e = get(exportsById, id);
    if (e.status !== "ready") throw new HttpError(409, "export_not_ready", "Export ist noch nicht fertig.");
    throw new HttpError(501, "stub_no_media", "Der Entwicklungs-Stub liefert keine Mediendateien.");
  }],
];

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  let path = new URL(req.url ?? "/", "http://x").pathname;
  if (BASE && path.startsWith(BASE + "/")) path = path.slice(BASE.length);
  try {
    let methodMismatch = false;
    for (const [m, re, fn] of routes) {
      const hit = re.exec(path);
      if (!hit) continue;
      if (m !== req.method) { methodMismatch = true; continue; }
      const out = await fn(req, res, hit.slice(1).map(decodeURIComponent));
      return send(res, res.statusCode || 200, out);
    }
    throw methodMismatch ? new HttpError(405, "method_not_allowed", "Methode nicht erlaubt.") : notFound();
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    const err = e instanceof HttpError ? e : new HttpError(500, "internal", "Interner Fehler.");
    req.resume();
    send(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
  }
}).listen(PORT, HOST, () => console.log(`Podcast-Studio API-Stub auf http://${HOST}:${PORT}${BASE}/api`));
