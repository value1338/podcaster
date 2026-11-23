// Wiederherstellung unterbrochener Aufnahmen (Tab-Absturz, Netzausfall beim Abschluss) – Umsetzung.md §6.1 Punkt 6.
import { ApiError, type ApiClient, type Track } from "../api";
import { backoffMs, brauchtAnmeldung, frist, istWiederholbar, mitFrist, SENDE_FRIST_MS, STATUS_FRIST_MS } from "./format";
import { idbStore, type ChunkStore, type TrackMeta } from "./store";
import type { PendingRecording } from "./types";

const LOCK_PREFIX = "podcast-studio-aufnahme:";
export const lockName = (trackId: string) => LOCK_PREFIX + trackId;
/** Ohne Web Locks: Aufnahme gilt als verwaist, wenn so lange kein Abschnitt kam (Abschnitte alle 4 s). */
const HEARTBEAT_STALE_MS = 30_000;

const MARKER = "podcast-studio:nicht-lokal:";
type Marker = { chunkCount: number; nichtLokal: number[] };

function leseMarker(trackId: string): Marker {
  try {
    const m = JSON.parse(localStorage.getItem(MARKER + trackId) ?? "null") as Marker | null;
    if (m && Number.isInteger(m.chunkCount) && Array.isArray(m.nichtLokal)) return m;
  } catch { /* kein localStorage */ }
  return { chunkCount: 0, nichtLokal: [] };
}
const vereint = (a: number[] = [], b: number[] = []) => [...new Set([...a, ...b])].sort((x, y) => x - y);

/** Synchron vor jeder asynchronen Sicherung: auch ein hängender Store darf den erzeugten Schluss nicht unsichtbar machen. */
export function vermerkeErzeugt(trackId: string, index: number): boolean {
  try {
    const alt = leseMarker(trackId);
    localStorage.setItem(MARKER + trackId, JSON.stringify({ ...alt, chunkCount: Math.max(alt.chunkCount, index + 1) }));
    return true;
  } catch { return false; }
}

/**
 * F1: Abschnitt `index` konnte nicht lokal gesichert werden. Dauerhaft vermerken (Meta UND localStorage,
 * da IndexedDB gerade gestört ist), damit eine spätere Bergung ihn mitzählt und nicht still lückenhaft abschließt.
 * true = mindestens ein Vermerk gelang.
 */
export async function vermerkeNichtLokal(store: ChunkStore, trackId: string, index: number): Promise<boolean> {
  let ok = false;
  // Unabhängigen Vermerk sofort schreiben, bevor die gestörte IndexedDB überhaupt angefasst wird.
  try {
    const alt = leseMarker(trackId);
    localStorage.setItem(MARKER + trackId, JSON.stringify({ chunkCount: Math.max(alt.chunkCount, index + 1), nichtLokal: vereint(alt.nichtLokal, [index]) }));
    ok = true;
  } catch { /* kein localStorage */ }
  try {
    const m = await mitFrist(store.getMeta(trackId));
    if (m) {
      await mitFrist(store.saveMeta({ ...m, chunkCount: Math.max(m.chunkCount, index + 1), nichtLokal: vereint(m.nichtLokal, [index]) }));
      ok = true;
    }
  } catch { /* IndexedDB gestört */ }
  return ok;
}

/** Lokale Daten einer Aufnahme vollständig entfernen (IndexedDB + Vermerk). */
export async function vergiss(store: ChunkStore, trackId: string): Promise<void> {
  await mitFrist(store.deleteTrack(trackId));
  try { localStorage.removeItem(MARKER + trackId); } catch { /* egal */ }
}

let defaultStore: ChunkStore | null = null;
export const getDefaultStore = () => (defaultStore ??= idbStore());

type Locks = { query(): Promise<{ held?: { name?: string }[] }>; request: LockManager["request"] } | undefined;
const locks = (): Locks => (typeof navigator !== "undefined" ? (navigator as Navigator).locks : undefined);

async function activeTrackIds(): Promise<Set<string> | null> {
  const l = locks();
  if (!l) return null;
  try {
    const q = await l.query();
    return new Set((q.held ?? []).map((h) => h.name ?? "").filter((n) => n.startsWith(LOCK_PREFIX)).map((n) => n.slice(LOCK_PREFIX.length)));
  } catch { return null; }
}

/**
 * Gehört der lokale Eintrag dem Konto `userId` (V §11)? Eigene Einträge: ja. Fremde: nie.
 * Alt-Einträge ohne userId: nur, wenn der Server die Spur für die aktuelle Sitzung herausgibt (200, nach legacy:claim).
 * Jeder Fehler (404 fremd, 401, Netz) heißt „nicht zeigen“ – gelöscht wird dabei nichts.
 */
async function gehoert(m: TrackMeta, userId: string, api: ApiClient): Promise<boolean> {
  if (m.userId) return m.userId === userId;
  try { await api.getTrack(m.trackId, frist(STATUS_FRIST_MS)); return true; } catch { return false; }
}

/**
 * Gehört das Browser-Cookie gerade wirklich `userId`? Das Cookie gilt für alle Tabs – ein Login/Einladungslink in einem
 * anderen Tab kann es auf ein fremdes Konto umstellen. Dann wird nichts gezeigt, gesendet oder gelöscht.
 */
async function sitzungIst(userId: string, api: ApiClient): Promise<boolean> {
  try { return !!userId && (await mitFrist(api.session(frist(STATUS_FRIST_MS)), STATUS_FRIST_MS)).user?.id === userId; } catch { return false; }
}

async function eigeneMeta(trackId: string, userId: string, api: ApiClient, store: ChunkStore): Promise<TrackMeta> {
  const m = await mitFrist(store.getMeta(trackId));
  if (!m || !(await sitzungIst(userId, api)) || !(await gehoert(m, userId, api))) throw new ApiError(404, "lokal_nicht_gefunden", "Zu dieser Aufnahme liegen lokal keine Daten mehr vor.");
  return m;
}

/** Lokal liegende, nicht abgeschlossene Aufnahmen DIESES Kontos, die gerade in keinem Tab laufen. */
export async function listPending(userId: string, api: ApiClient, store: ChunkStore = getDefaultStore()): Promise<PendingRecording[]> {
  if (!(await sitzungIst(userId, api))) return []; // anderes/kein Konto im Browser → nichts zeigen
  const metas = await store.listMetas();
  const active = await activeTrackIds();
  const now = Date.now();
  const out: PendingRecording[] = [];
  for (const m of metas) {
    if (active ? active.has(m.trackId) : now - m.lastChunkAtMs < HEARTBEAT_STALE_MS) continue;
    if (!(await gehoert(m, userId, api))) continue; // fremd: weder zeigen noch anfassen
    const mk = leseMarker(m.trackId);
    out.push({
      trackId: m.trackId, projectId: m.projectId, title: m.title, startedAtMs: m.startedAtMs,
      localChunks: (await store.chunkIndexes(m.trackId)).length, chunkCount: Math.max(m.chunkCount, mk.chunkCount),
      nichtLokal: vereint(m.nichtLokal, mk.nichtLokal).length,
    });
  }
  return out.sort((a, b) => b.startedAtMs - a.startedAtMs);
}

/**
 * Für den Abmelden-Dialog (Plan PA7, R3): Anzahl lokal liegender, noch nicht abgeschlossener Aufnahmen dieses Kontos
 * (auch gerade laufende). Abmelden löscht davon nichts; nach erneuter Anmeldung desselben Kontos sind sie bergbar.
 */
export async function ungesicherteAufnahmen(userId: string, store: ChunkStore = getDefaultStore()): Promise<number> {
  return (await mitFrist(store.listMetas())).filter((m) => m.userId === userId).length;
}

/** Lokale Abschnitte und Meta löschen – nur für eigene Einträge. Der Server-Stand bleibt unverändert (v1 kennt kein Löschen). */
export async function discardPending(trackId: string, userId: string, api: ApiClient, store: ChunkStore = getDefaultStore()): Promise<void> {
  await eigeneMeta(trackId, userId, api, store);
  await vergiss(store, trackId);
}

/**
 * Fehlende Abschnitte ab `receivedChunks` nachladen und abschließen.
 * Wirft ApiError (z. B. `chunks_missing` mit details.missing) – lokale Daten bleiben dann erhalten.
 * allowPartial nur auf ausdrücklichen Wunsch: schließt den lückenlosen Anfang ab.
 */
export async function resumePending(
  trackId: string, userId: string, api: ApiClient, onProgress: (done: number, total: number) => void,
  opts: { allowPartial?: boolean; store?: ChunkStore; maxRetries?: number } = {},
): Promise<Track> {
  const run = async () => {
    await eigeneMeta(trackId, userId, api, opts.store ?? getDefaultStore()); // fremd → 404, nichts wird gesendet
    return syncAndFinalize(trackId, api, onProgress, opts);
  };
  const l = locks();
  if (!l) return run();
  return l.request(lockName(trackId), { ifAvailable: true }, async (lock): Promise<Track> => {
    if (!lock) throw new ApiError(409, "aufnahme_aktiv", "Diese Aufnahme läuft oder wird gerade in einem anderen Tab gesichert.");
    return run();
  });
}

/** Kern ohne Sperre – auch vom Studio für „Erneut versuchen“ genutzt (es hält die Sperre selbst). */
export async function syncAndFinalize(
  trackId: string, api: ApiClient, onProgress: (done: number, total: number) => void,
  opts: { allowPartial?: boolean; store?: ChunkStore; maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Track> {
  const store = opts.store ?? getDefaultStore();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 5;
  const meta = await mitFrist(store.getMeta(trackId));
  if (!meta) throw new ApiError(404, "lokal_nicht_gefunden", "Zu dieser Aufnahme liegen lokal keine Daten mehr vor.");

  const retrying = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (!istWiederholbar(e) || brauchtAnmeldung(e) || i >= maxRetries) throw e; // ohne Sitzung sofort melden, lokale Daten bleiben
        await sleep(backoffMs(i));
      }
    }
  };

  // Jede Anfrage mit echter Frist (F2): hängende Verbindungen werden abgebrochen und wiederholt.
  let track = await retrying(() => api.getTrack(trackId, frist(STATUS_FRIST_MS)));
  if (track.status === "processing" || track.status === "ready") {
    await vergiss(store, trackId).catch(() => {}); // Server hat bereits alles (auch nach verlorener Quittung)
    return track;
  }

  // Nicht lokal gesicherte Abschnitte zählen mit → Server meldet chunks_missing statt still kürzer abzuschließen.
  const total = Math.max(meta.chunkCount, leseMarker(trackId).chunkCount, track.receivedChunks);
  if (total === 0) throw new ApiError(422, "keine_daten", "Die Aufnahme enthält keine Daten – es gibt nichts wiederherzustellen.");

  if (track.status === "uploading") {
    const local = await mitFrist(store.chunkIndexes(trackId));
    // Bereits bestätigte Abschnitte lokal aufräumen
    for (const i of local.filter((i) => i < track.receivedChunks)) await mitFrist(store.deleteChunk(trackId, i));
    const todo = local.filter((i) => i >= track.receivedChunks);
    onProgress(0, todo.length);
    for (let n = 0; n < todo.length; n++) {
      const blob = await mitFrist(store.getChunk(trackId, todo[n]));
      if (!blob) continue;
      await retrying(() => api.putChunk(trackId, todo[n], blob, frist(SENDE_FRIST_MS)));
      await mitFrist(store.deleteChunk(trackId, todo[n]));
      onProgress(n + 1, todo.length);
    }
  }

  const durationMs = meta.durationMs ?? Math.max(0, meta.lastChunkAtMs - meta.startedAtMs);
  // Idempotent: nach verlorener Quittung antwortet der Server beim Wiederholen mit dem bereits angenommenen Stand.
  track = await retrying(() => api.finalizeTrack(trackId, { chunkCount: total, durationMs, allowPartial: opts.allowPartial || undefined }, frist(SENDE_FRIST_MS)));
  await vergiss(store, trackId).catch(() => {}); // Server hat angenommen; ein Rest wird bei der nächsten Prüfung aufgeräumt
  return track;
}
