// Lokaler Abschnittsspeicher (IndexedDB). Erst lokal sichern, dann senden; lokal erst nach Server-Bestätigung löschen.

export interface TrackMeta {
  trackId: string;
  /** PA7 (V §11): Konto, das die Aufnahme begonnen hat. Fehlt nur bei Alt-Einträgen von vor den Konten. */
  userId?: string;
  projectId: string;
  title: string;
  mimeType: string;
  startedAtMs: number;
  /** Anzahl erzeugter Abschnitte (= nächster Index). Wird atomar mit jedem Abschnitt geschrieben. */
  chunkCount: number;
  /** Zeitpunkt (Date.now) des letzten lokal gesicherten Abschnitts – Grundlage der Dauerschätzung. */
  lastChunkAtMs: number;
  /** Gemessene Dauer nach Stopp; null = Aufnahme wurde nicht regulär beendet. */
  durationMs: number | null;
  /** F1: Indizes, die nicht lokal gesichert werden konnten (nur im Arbeitsspeicher des Tabs). */
  nichtLokal?: number[];
}

export interface ChunkStore {
  saveMeta(meta: TrackMeta): Promise<void>;
  getMeta(trackId: string): Promise<TrackMeta | undefined>;
  listMetas(): Promise<TrackMeta[]>;
  /** Abschnitt + Meta-Fortschritt in EINER Transaktion. */
  addChunk(trackId: string, index: number, blob: Blob, atMs: number): Promise<void>;
  getChunk(trackId: string, index: number): Promise<Blob | undefined>;
  chunkIndexes(trackId: string): Promise<number[]>;
  deleteChunk(trackId: string, index: number): Promise<void>;
  /** Meta und alle Abschnitte entfernen. */
  deleteTrack(trackId: string): Promise<void>;
}

const DB_NAME = "podcast-studio-aufnahme";
const META = "meta";
const CHUNKS = "chunks";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new DOMException("Transaktion abgebrochen", "AbortError"));
  });
}
const range = (trackId: string) => IDBKeyRange.bound([trackId, 0], [trackId, Number.MAX_SAFE_INTEGER]);

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((res, rej) => {
      if (typeof indexedDB === "undefined") return rej(new Error("IndexedDB nicht verfügbar"));
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(META, { keyPath: "trackId" });
        r.result.createObjectStore(CHUNKS); // Schlüssel [trackId, index]
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("IndexedDB blockiert (anderer Tab mit alter Version offen)"));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

export function idbStore(): ChunkStore {
  return {
    async saveMeta(meta) {
      const tx = (await openDb()).transaction(META, "readwrite");
      tx.objectStore(META).put(meta);
      await done(tx);
    },
    async getMeta(trackId) {
      return req((await openDb()).transaction(META).objectStore(META).get(trackId));
    },
    async listMetas() {
      return req((await openDb()).transaction(META).objectStore(META).getAll());
    },
    async addChunk(trackId, index, blob, atMs) {
      const tx = (await openDb()).transaction([META, CHUNKS], "readwrite");
      const metas = tx.objectStore(META);
      tx.objectStore(CHUNKS).put(blob, [trackId, index]);
      const g = metas.get(trackId);
      g.onsuccess = () => {
        const m = g.result as TrackMeta | undefined;
        if (!m) { tx.abort(); return; }
        metas.put({ ...m, chunkCount: Math.max(m.chunkCount, index + 1), lastChunkAtMs: atMs });
      };
      await done(tx);
    },
    async getChunk(trackId, index) {
      return req((await openDb()).transaction(CHUNKS).objectStore(CHUNKS).get([trackId, index]));
    },
    async chunkIndexes(trackId) {
      const keys = await req((await openDb()).transaction(CHUNKS).objectStore(CHUNKS).getAllKeys(range(trackId)));
      return (keys as [string, number][]).map((k) => k[1]).sort((a, b) => a - b);
    },
    async deleteChunk(trackId, index) {
      const tx = (await openDb()).transaction(CHUNKS, "readwrite");
      tx.objectStore(CHUNKS).delete([trackId, index]);
      await done(tx);
    },
    async deleteTrack(trackId) {
      const tx = (await openDb()).transaction([META, CHUNKS], "readwrite");
      tx.objectStore(CHUNKS).delete(range(trackId));
      tx.objectStore(META).delete(trackId);
      await done(tx);
    },
  };
}

/** Speicher im Arbeitsspeicher – nur für Tests (gleiches Verhalten wie idbStore). */
export function memoryStore(): ChunkStore & { chunks: Map<string, Blob>; metas: Map<string, TrackMeta> } {
  const metas = new Map<string, TrackMeta>();
  const chunks = new Map<string, Blob>();
  const key = (t: string, i: number) => `${t}\u0000${i}`;
  return {
    metas, chunks,
    async saveMeta(m) { metas.set(m.trackId, { ...m }); },
    async getMeta(t) { const m = metas.get(t); return m && { ...m }; },
    async listMetas() { return [...metas.values()].map((m) => ({ ...m })); },
    async addChunk(t, i, b, at) {
      const m = metas.get(t);
      if (!m) throw new Error("Meta fehlt");
      chunks.set(key(t, i), b);
      metas.set(t, { ...m, chunkCount: Math.max(m.chunkCount, i + 1), lastChunkAtMs: at });
    },
    async getChunk(t, i) { return chunks.get(key(t, i)); },
    async chunkIndexes(t) {
      return [...chunks.keys()].filter((k) => k.startsWith(t + "\u0000")).map((k) => Number(k.split("\u0000")[1])).sort((a, b) => a - b);
    },
    async deleteChunk(t, i) { chunks.delete(key(t, i)); },
    async deleteTrack(t) {
      metas.delete(t);
      for (const k of [...chunks.keys()]) if (k.startsWith(t + "\u0000")) chunks.delete(k);
    },
  };
}
