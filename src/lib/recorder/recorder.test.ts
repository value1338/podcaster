// Unit-Tests AP3: Formatwahl, Fehlerzuordnung, Warteschlange, Wiederherstellung, Engine-Ablauf (mit Schein-Browser-APIs).
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, type FinalizeInput, type Track } from "../api";
import {
  backoffMs, brauchtAnmeldung, IDB_FRIST_MS, istWebkitSafari, istWiederholbar, mapCameraError, mapMediaError, pickMimeType, RAM_PUFFER_MAX_BYTES, SENDE_FRIST_MS,
  STATUS_FRIST_MS, VIDEO_MIME_CANDIDATES, videoBitrate,
} from "./format";
import { discardPending, listPending, resumePending, ungesicherteAufnahmen, vermerkeErzeugt, vermerkeNichtLokal } from "./pending";
import { UploadQueue } from "./queue";
import { memoryStore, type ChunkStore, type TrackMeta } from "./store";

type ChunkStoreAdd = ChunkStore["addChunk"];
import { createStudio } from "./studio";
import type { StudioSnapshot } from "./types";

const flush = () => new Promise((r) => setTimeout(r, 0));
const netErr = () => new ApiError(0, "network", "Server nicht erreichbar.");

it("vermerkt erzeugte und ungesicherte Abschnitte synchron vor hängenden Metadaten", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  });
  const store = memoryStore();
  let release!: (m: TrackMeta | undefined) => void;
  store.getMeta = () => new Promise((resolve) => { release = resolve; });
  vermerkeErzeugt("t-marker", 2);
  const pending = vermerkeNichtLokal(store, "t-marker", 1);
  expect(JSON.parse(values.get("podcast-studio:nicht-lokal:t-marker")!)).toEqual({ chunkCount: 3, nichtLokal: [1] });
  release(undefined);
  expect(await pending).toBe(true);
});

function track(p: Partial<Track> = {}): Track {
  return {
    id: "t1", recordingId: "r1", participantName: "Ich", kind: "audio", source: "studio", mimeType: "audio/webm;codecs=opus",
    status: "uploading", error: null, receivedChunks: 0, bytes: 0, durationMs: null, width: null, height: null, sha256: null,
    startedAtMs: 0, lastChunkAt: null, hasRaw: false, exports: [], ...p,
  };
}

describe("Formatwahl", () => {
  it("nimmt den ersten unterstützten Typ in Vertragsreihenfolge", () => {
    expect(pickMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((t) => t.startsWith("audio/mp4"))).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBeNull();
    expect(pickMimeType(() => { throw new Error("x"); })).toBeNull();
  });
  it("erkennt Safari/iOS, nicht aber Chrome/Firefox/Edge", () => {
    const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36";
    const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0";
    const iosChrome = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/159.0 Mobile/15E148 Safari/604.1";
    const edge = chrome + " Edg/159.0.0.0";
    expect(istWebkitSafari(safari)).toBe(true);
    expect(istWebkitSafari(safari, 5)).toBe(true); // iPad im Desktop-Modus
    expect(istWebkitSafari(iosChrome)).toBe(true);
    expect(istWebkitSafari(chrome)).toBe(false);
    expect(istWebkitSafari(firefox)).toBe(false);
    expect(istWebkitSafari(edge)).toBe(false);
  });
});

describe("Fehlerzuordnung", () => {
  const ph = (name: string) => mapMediaError(Object.assign(new Error("x"), { name })).phase;
  it("ordnet getUserMedia-Fehler den Studio-Zuständen zu", () => {
    expect(ph("NotAllowedError")).toBe("verweigert");
    expect(ph("SecurityError")).toBe("verweigert");
    expect(ph("NotFoundError")).toBe("kein-geraet");
    expect(ph("OverconstrainedError")).toBe("kein-geraet");
    expect(ph("NotReadableError")).toBe("geraet-belegt");
    expect(mapMediaError(new Error("x")).message).toContain("Error");
  });
  it("unterscheidet wiederholbare von endgültigen Upload-Fehlern", () => {
    expect(istWiederholbar(netErr())).toBe(true);
    expect(istWiederholbar(new ApiError(503, "x", "x"))).toBe(true);
    expect(istWiederholbar(new ApiError(429, "x", "x"))).toBe(true);
    expect(istWiederholbar(new ApiError(409, "not_uploading", "x"))).toBe(false);
    expect(istWiederholbar(new ApiError(409, "upload_busy", "x"))).toBe(true);
    expect(istWiederholbar(new ApiError(404, "not_found", "x"))).toBe(false);
    expect(istWiederholbar(new TypeError("fetch"))).toBe(true);
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("Upload-Warteschlange", () => {
  it("wiederholt nach Netzfehlern und hält die Reihenfolge", async () => {
    const sent: number[] = [];
    let fails = 2;
    const sleeps: number[] = [];
    const q = new UploadQueue({
      upload: async (i) => { if (i === 1 && fails-- > 0) throw netErr(); sent.push(i); },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    q.push(0, new Blob(["a"]));
    q.push(2, new Blob(["c"]));
    q.push(1, new Blob(["b"]));
    await q.drained();
    expect(sent).toEqual([0, 1, 2]);
    expect(sleeps).toEqual([1000, 2000]);
    expect(q.state).toMatchObject({ uploaded: 3, pending: 0, offline: false, fatal: null });
  });

  it("meldet offline während Fehlern und löscht lokal erst nach Bestätigung", async () => {
    const deleted: number[] = [];
    const states: boolean[] = [];
    let online = false;
    const q = new UploadQueue({
      upload: async () => { if (!online) throw netErr(); },
      onUploaded: (i) => { deleted.push(i); },
      onChange: (s) => states.push(s.offline),
      sleep: async () => { expect(deleted).toEqual([]); online = true; },
    });
    q.push(0, new Blob(["a"]));
    await q.drained();
    expect(states).toContain(true);
    expect(q.state.offline).toBe(false);
    expect(deleted).toEqual([0]);
  });

  it("stoppt bei endgültigem Fehler, behält Abschnitte und setzt mit resume() fort", async () => {
    let reject = true;
    const sent: number[] = [];
    const q = new UploadQueue({
      upload: async (i) => { if (reject) throw new ApiError(409, "not_uploading", "x"); sent.push(i); },
      sleep: async () => {},
    });
    q.push(0, new Blob(["a"]));
    await expect(q.drained()).rejects.toMatchObject({ code: "not_uploading" });
    expect(q.state.pending).toBe(1);
    reject = false;
    q.resume();
    await q.drained();
    expect(sent).toEqual([0]);
  });

  it("bricht hängende Uploads per Zeitlimit ab und versucht erneut", async () => {
    let calls = 0;
    const q = new UploadQueue({
      timeoutMs: 10,
      upload: (_i, _b, signal) => new Promise<void>((res, rej) => {
        if (++calls > 1) return res();
        signal.addEventListener("abort", () => rej(new ApiError(0, "aborted", "x")));
      }),
      sleep: async () => {},
    });
    q.push(0, new Blob(["a"]));
    await q.drained();
    expect(calls).toBe(2);
  });
});

function fakeApi(over: Partial<Record<keyof ApiClient, unknown>> = {}) {
  const calls: string[] = [];
  const server = { received: new Set<number>(), status: "uploading" as Track["status"] };
  const contiguous = () => { let n = 0; while (server.received.has(n)) n++; return n; };
  const api = {
    health: vi.fn(async () => ({ ok: true, version: "t", freeBytes: 500e9, ffmpeg: true })),
    session: vi.fn(async () => ({ user: { id: "u1" }, setupRequired: false })),
    createRecording: vi.fn(async () => ({ recording: { id: "r1" }, track: track() })),
    putChunk: vi.fn(async (_id: string, i: number) => { calls.push(`put${i}`); server.received.add(i); return { receivedChunks: contiguous() }; }),
    getTrack: vi.fn(async () => track({ receivedChunks: contiguous(), status: server.status })),
    finalizeTrack: vi.fn(async (_id: string, b: { chunkCount: number; allowPartial?: boolean }) => {
      calls.push(`finalize${b.chunkCount}`);
      const missing = [...Array(b.chunkCount).keys()].filter((i) => !server.received.has(i));
      if (missing.length && !b.allowPartial) throw new ApiError(409, "chunks_missing", "Es fehlen Abschnitte.", { missing });
      server.status = "processing";
      return track({ status: "processing", receivedChunks: contiguous() });
    }),
    ...over,
  };
  return { api: api as unknown as ApiClient, calls, server };
}

const meta = (p: Partial<TrackMeta> = {}): TrackMeta => ({
  trackId: "t1", userId: "u1", projectId: "p1", title: "Folge", mimeType: "audio/webm;codecs=opus", startedAtMs: 1000,
  chunkCount: 0, lastChunkAtMs: 1000, durationMs: null, ...p,
});

describe("Wiederherstellung", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lädt ab receivedChunks nach, räumt Bestätigtes auf und schließt ab", async () => {
    const store = memoryStore();
    await store.saveMeta(meta());
    for (let i = 0; i < 5; i++) await store.addChunk("t1", i, new Blob([`c${i}`]), 1000 + (i + 1) * 4000);
    const { api, calls, server } = fakeApi();
    server.received = new Set([0, 1, 2]);
    const progress: [number, number][] = [];
    const t = await resumePending("t1", "u1", api, (d, n) => progress.push([d, n]), { store });
    expect(calls).toEqual(["put3", "put4", "finalize5"]);
    expect(progress).toEqual([[0, 2], [1, 2], [2, 2]]);
    expect(t.status).toBe("processing");
    expect((api.finalizeTrack as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ chunkCount: 5, durationMs: 20000 });
    expect(store.metas.size + store.chunks.size).toBe(0);
  });

  it("listet nur verwaiste Aufnahmen (ohne Web Locks: Heartbeat) und verwirft auf Wunsch", async () => {
    vi.stubGlobal("navigator", {});
    const store = memoryStore();
    await store.saveMeta(meta({ trackId: "alt", lastChunkAtMs: Date.now() - 60_000, startedAtMs: 1 }));
    await store.saveMeta(meta({ trackId: "laeuft", lastChunkAtMs: Date.now() }));
    await store.addChunk("alt", 0, new Blob(["x"]), Date.now() - 60_000);
    const { api } = fakeApi();
    const list = await listPending("u1", api, store);
    expect(list.map((p) => p.trackId)).toEqual(["alt"]);
    expect(list[0]).toMatchObject({ localChunks: 1, chunkCount: 1 });
    await discardPending("alt", "u1", api, store);
    expect(await store.getMeta("alt")).toBeUndefined();
  });

  it("schließt nicht stillschweigend lückenhaft ab: chunks_missing bleibt Fehler, lokale Daten bleiben", async () => {
    const store = memoryStore();
    await store.saveMeta(meta());
    await store.addChunk("t1", 0, new Blob(["a"]), 5000);
    await store.addChunk("t1", 2, new Blob(["c"]), 13000); // Index 1 fehlt überall
    const { api } = fakeApi();
    await expect(resumePending("t1", "u1", api, () => {}, { store })).rejects.toMatchObject({ code: "chunks_missing" });
    expect(await store.getMeta("t1")).toBeDefined();
    const t = await resumePending("t1", "u1", api, () => {}, { store, allowPartial: true });
    expect(t.status).toBe("processing");
  });

  it("räumt nur auf, wenn der Server schon verarbeitet", async () => {
    const store = memoryStore();
    await store.saveMeta(meta({ chunkCount: 2 }));
    const { api, calls, server } = fakeApi();
    server.status = "ready";
    const t = await resumePending("t1", "u1", api, () => {}, { store });
    expect(t.status).toBe("ready");
    expect(calls).toEqual([]);
    expect(store.metas.size).toBe(0);
  });

  it("wirft bei Netzfehler nach begrenzten Versuchen, lokale Daten bleiben", async () => {
    const store = memoryStore();
    await store.saveMeta(meta());
    await store.addChunk("t1", 0, new Blob(["a"]), 5000);
    const { api } = fakeApi({ getTrack: vi.fn(async () => { throw netErr(); }) });
    const { syncAndFinalize } = await import("./pending");
    await expect(syncAndFinalize("t1", api, () => {}, { store, maxRetries: 2, sleep: async () => {} })).rejects.toMatchObject({ code: "network" });
    expect(store.chunks.size).toBe(1);
  });
});

// ---------- Engine mit Schein-Browser ----------
class FakeTrack extends EventTarget {
  onended: (() => void) | null = null;
  stopped = false;
  getSettings() { return { deviceId: "mic1" }; }
  stop() { this.stopped = true; }
}
class FakeStream {
  t = new FakeTrack();
  getTracks() { return [this.t]; }
  getAudioTracks() { return [this.t]; }
}
class FakeRecorder {
  static last: FakeRecorder;
  static isTypeSupported = (t: string) => t.startsWith("audio/webm");
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public stream: unknown, public opts: { mimeType: string }) { FakeRecorder.last = this; }
  start() { this.state = "recording"; }
  emit(s: string) { this.ondataavailable?.({ data: new Blob([s]) }); }
  stop() { this.state = "inactive"; this.emit("letzter"); this.onstop?.(); }
}

const handlers = new Map<string, () => void>();
function browser(gum: () => Promise<unknown>) {
  handlers.clear();
  vi.stubGlobal("window", { isSecureContext: true, addEventListener(n: string, f: () => void) { handlers.set(n, f); }, removeEventListener() {}, dispatchEvent() { return true; } });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36",
    maxTouchPoints: 0,
    mediaDevices: { getUserMedia: gum, enumerateDevices: async () => [{ kind: "audioinput", deviceId: "mic1", label: "Mic" }], addEventListener() {}, removeEventListener() {} },
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", undefined); // Pegel nicht messbar → darf Aufnahme nicht verhindern
}

describe("Engine-Ablauf", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("ordnet verweigerte Berechtigung zu und versucht erneut", async () => {
    let deny = true;
    browser(async () => { if (deny) throw Object.assign(new Error("x"), { name: "NotAllowedError" }); return new FakeStream(); });
    const s = createStudio(fakeApi().api, { userId: "u1", store: memoryStore() });
    await s.init();
    expect(s.getSnapshot().phase).toBe("verweigert");
    deny = false;
    await s.retryPermission();
    expect(s.getSnapshot().phase).toBe("bereit");
    s.dispose();
  });

  it("unsicherer Kontext → unsicher; Safari → nicht-unterstuetzt", async () => {
    browser(async () => new FakeStream());
    vi.stubGlobal("window", { isSecureContext: false });
    const a = createStudio(fakeApi().api, { userId: "u1", store: memoryStore() });
    await a.init();
    expect(a.getSnapshot().phase).toBe("unsicher");
    browser(async () => new FakeStream());
    (navigator as { userAgent: string }).userAgent = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
    const b = createStudio(fakeApi().api, { userId: "u1", store: memoryStore() });
    await b.init();
    expect(b.getSnapshot().phase).toBe("nicht-unterstuetzt");
  });

  it("sichert jeden Abschnitt lokal VOR dem Upload, übersteht Netzausfall und schließt ab", async () => {
    browser(async () => new FakeStream());
    const store = memoryStore();
    const order: string[] = [];
    const add = store.addChunk.bind(store);
    store.addChunk = async (t, i, b, at) => { order.push(`lokal${i}`); return add(t, i, b, at); };
    let offline = true;
    const { api, calls, server } = fakeApi();
    const put = api.putChunk.bind(api);
    (api as { putChunk: unknown }).putChunk = async (id: string, i: number, b: Blob) => {
      if (offline) throw netErr();
      order.push(`put${i}`);
      return put(id, i, b);
    };
    (api as { getTrack: unknown }).getTrack = async () => track({ status: "ready", durationMs: 12000, receivedChunks: 3 });
    const s = createStudio(api, { userId: "u1", store });
    const seen: StudioSnapshot[] = [];
    s.subscribe((x) => seen.push(x));
    await s.init();
    expect(s.getSnapshot().phase).toBe("bereit");
    await s.start({ projectId: "p1", title: "Folge", participantName: "Ich" });
    expect(s.getSnapshot().phase).toBe("aufnahme");
    FakeRecorder.last.emit("a");
    FakeRecorder.last.emit("b");
    await flush(); await flush();
    expect(s.getSnapshot().warnings.offline).toBe(true);
    expect(s.getSnapshot().phase).toBe("aufnahme"); // Netzausfall bricht die Aufnahme nicht ab
    expect(store.chunks.size).toBe(2);
    offline = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    handlers.get("online")?.(); // Netz zurück → Warteschlange sofort wecken
    const stopping = s.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;
    expect(order.slice(0, 2)).toEqual(["lokal0", "lokal1"]);
    expect(order.indexOf("lokal2")).toBeLessThan(order.indexOf("put2"));
    expect(calls.at(-1)).toBe("finalize3");
    expect([...server.received]).toEqual([0, 1, 2]);
    expect(s.getSnapshot().phase).toBe("fertig");
    expect(store.metas.size + store.chunks.size).toBe(0);
    expect(seen.some((x) => x.phase === "abschluss")).toBe(true);
    expect((FakeRecorder.last.stream as FakeStream).t.stopped).toBe(true);
  });

  it("Mikrofon abgezogen während der Aufnahme → sauber beendet, Stand gesichert, Warnung", async () => {
    browser(async () => new FakeStream());
    const { api } = fakeApi({ getTrack: vi.fn(async () => track({ status: "ready" })) });
    const s = createStudio(api, { userId: "u1", store: memoryStore() });
    await s.init();
    await s.start({ projectId: "p1", title: "Folge", participantName: "Ich" });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    FakeRecorder.last.emit("a");
    (FakeRecorder.last.stream as FakeStream).t.onended?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.getSnapshot().warnings.geraetVerloren).toBe(true);
    expect(s.getSnapshot().phase).toBe("fertig");
  });

  it("Server-Speicher knapp → Start gesperrt", async () => {
    browser(async () => new FakeStream());
    const { api } = fakeApi({ health: vi.fn(async () => ({ ok: true, version: "t", freeBytes: 1e9, ffmpeg: true })) });
    const s = createStudio(api, { userId: "u1", store: memoryStore() });
    await s.init();
    await s.start({ projectId: "p1", title: "Folge", participantName: "Ich" });
    expect(s.getSnapshot()).toMatchObject({ phase: "bereit", error: { code: "speicher_knapp" } });
    expect(s.getSnapshot().warnings.serverSpeicherKnapp).toBe(true);
  });

  it("Server weist Abschnitte ab → fehler-abschluss, lokale Abschnitte bleiben", async () => {
    browser(async () => new FakeStream());
    const store = memoryStore();
    const { api } = fakeApi({ putChunk: vi.fn(async () => { throw new ApiError(409, "not_uploading", "Spur nimmt keine Abschnitte mehr an."); }) });
    const s = createStudio(api, { userId: "u1", store });
    await s.init();
    await s.start({ projectId: "p1", title: "Folge", participantName: "Ich" });
    FakeRecorder.last.emit("a");
    await s.stop();
    expect(s.getSnapshot()).toMatchObject({ phase: "fehler-abschluss", error: { code: "not_uploading" } });
    expect(store.chunks.size).toBe(2);
    expect(store.metas.get("t1")?.durationMs).not.toBeNull();
  });
});

// ---------- F1/F2-Regressionen (Fixes nach AP7) ----------
describe("F1: lokale Sicherung versagt", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function aufnahmeMit(addChunk: (orig: ChunkStoreAdd) => ChunkStoreAdd) {
    browser(async () => new FakeStream());
    const store = memoryStore();
    store.addChunk = addChunk(store.addChunk.bind(store));
    let offline = true;
    const { api, calls, server } = fakeApi();
    const put = api.putChunk.bind(api);
    (api as { putChunk: unknown }).putChunk = async (id: string, i: number, b: Blob) => { if (offline) throw netErr(); return put(id, i, b); };
    (api as { getTrack: unknown }).getTrack = async () => track({ status: "ready", receivedChunks: server.received.size });
    const s = createStudio(api, { userId: "u1", store });
    await s.init();
    await s.start({ projectId: "p1", title: "Folge", participantName: "Ich" });
    return { s, store, calls, server, online: () => { offline = false; handlers.get("online")?.(); } };
  }

  it("Quota + offline → sofortiger Stopp, keine Sicherungszusage, RAM-Zahl, Vermerk, danach Upload-Rettung", async () => {
    const { s, store, calls, server, online } = await aufnahmeMit(() => async () => { throw new DOMException("voll", "QuotaExceededError"); });
    FakeRecorder.last.emit("a");
    for (let i = 0; i < 5; i++) await flush();
    const x = s.getSnapshot();
    expect(x.phase).toBe("abschluss"); // beim ERSTEN Fehler beendet
    expect(FakeRecorder.last.state).toBe("inactive");
    expect(x.chunks).toMatchObject({ total: 2, uploaded: 0, lokal: 0, nurRam: 2 });
    expect(x.warnings.lokalNichtGesichert).toBe(true);
    expect(x.error?.code).toBe("lokal_nicht_gesichert");
    // Vermerk: spätere Bergung zählt beide Abschnitte mit
    expect(store.metas.get("t1")).toMatchObject({ chunkCount: 2, nichtLokal: [0, 1] });
    // Notfalldatei aus dem Arbeitsspeicher, beginnt bei 0 → vollständig
    const d = s.notfallDatei()!;
    expect(d).toMatchObject({ von: 0, bis: 1, vollstaendig: true });
    expect(await d.blob.text()).toBe("aletzter");
    // Netz zurück → Rettung per Upload, RAM-Zahl baut sich nach Bestätigung ab
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    online();
    await vi.advanceTimersByTimeAsync(40_000);
    expect([...server.received]).toEqual([0, 1]);
    expect(calls).toContain("finalize2");
    expect(s.getSnapshot()).toMatchObject({ phase: "fertig", chunks: { nurRam: 0, uploaded: 2 } });
    expect(s.notfallDatei()).toBeNull();
    expect(store.metas.size).toBe(0);
  });

  it("hängende IndexedDB → Frist, kontrollierter Stopp ohne Verklemmung", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const { s } = await aufnahmeMit(() => () => new Promise<void>(() => {}));
    FakeRecorder.last.emit("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.getSnapshot().phase).toBe("aufnahme"); // noch innerhalb der Frist
    await vi.advanceTimersByTimeAsync(IDB_FRIST_MS + 1000);
    expect(s.getSnapshot().phase).toBe("abschluss");
    expect(FakeRecorder.last.state).toBe("inactive");
    await vi.advanceTimersByTimeAsync(3 * IDB_FRIST_MS);
    expect(s.getSnapshot().chunks.nurRam).toBe(2); // persistChain endet trotz Hänger (Stopp hängt nicht)
  });

  it("Bergung nach Vermerk schließt nicht still unvollständig ab", async () => {
    const store = memoryStore();
    await store.saveMeta(meta({ chunkCount: 3, nichtLokal: [1, 2] }));
    await store.addChunk("t1", 0, new Blob(["a"]), 5000);
    const { api } = fakeApi();
    await expect(resumePending("t1", "u1", api, () => {}, { store })).rejects.toMatchObject({ code: "chunks_missing", details: { missing: [1, 2] } });
    expect(await store.getMeta("t1")).toBeDefined();
    const list = await listPending("u1", api, store);
    expect(list[0]).toMatchObject({ nichtLokal: 2, chunkCount: 3 });
  });
});

describe("F2: Fristen für Erholungs-/Abschlussanfragen", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  /** Anfrage, die erst mit dem AbortSignal endet – wie ein echter hängender fetch. */
  const haengt = (signal?: AbortSignal) => new Promise<never>((_, rej) => {
    if (!signal) return; // ohne Signal hinge sie ewig
    signal.addEventListener("abort", () => rej(new ApiError(0, "timeout", "Frist")), { once: true });
  });

  it("hängende Statusabfrage und verlorene Abschluss-Quittung → abgebrochen, wiederholt, idempotent, Daten bis Annahme erhalten", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const store = memoryStore();
    await store.saveMeta(meta());
    await store.addChunk("t1", 0, new Blob(["a"]), 5000);
    const signale: AbortSignal[] = [];
    let getN = 0, finN = 0;
    const { api, server } = fakeApi();
    const fin = api.finalizeTrack.bind(api);
    (api as { getTrack: unknown }).getTrack = vi.fn((_id: string, sig?: AbortSignal) => {
      if (sig) signale.push(sig);
      if (getN++ === 0) return haengt(sig);
      return Promise.resolve(track({ receivedChunks: server.received.size, status: server.status }));
    });
    (api as { finalizeTrack: unknown }).finalizeTrack = vi.fn(async (id: string, b: FinalizeInput, sig?: AbortSignal) => {
      if (sig) signale.push(sig);
      if (finN++ === 0) { await fin(id, b); return haengt(sig); } // Server nimmt an, Antwort geht verloren
      if (server.status === "processing") return track({ status: "processing", receivedChunks: 1 }); // wie server/tracks.mjs: 200
      return fin(id, b);
    });
    const p = resumePending("t1", "u1", api, () => {}, { store });
    await vi.advanceTimersByTimeAsync(STATUS_FRIST_MS + 100);
    expect(signale[0].aborted).toBe(true); // echter Abbruch, nicht nur Promise.race
    expect(store.chunks.size).toBe(1); // Timeout löscht nichts
    await vi.advanceTimersByTimeAsync(SENDE_FRIST_MS + 5000);
    const t = await p;
    expect(t.status).toBe("processing");
    expect(finN).toBe(2);
    expect(signale.every((x) => x instanceof AbortSignal)).toBe(true);
    expect(store.metas.size + store.chunks.size).toBe(0); // erst nach bestätigter Annahme gelöscht
  });

  it("Studio-Abschluss: hängendes finalize wird per Frist abgebrochen und wiederholt", async () => {
    browser(async () => new FakeStream());
    const store = memoryStore();
    const { api } = fakeApi({ getTrack: vi.fn(async () => track({ status: "ready" })) });
    const fin = api.finalizeTrack.bind(api);
    let n = 0;
    const sigs: AbortSignal[] = [];
    (api as { finalizeTrack: unknown }).finalizeTrack = (id: string, b: FinalizeInput, sig?: AbortSignal) => {
      sigs.push(sig!);
      return n++ === 0 ? haengt(sig) : fin(id, b);
    };
    const s = createStudio(api, { userId: "u1", store });
    await s.init();
    await s.start({ projectId: "p1", title: "Folge", participantName: "Ich" });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    FakeRecorder.last.emit("a");
    const stopping = s.stop();
    await vi.advanceTimersByTimeAsync(SENDE_FRIST_MS + 10_000);
    await stopping;
    expect(sigs[0].aborted).toBe(true);
    expect(n).toBe(2);
    expect(s.getSnapshot().phase).toBe("fertig");
  });

  it("API-Client reicht das Signal an fetch durch und meldet Fristablauf als wiederholbaren timeout", async () => {
    let gesehen: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) => {
      gesehen = init.signal ?? undefined;
      return Promise.reject(new DOMException("Frist", "TimeoutError"));
    });
    const c = new ApiClient("/api");
    const sig = new AbortController().signal;
    const e = await c.finalizeTrack("t1", { chunkCount: 1, durationMs: 1 }, sig).catch((x) => x);
    expect(gesehen).toBe(sig);
    expect(e).toMatchObject({ status: 0, code: "timeout" });
    expect(istWiederholbar(e)).toBe(true);
    await c.getTrack("t1").catch(() => {}); // alter Aufruf ohne Signal bleibt gültig
    expect(gesehen).toBeUndefined();
  });
});

// ---------- AP9: Video ----------
class FakeVideoTrack extends FakeTrack {
  label = "Testkamera";
  constructor(public deviceId: string, public w: number, public h: number) { super(); }
  getSettings() { return { deviceId: this.deviceId, width: this.w, height: this.h, frameRate: 30 }; }
}
class FakeVideoStream {
  constructor(public t: FakeVideoTrack) {}
  getTracks() { return [this.t]; }
  getVideoTracks() { return [this.t]; }
}
class FakeMediaStream {
  constructor(public tracks: unknown[]) {}
}

describe("AP9: Video", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("Formatwahl, Bitrate und Kamerafehler", () => {
    expect(pickMimeType(() => true, VIDEO_MIME_CANDIDATES)).toBe("video/webm;codecs=vp9,opus");
    expect(pickMimeType((t) => !t.includes("vp9"), VIDEO_MIME_CANDIDATES)).toBe("video/webm;codecs=vp8,opus");
    expect(pickMimeType((t) => t.startsWith("video/mp4"), VIDEO_MIME_CANDIDATES)).toBe("video/mp4;codecs=avc1.42E01E,mp4a.40.2");
    expect(pickMimeType((t) => t.startsWith("audio"), VIDEO_MIME_CANDIDATES)).toBeNull();
    expect([videoBitrate(1080), videoBitrate(720), videoBitrate(null)]).toEqual([8_000_000, 5_000_000, 5_000_000]);
    const c = (name: string) => mapCameraError(Object.assign(new Error("x"), { name })).code;
    expect([c("NotAllowedError"), c("NotFoundError"), c("NotReadableError"), c("Weird")]).toEqual(["kamera_verweigert", "kamera_kein_geraet", "kamera_belegt", "kamera_fehler"]);
  });

  /** gum: Audio wie bisher; Video über `cam(constraints)`. */
  function videoBrowser(cam: (v: MediaTrackConstraints) => Promise<unknown>) {
    const mic = new FakeStream();
    const calls: MediaStreamConstraints[] = [];
    browser(async (c?: MediaStreamConstraints) => { calls.push(c!); return c?.video ? cam(c.video as MediaTrackConstraints) : mic; });
    (FakeRecorder as { isTypeSupported: (t: string) => boolean }).isTypeSupported = (t) => t.startsWith("audio/webm") || t.startsWith("video/webm");
    (navigator.mediaDevices as { enumerateDevices: unknown }).enumerateDevices = async () => [
      { kind: "audioinput", deviceId: "mic1", label: "Mic" }, { kind: "videoinput", deviceId: "camA", label: "A" }, { kind: "videoinput", deviceId: "camB", label: "B" },
    ];
    vi.stubGlobal("MediaStream", FakeMediaStream);
    return { mic, calls };
  }
  afterEach(() => { (FakeRecorder as { isTypeSupported: (t: string) => boolean }).isTypeSupported = (t) => t.startsWith("audio/webm"); });

  it("Audio-only bleibt Standard: keine Kameraanfrage, kind=audio", async () => {
    const { calls } = videoBrowser(async () => { throw new Error("darf nicht gefragt werden"); });
    const { api } = fakeApi();
    const s = createStudio(api, { userId: "u1", store: memoryStore() });
    await s.init();
    expect(s.getSnapshot()).toMatchObject({ phase: "bereit", mimeType: "audio/webm;codecs=opus", selected: { camera: false }, kamera: { status: "aus", mimeType: "video/webm;codecs=vp9,opus" } });
    await s.start({ projectId: "p1", title: "Folge", participantName: "Ich" });
    expect(calls.every((c) => !c.video)).toBe(true);
    expect((api.createRecording as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ kind: "audio", mimeType: "audio/webm;codecs=opus" });
    expect(FakeRecorder.last.opts).not.toHaveProperty("videoBitsPerSecond");
    s.dispose();
  });

  it("Kamera verweigert → Mikrofon bleibt bereit, sauberer Wechsel zu Nur Ton", async () => {
    videoBrowser(async () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); });
    const { api } = fakeApi();
    const s = createStudio(api, { userId: "u1", store: memoryStore() });
    await s.init();
    await s.setCamera(true);
    expect(s.getSnapshot()).toMatchObject({ phase: "bereit", kamera: { status: "fehler", error: { code: "kamera_verweigert" } } });
    await expect(s.start({ projectId: "p1", title: "F", participantName: "Ich" })).rejects.toThrow(/Kamera/);
    await s.setCamera(false);
    expect(s.getSnapshot()).toMatchObject({ phase: "bereit", mimeType: "audio/webm;codecs=opus", kamera: { status: "aus" } });
    await s.start({ projectId: "p1", title: "F", participantName: "Ich" });
    expect(s.getSnapshot().phase).toBe("aufnahme");
    expect((api.createRecording as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ kind: "audio" });
    s.dispose();
  });

  it("1080p scheitert (belegt/überfordert) → 720p-Rückfall, tatsächliche Werte", async () => {
    const tries: MediaTrackConstraints[] = [];
    videoBrowser(async (v) => {
      tries.push(v);
      if ((v.height as ConstrainULongRange).ideal === 1080) throw Object.assign(new Error("x"), { name: "NotReadableError" });
      return new FakeVideoStream(new FakeVideoTrack("camA", 1280, 720));
    });
    const s = createStudio(fakeApi().api, { userId: "u1", store: memoryStore() });
    await s.init();
    await s.setCamera(true);
    expect(tries.map((t) => (t.height as ConstrainULongRange).ideal)).toEqual([1080, 720]);
    expect(s.getSnapshot().kamera).toMatchObject({ status: "an", width: 1280, height: 720, frameRate: 30 });
    s.dispose();
  });

  it("Video-Aufnahme: Kamerawechsel gibt alte Spur frei, kind=video, gemeinsamer Stream, Sperre während Aufnahme, Freigabe danach", async () => {
    const cams: FakeVideoTrack[] = [];
    const { mic } = videoBrowser(async (v) => {
      const id = ((v.deviceId as ConstrainDOMStringParameters)?.exact as string) ?? "camA";
      const t = new FakeVideoTrack(id, 1920, 1080);
      cams.push(t);
      return new FakeVideoStream(t);
    });
    const { api } = fakeApi({ getTrack: vi.fn(async () => track({ status: "ready", kind: "video", width: 1920, height: 1080 })) });
    const s = createStudio(api, { userId: "u1", store: memoryStore() });
    await s.init();
    await s.setCamera(true);
    expect(s.getSnapshot()).toMatchObject({ mimeType: "video/webm;codecs=vp9,opus", kamera: { status: "an", width: 1920, height: 1080 }, selected: { videoId: "camA" } });
    await s.selectVideo("camB");
    expect(cams[0].stopped).toBe(true); // alte Kamera freigegeben
    expect(s.getSnapshot().selected.videoId).toBe("camB");
    await s.start({ projectId: "p1", title: "F", participantName: "Ich" });
    expect((api.createRecording as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ kind: "video", mimeType: "video/webm;codecs=vp9,opus" });
    expect(FakeRecorder.last.opts).toMatchObject({ videoBitsPerSecond: 8_000_000 });
    expect((FakeRecorder.last.stream as FakeMediaStream).tracks).toEqual([mic.t, cams[1]]);
    const n = cams.length;
    await s.selectVideo("camA");
    await s.setCamera(false);
    expect(cams.length).toBe(n); // keine Stream-Neuerzeugung während der Aufnahme
    expect(s.getSnapshot()).toMatchObject({ selected: { camera: true, videoId: "camB" }, kamera: { status: "an" } });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    FakeRecorder.last.emit("a");
    const st = s.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await st;
    expect(s.getSnapshot().phase).toBe("fertig");
    expect(cams[1].stopped && mic.t.stopped).toBe(true);
    expect(s.getSnapshot().kamera.stream).toBeNull();
  });

  it("Kamera während der Aufnahme getrennt → kontrollierter Stopp, Stand gesichert, Warnung", async () => {
    const cam = new FakeVideoTrack("camA", 1280, 720);
    videoBrowser(async () => new FakeVideoStream(cam));
    const { api, server } = fakeApi({ getTrack: vi.fn(async () => track({ status: "ready", kind: "video" })) });
    const s = createStudio(api, { userId: "u1", store: memoryStore() });
    await s.init();
    await s.setCamera(true);
    await s.start({ projectId: "p1", title: "F", participantName: "Ich" });
    expect(FakeRecorder.last.opts).toMatchObject({ videoBitsPerSecond: 5_000_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    FakeRecorder.last.emit("a");
    cam.onended?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.getSnapshot()).toMatchObject({ phase: "fertig", warnings: { kameraVerloren: true } });
    expect([...server.received]).toEqual([0, 1]);
  });

  it("RAM-Obergrenze: offline wachsender Puffer → kontrollierter Stopp, nichts verworfen, danach vollständig hochgeladen", async () => {
    videoBrowser(async () => new FakeVideoStream(new FakeVideoTrack("camA", 1920, 1080)));
    const store = memoryStore();
    let offline = true;
    const { api, calls, server } = fakeApi();
    const put = api.putChunk.bind(api);
    (api as { putChunk: unknown }).putChunk = async (id: string, i: number, b: Blob) => { if (offline) throw netErr(); return put(id, i, b); };
    (api as { getTrack: unknown }).getTrack = async () => track({ status: "ready", kind: "video", receivedChunks: server.received.size });
    const s = createStudio(api, { userId: "u1", store });
    await s.init();
    await s.setCamera(true);
    await s.start({ projectId: "p1", title: "F", participantName: "Ich" });
    // Echte Blobs mit großer gemeldeter Größe (kein echter RAM-Verbrauch im Test)
    const gross = (txt: string) => Object.defineProperty(new Blob([txt]), "size", { value: Math.ceil(RAM_PUFFER_MAX_BYTES / 2) + 1 });
    FakeRecorder.last.ondataavailable!({ data: gross("a") });
    await flush();
    expect(s.getSnapshot().phase).toBe("aufnahme"); // eine Hälfte: weiter
    expect(s.getSnapshot().chunks.ramBytes).toBeGreaterThan(RAM_PUFFER_MAX_BYTES / 2);
    FakeRecorder.last.ondataavailable!({ data: gross("b") });
    for (let i = 0; i < 5; i++) await flush();
    const x = s.getSnapshot();
    expect(x).toMatchObject({ phase: "abschluss", error: { code: "puffer_voll" }, chunks: { total: 3 } }); // + Schlussabschnitt
    expect(FakeRecorder.last.state).toBe("inactive");
    expect(store.chunks.size).toBe(3); // alles lokal gesichert, nichts verworfen
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    offline = false;
    handlers.get("online")?.();
    await vi.advanceTimersByTimeAsync(40_000);
    expect([...server.received]).toEqual([0, 1, 2]);
    expect(calls).toContain("finalize3");
    expect(s.getSnapshot()).toMatchObject({ phase: "fertig", chunks: { ramBytes: 0, nurRam: 0 } });
    expect(store.chunks.size + store.metas.size).toBe(0);
  });
});

// ---------- PA7: Recorder unter Konten (V §11) ----------
describe("PA7: Konten-Isolation lokaler Aufnahmen", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const alt = Date.now() - 60_000;

  async function dreiKonten() {
    vi.stubGlobal("navigator", {});
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
    const store = memoryStore();
    for (const [trackId, userId] of [["eigen", "u1"], ["fremd", "u2"], ["alt-eigen", undefined], ["alt-fremd", undefined]] as const) {
      await store.saveMeta(meta({ trackId, userId, lastChunkAtMs: alt }));
      await store.addChunk(trackId, 0, new Blob(["x"]), alt);
      vermerkeErzeugt(trackId, 0);
    }
    // Server: alt-eigen gehört nach legacy:claim der Sitzung (200), alles Fremde → 404 wie PA1.
    const { api, calls } = fakeApi({
      getTrack: vi.fn(async (id: string) => {
        if (id === "alt-eigen" || id === "eigen") return track({ id, receivedChunks: 0 });
        throw new ApiError(404, "not_found", "Nicht gefunden.");
      }),
    });
    return { store, api, calls, values };
  }

  it("listPending zeigt eigene + serverseitig bestätigte Alt-Einträge, nie fremde", async () => {
    const { store, api } = await dreiKonten();
    expect((await listPending("u1", api, store)).map((p) => p.trackId).sort()).toEqual(["alt-eigen", "eigen"]);
    // u2 sieht nur sein eigenes; alt-eigen gehört serverseitig nicht ihm (hier: Server antwortet für die Sitzung von u1)
    const { api: api2 } = fakeApi({ getTrack: vi.fn(async () => { throw new ApiError(404, "not_found", "x"); }), session: vi.fn(async () => ({ user: { id: "u2" } })) });
    expect((await listPending("u2", api2, store)).map((p) => p.trackId)).toEqual(["fremd"]);
    // ohne Sitzung (401) keine Alt-Einträge
    const { api: api0 } = fakeApi({ getTrack: vi.fn(async () => { throw new ApiError(401, "unauthenticated", "x"); }), session: vi.fn(async () => ({ user: null })) });
    expect(await listPending("", api0, store)).toEqual([]);
    expect(store.metas.size).toBe(4); // nichts gelöscht
  });

  it("resume/discard fremder oder unbestätigter Alt-Einträge → lokal_nicht_gefunden, Daten + Marker bleiben, nichts gesendet", async () => {
    const { store, api, calls, values } = await dreiKonten();
    for (const id of ["fremd", "alt-fremd"]) {
      await expect(resumePending(id, "u1", api, () => {}, { store })).rejects.toMatchObject({ status: 404, code: "lokal_nicht_gefunden" });
      await expect(discardPending(id, "u1", api, store)).rejects.toMatchObject({ code: "lokal_nicht_gefunden" });
      expect(await store.getMeta(id)).toBeDefined();
      expect(await store.getChunk(id, 0)).toBeDefined();
      expect(values.has("podcast-studio:nicht-lokal:" + id)).toBe(true);
    }
    expect(calls).toEqual([]);
    // eigener Alt-Eintrag ist nach Besitzprüfung bergbar
    const t = await resumePending("alt-eigen", "u1", api, () => {}, { store });
    expect(t.status).toBe("processing");
    expect(calls).toEqual(["put0", "finalize1"]);
    expect(await store.getMeta("alt-eigen")).toBeUndefined();
  });

  it("Cookie in anderem Tab auf fremdes Konto gewechselt → u1 sieht/birgt/löscht nichts, auch eigene Einträge bleiben", async () => {
    const { store, calls } = await dreiKonten();
    const { api } = fakeApi({ session: vi.fn(async () => ({ user: { id: "u2" } })), getTrack: vi.fn(async () => track()) });
    expect(await listPending("u1", api, store)).toEqual([]);
    await expect(resumePending("eigen", "u1", api, () => {}, { store })).rejects.toMatchObject({ code: "lokal_nicht_gefunden" });
    await expect(discardPending("eigen", "u1", api, store)).rejects.toMatchObject({ code: "lokal_nicht_gefunden" });
    expect(store.metas.size).toBe(4);
    expect(calls).toEqual([]);
    // Sitzung nicht prüfbar (Netz) → ebenfalls nichts
    const { api: netz } = fakeApi({ session: vi.fn(async () => { throw netErr(); }) });
    expect(await listPending("u1", netz, store)).toEqual([]);
  });

  it("ungesicherteAufnahmen zählt nur eigene Einträge (Abmelden-Dialog)", async () => {
    const { store } = await dreiKonten();
    expect(await ungesicherteAufnahmen("u1", store)).toBe(1);
    expect(await ungesicherteAufnahmen("u3", store)).toBe(0);
  });

  it("401 ist wiederholbar und heißt Anmeldung nötig; Bergung meldet ihn sofort ohne Löschen", async () => {
    const e = new ApiError(401, "unauthenticated", "x");
    expect(istWiederholbar(e)).toBe(true);
    expect(brauchtAnmeldung(e)).toBe(true);
    expect(brauchtAnmeldung(netErr())).toBe(false);
    const store = memoryStore();
    await store.saveMeta(meta());
    await store.addChunk("t1", 0, new Blob(["a"]), 5000);
    let n = 0;
    const { api } = fakeApi({ getTrack: vi.fn(async () => { n++; throw e; }) });
    const { syncAndFinalize } = await import("./pending");
    await expect(syncAndFinalize("t1", api, () => {}, { store, sleep: async () => {} })).rejects.toMatchObject({ status: 401 });
    expect(n).toBe(1);
    expect(store.chunks.size).toBe(1);
  });

  it("Warteschlange: 401 → anmeldungNoetig (nicht fatal, nicht offline), nach Erfolg zurückgesetzt", async () => {
    let auth = false;
    const states: { anmeldungNoetig: boolean; offline: boolean; fatal: unknown }[] = [];
    const q = new UploadQueue({
      upload: async () => { if (!auth) throw new ApiError(401, "unauthenticated", "x"); },
      onChange: (st) => states.push({ ...st }),
      sleep: async () => { auth = true; },
    });
    q.push(0, new Blob(["a"]));
    await q.drained();
    expect(states.some((x) => x.anmeldungNoetig && !x.offline && !x.fatal)).toBe(true);
    expect(q.state).toMatchObject({ uploaded: 1, anmeldungNoetig: false, fatal: null });
  });
});

describe("PA7: Engine bei abgelaufener Sitzung und Kontowechsel", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function aufnahme(sessionUser: () => string | null, putFehler: () => ApiError | null) {
    browser(async () => new FakeStream());
    const store = memoryStore();
    const { api, calls, server } = fakeApi();
    const put = api.putChunk.bind(api);
    const versuche: number[] = [];
    (api as { putChunk: unknown }).putChunk = async (id: string, i: number, b: Blob) => {
      versuche.push(i);
      const f = putFehler();
      if (f) throw f;
      return put(id, i, b);
    };
    (api as { session: unknown }).session = vi.fn(async () => ({ user: sessionUser() ? { id: sessionUser() } : null, setupRequired: false }));
    (api as { getTrack: unknown }).getTrack = async () => track({ status: "ready", receivedChunks: server.received.size });
    const s = createStudio(api, { userId: "u1", store });
    await s.init();
    await s.start({ projectId: "p1", title: "Folge", participantName: "Ich" });
    return { s, store, calls, server, versuche };
  }

  it("Sitzung läuft während der Aufnahme ab → Aufnahme läuft weiter, lokal gesichert; Reauth desselben Kontos → lückenlos", async () => {
    let user: string | null = "u1";
    let abgelaufen = true;
    const { s, store, calls, server, versuche } = await aufnahme(() => user, () => (abgelaufen ? new ApiError(401, "unauthenticated", "x") : null));
    expect(store.metas.get("t1")?.userId).toBe("u1");
    user = null;
    FakeRecorder.last.emit("a");
    FakeRecorder.last.emit("b");
    for (let i = 0; i < 6; i++) await flush();
    expect(s.getSnapshot().phase).toBe("aufnahme");
    expect(s.getSnapshot().warnings).toMatchObject({ anmeldungNoetig: true, offline: false });
    expect(s.getSnapshot().error).toBeNull();
    expect(store.chunks.size).toBe(2);
    const vorher = versuche.length;
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(versuche.length).toBe(vorher); // ohne gültige Sitzung wird nichts gesendet
    abgelaufen = false; user = "u1";
    handlers.get("studio:angemeldet")?.();
    expect(s.getSnapshot().warnings.anmeldungNoetig).toBe(false);
    const stopping = s.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;
    expect([...server.received]).toEqual([0, 1, 2]);
    expect(calls.at(-1)).toBe("finalize3");
    expect(s.getSnapshot().phase).toBe("fertig");
  });

  it("anderes Konto im Browser (404 + fremde Sitzung) → nicht fatal, nichts gesendet; erst Konto u1 setzt fort", async () => {
    let user = "u1";
    const { s, store, server, versuche } = await aufnahme(() => user, () => (user === "u1" ? null : new ApiError(404, "not_found", "x")));
    user = "u2";
    FakeRecorder.last.emit("a");
    for (let i = 0; i < 8; i++) await flush();
    expect(s.getSnapshot().phase).toBe("aufnahme");
    expect(s.getSnapshot().warnings.anmeldungNoetig).toBe(true);
    expect(store.chunks.size).toBe(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const n = versuche.length;
    handlers.get("studio:angemeldet")?.(); // z. B. Ereignis, obwohl noch u2 angemeldet ist
    await vi.advanceTimersByTimeAsync(40_000);
    expect(versuche.length).toBe(n); // u2-Sitzung → kein weiterer Sendeversuch
    expect(s.getSnapshot().warnings.anmeldungNoetig).toBe(true);
    user = "u1";
    handlers.get("studio:angemeldet")?.();
    const stopping = s.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;
    expect([...server.received]).toEqual([0, 1]);
    expect(s.getSnapshot().phase).toBe("fertig");
  });

  it("Start bei fremdem Cookie: 404 → konto_gewechselt (Reauth), keine lokale Anlage; Ereignis studio:abgemeldet", async () => {
    browser(async () => new FakeStream());
    const events: string[] = [];
    (window as unknown as { dispatchEvent: unknown }).dispatchEvent = (e: Event) => { events.push(e.type); return true; };
    const store = memoryStore();
    const { api } = fakeApi({
      createRecording: vi.fn(async () => { throw new ApiError(404, "not_found", "x"); }),
      session: vi.fn(async () => ({ user: { id: "u2" } })),
    });
    const s = createStudio(api, { userId: "u1", store });
    await s.init();
    await s.start({ projectId: "p1", title: "Folge", participantName: "Ich" });
    expect(s.getSnapshot()).toMatchObject({ phase: "bereit", error: { code: "konto_gewechselt" } });
    expect(events).toEqual(["studio:abgemeldet"]);
    expect(store.metas.size).toBe(0);
    handlers.get("studio:angemeldet")?.();
    expect(s.getSnapshot().error).toBeNull();
  });

  it("echte 404 desselben Kontos bleibt endgültig (keine Endlosschleife)", async () => {
    const { s } = await aufnahme(() => "u1", () => new ApiError(404, "not_found", "x"));
    FakeRecorder.last.emit("a");
    await s.stop();
    expect(s.getSnapshot()).toMatchObject({ phase: "fehler-abschluss", error: { code: "not_found" } });
  });

  it("Start ohne Sitzung bzw. bei erreichtem Kontingent → eigener Fehlercode, nichts lokal angelegt", async () => {
    for (const err of [new ApiError(401, "unauthenticated", "x"), new ApiError(402, "quota_exceeded", "voll", { meter: "storage_bytes", used: 10, limit: 10 })]) {
      browser(async () => new FakeStream());
      const store = memoryStore();
      const { api } = fakeApi({ createRecording: vi.fn(async () => { throw err; }) });
      const s = createStudio(api, { userId: "u1", store });
      await s.init();
      await s.start({ projectId: "p1", title: "Folge", participantName: "Ich" });
      expect(s.getSnapshot()).toMatchObject({ phase: "bereit", error: { code: err.code } });
      if (err.code === "quota_exceeded") expect(s.getSnapshot().error?.details).toMatchObject({ used: 10, limit: 10 });
      expect(store.metas.size).toBe(0);
      if (err.status === 401) { handlers.get("studio:angemeldet")?.(); expect(s.getSnapshot().error).toBeNull(); }
    }
  });
});
