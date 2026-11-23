// Aufnahme-Engine (AP3): Geräte, Pegel, MediaRecorder, lokale Sicherung, Upload, Abschluss. Ohne React.
import { ApiError, MIN_FREE_BYTES, type ApiClient, type Track } from "../api";
import {
  backoffMs, brauchtAnmeldung, frist, istWebkitSafari, istWiederholbar, mapCameraError, mapMediaError, mitFrist, pickMimeType, RAM_PUFFER_MAX_BYTES,
  SAFARI_FREIGEGEBEN, SENDE_FRIST_MS, STATUS_FRIST_MS, VIDEO_MIME_CANDIDATES, videoBitrate,
} from "./format";
import { getDefaultStore, lockName, vergiss, vermerkeNichtLokal, vermerkeErzeugt } from "./pending";
import { UploadQueue } from "./queue";
import type { ChunkStore } from "./store";
import type { KameraStand, Studio, StudioPhase, StudioSnapshot } from "./types";

export const TIMESLICE_MS = 4000;
export const AUDIO_BITRATE = 256_000;
/** Pegel unter diesem Wert gilt als Stille (dBFS). */
const SILENCE_DB = -55;
const SILENCE_WARN_MS = 5000;
/** Browser-Quota-Warnung unterhalb dieses Restplatzes. */
const BROWSER_MIN_FREE = 500 * 1024 ** 2;
const POLL_MS = 2000;

const KAMERA_AUS: Omit<KameraStand, "mimeType" | "error"> = { status: "aus", stream: null, width: null, height: null, frameRate: null, label: null };

export const initialSnapshot = (): StudioSnapshot => ({
  phase: "anfrage",
  warnings: {
    keinPegel: false, offline: false, geraetVerloren: false, browserSpeicherKnapp: false, serverSpeicherKnapp: false,
    lokalNichtGesichert: false, kameraVerloren: false, anmeldungNoetig: false,
  },
  devices: { audio: [], video: [] },
  selected: { audioId: null, videoId: null, camera: false, sprachoptimierung: false },
  stream: null, kamera: { ...KAMERA_AUS, mimeType: null, error: null }, level: 0, levelActive: false, elapsedMs: 0,
  chunks: { total: 0, uploaded: 0, lokal: 0, nurRam: 0, ramBytes: 0 }, mimeType: null, track: null, error: null,
});

/** Wunsch 1080p30, Rückfall 720p (Umsetzung §6.2) – kein 4K-Versprechen. */
function videoConstraints(deviceId: string | null, hd: boolean): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: hd ? 1920 : 1280 }, height: { ideal: hd ? 1080 : 720 }, frameRate: { ideal: 30 },
  };
}

type Err = StudioSnapshot["error"];
const errOf = (e: unknown, fallbackCode: string): NonNullable<Err> => {
  const x = e as { code?: string; message?: string; details?: Record<string, unknown> };
  return { code: x?.code ?? fallbackCode, message: x?.message ?? String(e), details: x?.details };
};

/** userId (PA7): Konto, für das diese Engine aufnimmt. Nur dieses Konto darf Abschnitte senden und abschließen. */
export function createStudio(api: ApiClient, deps: { store?: ChunkStore; userId: string }): Studio {
  const store = deps.store ?? getDefaultStore();
  const userId = deps.userId;
  let snap = initialSnapshot();
  const listeners = new Set<(s: StudioSnapshot) => void>();
  const set = (p: Partial<StudioSnapshot>) => { snap = { ...snap, ...p }; listeners.forEach((f) => f(snap)); };
  const warn = (p: Partial<StudioSnapshot["warnings"]>) => set({ warnings: { ...snap.warnings, ...p } });
  const phase = (ph: StudioPhase, error: Err = null) => set({ phase: ph, error });

  let disposed = false;
  let listening = false;
  let stream: MediaStream | null = null;
  let streamGen = 0;
  let ctx: AudioContext | null = null;
  let levelTimer: ReturnType<typeof setInterval> | undefined;
  let silentSince: number | null = null;
  // Kamera (AP9) – eigener Stream, damit ein Kamerafehler das Mikrofon nicht berührt.
  let kameraStream: MediaStream | null = null;
  let camGen = 0;
  let audioMime: string | null = null;
  let videoMime: string | null = null;
  const kamera = (p: Partial<KameraStand>) => set({ kamera: { ...snap.kamera, ...p } });

  // Aufnahme
  let recorder: MediaRecorder | null = null;
  let queue: UploadQueue | null = null;
  let trackId: string | null = null;
  let nextIndex = 0;
  let persistChain: Promise<void> = Promise.resolve();
  let recStart = 0;
  let durationMs = 0;
  let stopped: Promise<void> = Promise.resolve();
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let quotaTimer: ReturnType<typeof setInterval> | undefined;
  let wakeLock: WakeLockSentinel | null = null;
  let releaseLock: (() => void) | null = null;
  let wakeSleep = new AbortController();
  let persisted = false;
  /** PA7: Sitzung fehlt bzw. anderes Konto angemeldet → nichts senden, bis die Sitzung wieder diesem Konto gehört. */
  let authWartet = false;
  /** F1: erzeugte Abschnitte, deren lokale Sicherung fehlschlug und die der Server noch nicht bestätigt hat. */
  let nurRam = new Set<number>();
  let lokalOk = new Set<number>();
  let lokalGestoert = false;
  /** Abschnitt 0 trägt den Dateikopf – für eine abspielbare Notfalldatei. */
  let kopf: Blob | null = null;
  // Jeder erzeugte, noch nicht serverbestätigte Blob ist sofort zur Rettung erreichbar – unabhängig von IDB/Queue.
  const rettung = new Map<number, Blob>();
  /** Bytes in `rettung` (dieselben Blob-Objekte wie in der Queue, keine Kopie). Begrenzt durch RAM_PUFFER_MAX_BYTES. */
  let ramBytes = 0;
  let pufferVoll = false;
  const chunksNow = () => ({ total: nextIndex, uploaded: queue?.state.uploaded ?? 0, lokal: lokalOk.size, nurRam: nurRam.size, ramBytes });

  const recording = () => snap.phase === "aufnahme" || snap.phase === "abschluss" || snap.phase === "countdown";

  // ---------- Umgebung ----------
  const onOnline = () => { queue?.wake(); wakeSleep.abort(); wakeSleep = new AbortController(); void checkServer().catch(() => {}); };
  /** Nach Reauth (Ereignis `studio:angemeldet`): sofort neu versuchen; ob es das richtige Konto ist, prüft anmeldungPruefen. */
  const onAngemeldet = () => {
    warn({ anmeldungNoetig: false });
    if ((snap.error?.code === "unauthenticated" || snap.error?.code === "konto_gewechselt") && !recording()) set({ error: null });
    onOnline();
  };
  const onDeviceChange = () => { void refreshDevices(); };
  const onVisibility = () => { if (document.visibilityState === "visible" && snap.phase === "aufnahme") void acquireWakeLock(); };
  const onGesture = () => { if (ctx?.state === "suspended") void ctx.resume().catch(() => {}); };

  function listen(on: boolean) {
    if (on === listening || typeof window === "undefined") return;
    listening = on;
    const m = on ? "addEventListener" : "removeEventListener";
    window[m]("online", onOnline);
    window[m]("studio:angemeldet", onAngemeldet);
    window[m]("pointerdown", onGesture);
    window[m]("keydown", onGesture);
    document[m]("visibilitychange", onVisibility);
    navigator.mediaDevices?.[m]?.("devicechange", onDeviceChange);
  }

  async function checkServer() {
    try {
      const h = await api.health(frist(STATUS_FRIST_MS));
      warn({ serverSpeicherKnapp: h.freeBytes < MIN_FREE_BYTES, offline: recording() ? snap.warnings.offline : false });
      return h;
    } catch (e) {
      if (!recording()) set({ error: { code: "server_nicht_erreichbar", message: "Der Server ist nicht erreichbar. Aufnahme erst möglich, wenn die Verbindung steht." } });
      throw e;
    }
  }

  async function checkQuota() {
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota != null && est.usage != null) warn({ browserSpeicherKnapp: est.quota - est.usage < BROWSER_MIN_FREE });
    } catch { /* nicht verfügbar → keine Aussage */ }
  }

  async function refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      set({ devices: { audio: all.filter((d) => d.kind === "audioinput" && d.deviceId), video: all.filter((d) => d.kind === "videoinput" && d.deviceId) } });
    } catch { /* Liste bleibt */ }
  }

  // ---------- Stream & Pegel ----------
  function stopStream() {
    streamGen++;
    clearInterval(levelTimer);
    levelTimer = undefined;
    void ctx?.close().catch(() => {});
    ctx = null;
    stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    stream = null;
    silentSince = null;
    set({ stream: null, level: 0, levelActive: false, warnings: { ...snap.warnings, keinPegel: false } });
  }

  function constraints(withDevice: boolean): MediaStreamConstraints {
    const on = snap.selected.sprachoptimierung;
    return {
      audio: {
        ...(withDevice && snap.selected.audioId ? { deviceId: { exact: snap.selected.audioId } } : {}),
        echoCancellation: on, noiseSuppression: on, autoGainControl: on,
        sampleRate: { ideal: 48000 },
      },
      video: false, // ponytail: Video erst Meilenstein 2 (AP9)
    };
  }

  async function openStream() {
    stopStream();
    const gen = streamGen;
    phase("anfrage");
    let s: MediaStream;
    try {
      try {
        s = await navigator.mediaDevices.getUserMedia(constraints(true));
      } catch (e) {
        // Gewähltes Gerät verschwunden → Standardgerät versuchen
        if ((e as Error)?.name === "OverconstrainedError" && snap.selected.audioId) s = await navigator.mediaDevices.getUserMedia(constraints(false));
        else throw e;
      }
    } catch (e) {
      if (disposed || gen !== streamGen) return;
      const m = mapMediaError(e);
      phase(m.phase, { code: m.code, message: m.message });
      if (m.phase === "kein-geraet" || m.phase === "geraet-belegt") void refreshDevices();
      return;
    }
    if (disposed || gen !== streamGen) { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    const track = s.getAudioTracks()[0];
    if (!track) { s.getTracks().forEach((t) => t.stop()); stream = null; phase("kein-geraet", { code: "kein_geraet", message: "Es wurde kein Mikrofon gefunden." }); return; }
    track.onended = onTrackEnded;
    set({ stream: s, selected: { ...snap.selected, audioId: track.getSettings().deviceId ?? snap.selected.audioId } });
    warn({ geraetVerloren: false });
    phase("bereit");
    setupLevel(s);
    void refreshDevices();
  }

  function setupLevel(s: MediaStream) {
    try {
      ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Float32Array(an.fftSize);
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      levelTimer = setInterval(() => {
        if (!ctx) return;
        const active = ctx.state === "running";
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-9);
        const now = performance.now();
        const lvl = Math.max(0, Math.min(1, (db + 60) / 60));
        let keinPegel = false;
        if (active && db < SILENCE_DB) { silentSince ??= now; keinPegel = now - silentSince >= SILENCE_WARN_MS; }
        else silentSince = null;
        set({
          level: active ? Math.max(lvl, snap.level * 0.85) : 0, levelActive: active,
          warnings: snap.warnings.keinPegel === keinPegel ? snap.warnings : { ...snap.warnings, keinPegel },
        });
      }, 100);
    } catch {
      set({ levelActive: false }); // Pegel nicht messbar – Aufnahme bleibt möglich
    }
  }

  function onTrackEnded() {
    warn({ geraetVerloren: true });
    if (snap.phase === "aufnahme") { void api_stop(); return; }
    if (!recording()) {
      stopStream();
      phase("kein-geraet", { code: "geraet_getrennt", message: "Das Mikrofon wurde getrennt." });
    }
  }

  // ---------- Kamera (AP9) ----------
  function stopCamera(status: KameraStand["status"] = "aus", error: KameraStand["error"] = null) {
    camGen++;
    kameraStream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    kameraStream = null;
    kamera({ ...KAMERA_AUS, status, error });
  }

  async function openCamera() {
    stopCamera("anfrage"); // alte Kamera-Spur zuerst freigeben (Kamerawechsel)
    const gen = camGen;
    const md = navigator.mediaDevices;
    const id = snap.selected.videoId;
    const nameOf = (e: unknown) => (e as Error)?.name ?? "";
    const versuche: (() => Promise<MediaStream>)[] = [
      () => md.getUserMedia({ audio: false, video: videoConstraints(id, true) }),
      () => md.getUserMedia({ audio: false, video: videoConstraints(id, false) }),
    ];
    let s: MediaStream | null = null;
    let fehler: unknown = null;
    for (let i = 0; i < versuche.length && !s; i++) {
      try { s = await versuche[i](); } catch (e) {
        fehler = e;
        // Verweigerung ist endgültig; nur Belegt/Überfordert/abgebrochen lohnt den 720p-Rückfall.
        if (!["OverconstrainedError", "NotReadableError", "TrackStartError", "AbortError"].includes(nameOf(e))) break;
        // Gewählte Kamera verschwunden → einmal Standardkamera.
        if (i === versuche.length - 1 && id && nameOf(e) === "OverconstrainedError") versuche.push(() => md.getUserMedia({ audio: false, video: videoConstraints(null, false) }));
      }
    }
    if (disposed || gen !== camGen) { s?.getTracks().forEach((t) => t.stop()); return; }
    const vt = s?.getVideoTracks()[0];
    if (!s || !vt) {
      s?.getTracks().forEach((t) => t.stop());
      stopCamera("fehler", s ? { code: "kamera_kein_geraet", message: "Es wurde keine Kamera gefunden." } : mapCameraError(fehler));
      void refreshDevices();
      return;
    }
    kameraStream = s;
    vt.onended = onCameraEnded;
    const st = vt.getSettings();
    set({ selected: { ...snap.selected, videoId: st.deviceId ?? snap.selected.videoId } });
    kamera({ status: "an", stream: s, width: st.width ?? null, height: st.height ?? null, frameRate: st.frameRate ?? null, label: vt.label || null, error: null });
    warn({ kameraVerloren: false });
    void refreshDevices();
  }

  function onCameraEnded() {
    if (snap.phase === "aufnahme") {
      // Keine riskante Stream-Neuerzeugung während der Aufnahme: kontrolliert beenden, Stand sichern.
      warn({ kameraVerloren: true });
      set({ error: { code: "kamera_getrennt", message: "Die Kamera wurde während der Aufnahme getrennt. Die Aufnahme wurde beendet, der Stand bis dahin wird gesichert." } });
      void api_stop();
      return;
    }
    stopCamera("fehler", { code: "kamera_getrennt", message: "Die Kamera wurde getrennt." });
  }

  // ---------- Aufnahme ----------
  async function acquireWakeLock() {
    try { wakeLock = (await navigator.wakeLock?.request("screen")) ?? null; } catch { wakeLock = null; }
  }
  function releaseWakeLock() { void wakeLock?.release().catch(() => {}); wakeLock = null; }

  function holdLock(id: string) {
    const locks = (navigator as Navigator).locks;
    if (!locks) return;
    void locks.request(lockName(id), () => new Promise<void>((res) => { releaseLock = res; })).catch(() => {});
  }
  function dropLock() { releaseLock?.(); releaseLock = null; }

  /** Wartet die Engine auf Anmeldung, geht nichts an den Server, solange die Sitzung nicht wieder `userId` gehört. */
  async function anmeldungPruefen() {
    if (!authWartet) return;
    const si = await mitFrist(api.session(frist(STATUS_FRIST_MS)), STATUS_FRIST_MS).catch(() => null);
    if (si?.user?.id === userId) { authWartet = false; return; }
    throw new ApiError(401, "anmeldung_noetig", "Bitte erneut anmelden – die Aufnahme bleibt bis dahin lokal gesichert.");
  }

  /**
   * 401 → warten auf Anmeldung. 404 kann auch heißen „anderes Konto im Browser angemeldet“ (Cookie gilt für alle Tabs):
   * dann ebenfalls warten statt endgültig abbrechen. Nur eine echte 404 desselben Kontos bleibt endgültig.
   */
  async function kontoPruefen(e: unknown): Promise<unknown> {
    if (brauchtAnmeldung(e)) { authWartet = true; return e; }
    if ((e as ApiError)?.status !== 404) return e;
    const si = await mitFrist(api.session(frist(STATUS_FRIST_MS)), STATUS_FRIST_MS).catch(() => undefined);
    if (si === undefined) return new ApiError(0, "network", "Die Sitzung konnte nicht geprüft werden.");
    if (si.user?.id === userId) return e; // echte 404 desselben Kontos → bleibt endgültig
    if (!authWartet && typeof window !== "undefined") window.dispatchEvent(new Event("studio:abgemeldet")); // wie 401: Gate/Studio wissen Bescheid
    authWartet = true;
    return new ApiError(401, "konto_gewechselt", "In diesem Browser ist gerade ein anderes oder kein Konto angemeldet. Die Aufnahme bleibt lokal; bitte mit dem ursprünglichen Konto anmelden.");
  }

  const sleepWakeable = (ms: number) => new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    wakeSleep.signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

  async function start(opts: { projectId: string; title: string; participantName: string }) {
    const video = snap.selected.camera;
    if (snap.phase !== "bereit" || !stream || !snap.mimeType) throw new Error("Studio ist nicht bereit.");
    if (video && !kameraStream) throw new Error("Die Kamera ist nicht bereit. Kamera erneut versuchen oder „Nur Ton“ wählen.");
    const mimeType = snap.mimeType;
    phase("countdown");
    onGesture();
    const back = (e: NonNullable<Err>) => { if (!disposed) phase("bereit", e); };
    try {
      const h = await checkServer();
      if (h.freeBytes < MIN_FREE_BYTES) return back({ code: "speicher_knapp", message: "Auf dem Server sind weniger als 10 GB frei. Bitte erst Platz schaffen." });
    } catch (e) {
      return back({ code: "server_nicht_erreichbar", message: "Der Server ist nicht erreichbar. Bitte Verbindung prüfen und erneut starten.", details: { cause: errOf(e, "network").code } });
    }
    if (disposed) return;
    const startedAtMs = Date.now(); // ponytail: Client-Uhr ~Millisekunden vor recorder.start(); reicht für spätere Grob-Synchronisation
    let track: Track;
    try {
      ({ track } = await api.createRecording(opts.projectId, { title: opts.title, kind: video ? "video" : "audio", mimeType, participantName: opts.participantName, startedAtMs }, frist(SENDE_FRIST_MS)));
    } catch (e) {
      return back(errOf(await kontoPruefen(e), "anlegen_fehlgeschlagen")); // 404 bei fremdem Cookie → konto_gewechselt statt „nicht gefunden“
    }
    try {
      await mitFrist(store.saveMeta({ trackId: track.id, userId, projectId: opts.projectId, title: opts.title, mimeType, startedAtMs, chunkCount: 0, lastChunkAtMs: startedAtMs, durationMs: null }));
    } catch {
      return back({ code: "lokal_nicht_moeglich", message: "Die lokale Sicherung im Browser ist nicht möglich (privates Fenster oder Speicher voll?). Ohne sie wird nicht aufgenommen." });
    }
    if (disposed || !stream) { void store.deleteTrack(track.id); return; }
    if (video && !kameraStream) {
      void store.deleteTrack(track.id);
      return back({ code: "kamera_getrennt", message: "Die Kamera wurde vor dem Start getrennt. Es wurde nichts aufgenommen." });
    }
    // Ein gemeinsamer Stream aus Mikrofon- und Kamera-Spur; erzeugt keine neuen Geräte-Spuren.
    const recStream = video ? new MediaStream([...stream.getAudioTracks(), ...kameraStream!.getVideoTracks()]) : stream;

    if (!persisted) { persisted = true; void navigator.storage?.persist?.().catch(() => false); }
    holdLock(track.id);
    trackId = track.id;
    nextIndex = 0;
    nurRam = new Set();
    lokalOk = new Set();
    lokalGestoert = false;
    kopf = null;
    rettung.clear();
    ramBytes = 0;
    pufferVoll = false;
    persistChain = Promise.resolve();
    const id = track.id;
    queue = new UploadQueue({
      upload: async (i, b, signal) => {
        await anmeldungPruefen();
        try { await api.putChunk(id, i, b, signal); }
        catch (e0) {
          const e = await kontoPruefen(e0);
          // Server meldet „upload_busy“ auch, wenn die Spur gar nicht mehr annimmt → dann endgültig statt endlos wiederholen.
          if ((e as ApiError)?.code === "upload_busy") {
            const t = await api.getTrack(id, frist(STATUS_FRIST_MS)).catch(() => null);
            if (t && t.status !== "uploading") throw new ApiError(409, "not_uploading", `Die Spur nimmt keine Abschnitte mehr an (Status ${t.status}).`);
          }
          throw e;
        }
      },
      onUploaded: (i) => {
        ramBytes -= rettung.get(i)?.size ?? 0;
        rettung.delete(i);
        if (nurRam.delete(i) || lokalOk.delete(i)) set({ chunks: chunksNow() }); // erst jetzt (Server bestätigt) gilt er als sicher
        return mitFrist(store.deleteChunk(id, i));
      },
      onChange: (q) => {
        set({ chunks: chunksNow() }); // queue.state === q
        warn({ offline: q.offline && !q.fatal, anmeldungNoetig: q.anmeldungNoetig && !q.fatal });
        if (q.fatal && snap.phase === "aufnahme") {
          set({ error: { ...errOf(q.fatal, "upload_abgelehnt"), message: `Der Server nimmt keine Abschnitte mehr an: ${errOf(q.fatal, "").message} Die Aufnahme läuft lokal weiter.` } });
        }
      },
    });

    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(recStream, {
        mimeType, audioBitsPerSecond: AUDIO_BITRATE, ...(video ? { videoBitsPerSecond: videoBitrate(snap.kamera.height) } : {}),
      });
    } catch (e) {
      dropLock(); queue.close(); queue = null; void store.deleteTrack(id);
      return back({ code: "recorder_fehler", message: `Der Browser kann die Aufnahme nicht starten (${(e as Error)?.name ?? e}).` });
    }
    recorder = rec;
    stopped = new Promise<void>((res) => { rec.onstop = () => { durationMs = performance.now() - recStart; res(); }; });
    rec.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      const i = nextIndex++;
      const at = Date.now();
      const blob = ev.data;
      if (i === 0) kopf = blob;
      rettung.set(i, blob);
      ramBytes += blob.size;
      nurRam.add(i);
      vermerkeErzeugt(id, i);
      set({ chunks: chunksNow() });
      // Reihenfolge garantiert: erst lokal sichern (mit Frist, falls IndexedDB hängt), dann einreihen.
      persistChain = persistChain.then(async () => {
        try { await mitFrist(store.addChunk(id, i, blob, at)); nurRam.delete(i); lokalOk.add(i); set({ chunks: chunksNow() }); }
        catch { lokalFehlgeschlagen(id, i); }
        queue?.push(i, blob);
      });
      // Begrenzter Arbeitsspeicher (Video ≈ 1 MB/s offline): kontrolliert beenden statt unbegrenzt wachsen. Nichts wird verworfen.
      if (ramBytes > RAM_PUFFER_MAX_BYTES && !pufferVoll && snap.phase === "aufnahme") {
        pufferVoll = true;
        set({ error: { code: "puffer_voll", message: `Über ${Math.round(RAM_PUFFER_MAX_BYTES / 1024 ** 2)} MB Aufnahme sind noch nicht vom Server bestätigt. Die Aufnahme wurde deshalb sicherheitshalber beendet; alles Aufgenommene wird weiter gesichert.` } });
        void api_stop();
      }
    };
    rec.onerror = (ev) => {
      const name = (ev as unknown as { error?: Error }).error?.name ?? "Fehler";
      set({ error: { code: "recorder_fehler", message: `Die Aufnahme wurde vom Browser beendet (${name}). Der bisherige Stand wird gesichert.` } });
      warn({ geraetVerloren: true });
      void api_stop();
    };
    rec.start(TIMESLICE_MS);
    recStart = performance.now();
    durationMs = 0;
    set({ track, elapsedMs: 0, chunks: chunksNow() });
    phase("aufnahme");
    elapsedTimer = setInterval(() => set({ elapsedMs: performance.now() - recStart }), 250);
    quotaTimer = setInterval(() => void checkQuota(), 60_000);
    void acquireWakeLock();
  }

  /**
   * F1: lokale Sicherung versagt → Aufnahme beim ERSTEN Fehler kontrolliert beenden, damit der ungesicherte Teil nicht wächst.
   * Läuft innerhalb von persistChain: api_stop() wird NICHT abgewartet (es wartet selbst auf persistChain → Verklemmung).
   */
  function lokalFehlgeschlagen(id: string, i: number) {
    nurRam.add(i);
    set({ chunks: chunksNow() });
    warn({ lokalNichtGesichert: true });
    if (!lokalGestoert) {
      lokalGestoert = true;
      if (snap.phase === "aufnahme") {
        set({ error: { code: "lokal_nicht_gesichert", message: "Der Browser konnte einen Abschnitt nicht lokal sichern. Die Aufnahme wurde deshalb sofort beendet." } });
        void api_stop();
      }
    }
    void vermerkeNichtLokal(store, id, i); // synchroner Zweitvermerk zuerst; IDB-Metadaten dürfen Upload/Rettung nicht blockieren
  }

  async function api_stop() {
    if (snap.phase !== "aufnahme" || !recorder) return;
    set({ phase: "abschluss" }); // Fehler (z. B. upload_abgelehnt) bleibt sichtbar
    if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* bereits gestoppt */ } }
    await stopped;
    clearInterval(elapsedTimer);
    clearInterval(quotaTimer);
    set({ elapsedMs: durationMs });
    releaseWakeLock();
    await persistChain;
    stopStream(); // Mikrofon freigeben
    stopCamera(); // Kamera freigeben
    try {
      const m = await mitFrist(store.getMeta(trackId!));
      if (m) await mitFrist(store.saveMeta({ ...m, durationMs: Math.round(durationMs) }));
    } catch { /* Dauer wird sonst aus Zeitstempeln geschätzt */ }
    await finishUpload({});
  }

  async function finishUpload(opts: { allowPartial?: boolean }) {
    const id = trackId!;
    if (snap.phase !== "abschluss") phase("abschluss");
    if (nextIndex === 0) {
      void vergiss(store, id).catch(() => {});
      dropLock();
      phase("fehler-abschluss", { code: "keine_daten", message: "Der Browser hat keine Aufnahmedaten geliefert. Es wurde nichts gespeichert." });
      return;
    }
    try {
      await queue!.drained();
    } catch (e) {
      if (disposed) { dropLock(); return; } // lokale Abschnitte bleiben → Wiederherstellung
      const wo = nurRam.size ? `Nicht bestätigte Abschnitte liegen teils nur im Arbeitsspeicher dieses Tabs (${nurRam.size}).` : "Die Abschnitte bleiben lokal gespeichert.";
      phase("fehler-abschluss", { ...errOf(e, "upload_abgelehnt"), message: `Der Server hat einen Abschnitt abgewiesen: ${errOf(e, "").message} ${wo}` });
      return;
    }
    let t: Track;
    for (let i = 0; ; i++) {
      try {
        await anmeldungPruefen();
        // Echte Frist je Versuch (F2). Nach verlorener Quittung liefert die Wiederholung den angenommenen Stand (idempotent).
        t = await api.finalizeTrack(id, { chunkCount: nextIndex, durationMs: Math.round(durationMs), allowPartial: opts.allowPartial || undefined }, frist(SENDE_FRIST_MS));
        warn({ offline: false, anmeldungNoetig: false });
        break;
      } catch (e0) {
        const e = await kontoPruefen(e0);
        if (istWiederholbar(e)) {
          warn(brauchtAnmeldung(e) ? { anmeldungNoetig: true, offline: false } : { offline: true });
          await sleepWakeable(backoffMs(i));
          continue;
        }
        if (disposed) { dropLock(); return; }
        phase("fehler-abschluss", errOf(e, "abschluss_fehlgeschlagen"));
        return;
      }
    }
    // Server hat alle Abschnitte → lokale Kopie ist überflüssig.
    await vergiss(store, id).catch(() => {});
    dropLock();
    set({ track: t });
    await poll(t);
  }

  async function poll(t: Track) {
    while (!disposed) {
      if (t.status === "ready") { set({ track: t }); phase("fertig"); return; }
      if (t.status === "failed") {
        set({ track: t });
        phase("fehler-abschluss", { code: "verarbeitung_fehlgeschlagen", message: t.error ?? "Die Verarbeitung auf dem Server ist fehlgeschlagen." });
        return;
      }
      if (snap.phase !== "verarbeitung") phase("verarbeitung");
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (disposed) return;
      try { t = await api.getTrack(t.id, frist(STATUS_FRIST_MS)); warn({ offline: false, anmeldungNoetig: false }); }
      catch (e0) { const e = await kontoPruefen(e0); warn(brauchtAnmeldung(e) ? { anmeldungNoetig: true } : { offline: true }); }
    }
  }

  // ---------- öffentliche Schnittstelle ----------
  async function init() {
    if (disposed) return;
    if (typeof window === "undefined" || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      phase("unsicher", { code: "unsicher", message: "Aufnahmen sind nur über eine sichere HTTPS-Adresse möglich." });
      return;
    }
    if (!SAFARI_FREIGEGEBEN && istWebkitSafari(navigator.userAgent, navigator.maxTouchPoints)) {
      phase("nicht-unterstuetzt", { code: "safari", message: "Safari und Browser auf iPhone/iPad sind in dieser Version noch nicht auf sichere Abschnittsaufnahme geprüft. Bitte Chrome oder Firefox am Computer verwenden." });
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      phase("nicht-unterstuetzt", { code: "kein_mediarecorder", message: "Dieser Browser kann keine Aufnahmen erstellen (MediaRecorder fehlt)." });
      return;
    }
    const mime = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) {
      phase("nicht-unterstuetzt", { code: "kein_format", message: "Dieser Browser unterstützt keines der Aufnahmeformate (WebM/Opus, MP4/AAC)." });
      return;
    }
    try { await store.listMetas(); } catch {
      phase("nicht-unterstuetzt", { code: "kein_indexeddb", message: "Der Browser erlaubt keine lokale Sicherung (IndexedDB) – etwa im privaten Fenster. Ohne sie wird nicht aufgenommen." });
      return;
    }
    audioMime = mime;
    videoMime = pickMimeType((t) => MediaRecorder.isTypeSupported(t), VIDEO_MIME_CANDIDATES);
    set({ mimeType: mime, kamera: { ...snap.kamera, mimeType: videoMime } });
    listen(true);
    void checkServer().catch(() => {});
    void checkQuota();
    await openStream();
  }

  return {
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getSnapshot: () => snap,
    init,
    async retryPermission() {
      if (recording()) return;
      if (!snap.mimeType) return init();
      await openStream();
    },
    async selectAudio(id) {
      if (recording()) return;
      set({ selected: { ...snap.selected, audioId: id } });
      if (snap.mimeType) await openStream();
    },
    async selectVideo(id) {
      if (recording()) return; // während der Aufnahme kein Gerätewechsel
      set({ selected: { ...snap.selected, videoId: id } });
      if (snap.selected.camera) await openCamera();
    },
    async setCamera(on) {
      if (recording() || !audioMime) return;
      if (on && !videoMime) {
        kamera({ error: { code: "kein_videoformat", message: "Dieser Browser kann kein Video aufnehmen (kein unterstütztes Format). Aufgenommen wird nur Ton." } });
        return;
      }
      set({ selected: { ...snap.selected, camera: on }, mimeType: on ? videoMime : audioMime });
      if (on) await openCamera();
      else stopCamera();
    },
    async setSprachoptimierung(on) {
      if (recording()) return;
      set({ selected: { ...snap.selected, sprachoptimierung: on } });
      if (snap.mimeType && (snap.phase === "bereit" || stream)) await openStream();
    },
    start,
    stop: api_stop,
    async retryFinalize(opts = {}) {
      if (snap.phase !== "fehler-abschluss" || !trackId || !queue) return;
      if (snap.error?.code === "keine_daten") return;
      phase("abschluss");
      queue.resume();
      await finishUpload(opts);
    },
    notfallDatei() {
      const offen = [...rettung].sort(([a], [b]) => a - b).map(([index, blob]) => ({ index, blob }));
      if (!offen.length) return null;
      const vollstaendig = offen[0].index === 0;
      const teile = vollstaendig || !kopf ? offen.map((x) => x.blob) : [kopf, ...offen.map((x) => x.blob)];
      return { blob: new Blob(teile, { type: snap.mimeType ?? "" }), von: offen[0].index, bis: offen.at(-1)!.index, vollstaendig };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listen(false);
      if (snap.phase === "aufnahme") {
        // Navigation während der Aufnahme: sauber beenden; Sicherung/Upload/Abschluss laufen im Hintergrund weiter.
        void api_stop();
        return;
      }
      if (snap.phase !== "abschluss") { queue?.close(); dropLock(); }
      clearInterval(elapsedTimer);
      clearInterval(quotaTimer);
      releaseWakeLock();
      stopStream();
      stopCamera();
      listeners.clear();
    },
  };
}
