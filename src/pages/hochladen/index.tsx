// /hochladen (PA8): vorhandene MP3/WAV/M4A/MP4/WebM in 8-MiB-Abschnitten über die Abschnittsstrecke senden.
// Die Datei bleibt beim Nutzer; nichts wird im Browser zwischengespeichert. Fortsetzen = dieselbe Datei erneut wählen.
// Integrität (Review R1): Vor dem ersten Abschnitt wird ein Fingerabdruck (SHA-256 je Abschnitt + Manifest) gespeichert.
// Fortsetzen prüft die neu gewählte Datei vollständig dagegen, und jeder Abschnitt wird direkt vor dem Senden
// erneut gegen das Manifest geprüft. Auf dem Server landen so nur Bytes der ursprünglich geprüften Datei.
import { Ban, Check, CircleAlert, FileAudio, Folder, Play, RotateCw, ShieldCheck, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useBlocker, useSearchParams } from "react-router";
import { Button, buttonClass, EmptyState, ErrorState, PageSpinner } from "../../components";
import { api, ApiError, type Capabilities, type Project, type Usage } from "../../lib/api";
import { formatBytes, formatDateTime } from "../../lib/format";
import { useKonto } from "../../lib/sitzung";
import {
  ABSCHNITT_BYTES, ACCEPT, abschnittAnzahl, abschnittBereich, abschnittHash, fingerabdruck, gleicherHash, medienTyp,
  offeneLesen, offenMerken, offenVergessen, pruefungMoeglich, titelAusDatei, ungueltigeVerwerfen, WARTEN_MS, wiederholbar,
  type OffenerUpload,
} from "./logik";
import "./hochladen.css";

type Phase = "senden" | "wartet" | "abschluss" | "fertig" | "abgebrochen" | "fehler";
interface Lauf {
  file: File; trackId: string; projectId: string; title: string; durationMs: number;
  /** Vollständig geprüftes Manifest (SHA-256 je Abschnitt) der ursprünglichen Datei. */
  hashes: Uint8Array[];
  total: number; done: number; phase: Phase; fehler?: unknown; versuch?: number; serverStatus?: string;
  /** Fortsetzen nach Neuladen nicht möglich (Browser-Speicher nicht beschreibbar). */
  ohneMerken?: boolean;
}
/** Laufende Inhaltsprüfung (Fingerabdruck) – vor jedem Senden. */
interface Pruefung { titel: string; name: string; done: number; total: number }
/** Besitz-/Statusprüfung eines lokalen Eintrags am Server (R3). */
type Besitz = { s: "pruefe" } | { s: "ok"; received: number } | { s: "fremd" } | { s: "fehler" };

/** Spurart und Dauer aus den Metadaten im Browser (nichts verlässt das Gerät). Unbekannt → null/0. */
function pruefen(file: File): Promise<{ hatVideo: boolean | null; durationMs: number }> {
  return new Promise((res) => {
    const el = document.createElement("video");
    const url = URL.createObjectURL(file);
    const ende = (v: { hatVideo: boolean | null; durationMs: number }) => {
      clearTimeout(t); el.removeAttribute("src"); el.load(); URL.revokeObjectURL(url); res(v);
    };
    const t = setTimeout(() => ende({ hatVideo: null, durationMs: 0 }), 8000);
    el.preload = "metadata"; el.muted = true;
    el.onloadedmetadata = () => ende({
      hatVideo: el.videoWidth > 0,
      durationMs: Number.isFinite(el.duration) ? Math.min(604_800_000, Math.round(el.duration * 1000)) : 0,
    });
    el.onerror = () => ende({ hatVideo: null, durationMs: 0 });
    el.src = url;
  });
}

const warten = (ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); rej(new ApiError(0, "aborted", "Abgebrochen.")); }, { once: true });
});

function fehlerText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Unerwarteter Fehler.";
  const d = e.details as Record<string, unknown>;
  switch (e.code) {
    case "quota_exceeded":
      return `Speicher-Kontingent reicht nicht: benötigt ${formatBytes(Number(d.requested))}, belegt ${formatBytes(Number(d.used))} von ${formatBytes(Number(d.limit))}.`;
    case "too_large": return "Der Server nimmt nicht mehr Daten an, als beim Start angemeldet wurden. Ist es dieselbe, unveränderte Datei?";
    case "unsupported_media": return "Dieses Format nimmt der Server nicht an.";
    case "chunks_missing": return "Auf dem Server fehlen Abschnitte. „Fortsetzen“ sendet sie erneut.";
    case "content_changed": return "Die Datei hat sich seit der Prüfung verändert. Dieser Abschnitt wurde nicht gesendet; bereits gesendete Abschnitte stammen aus der geprüften Datei.";
    default: return e.message;
  }
}

export function HochladenSeite() {
  const konto = useKonto();
  const [params] = useSearchParams();
  const [projekte, setProjekte] = useState<Project[] | null>(null);
  const [cap, setCap] = useState<Capabilities | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [ladeFehler, setLadeFehler] = useState<unknown>(null);
  const [lokal, setLokal] = useState(() => offeneLesen(konto.id));
  const offene = lokal.liste;
  const neuLesen = useCallback(() => setLokal(offeneLesen(konto.id)), [konto.id]);
  useEffect(() => { neuLesen(); }, [neuLesen]); // Kontowechsel: nur eigener Schlüssel
  const [besitz, setBesitz] = useState<Record<string, Besitz>>({});
  const [pruefNonce, setPruefNonce] = useState(0);
  const [lauf, setLauf] = useState<Lauf | null>(null);
  const [pruefung, setPruefung] = useState<Pruefung | null>(null);
  const [vorwahl, setVorwahl] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // R3: Lokale Einträge erst nach Besitzprüfung am Server als fortsetzbar zeigen (fremd/gelöscht → 404).
  const offeneIds = offene.map((o) => o.trackId).join(",");
  useEffect(() => {
    const ids = offeneIds ? offeneIds.split(",") : [];
    const ac = new AbortController();
    setBesitz(Object.fromEntries(ids.map((id) => [id, { s: "pruefe" } as Besitz])));
    for (const id of ids) {
      api.getTrack(id, ac.signal).then((t) => {
        if (t.status !== "uploading") { offenVergessen(konto.id, id); neuLesen(); return; } // eigener, schon abgeschlossener Upload
        setBesitz((b) => ({ ...b, [id]: { s: "ok", received: t.receivedChunks } }));
      }, (e) => {
        if (ac.signal.aborted) return;
        setBesitz((b) => ({ ...b, [id]: e instanceof ApiError && (e.status === 404 || e.status === 403) ? { s: "fremd" } : { s: "fehler" } }));
      });
    }
    return () => ac.abort();
  }, [offeneIds, konto.id, neuLesen, pruefNonce]);

  const laden = useCallback(async () => {
    setLadeFehler(null);
    try {
      const [p, c] = await Promise.all([api.listProjects(), api.capabilities()]);
      setProjekte(p); setCap(c);
      api.usage().then(setUsage, () => setUsage(null));
    } catch (e) { setLadeFehler(e); }
  }, []);
  useEffect(() => { void laden(); }, [laden]);
  useEffect(() => () => ctrl.current?.abort(), []);

  const aktiv = !!pruefung || lauf?.phase === "senden" || lauf?.phase === "wartet" || lauf?.phase === "abschluss";
  const blocker = useBlocker(aktiv);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm("Upload läuft. Seite verlassen? Der Upload wird angehalten und lässt sich mit derselben Datei fortsetzen.")) {
      ctrl.current?.abort(); blocker.proceed();
    } else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    if (!aktiv) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [aktiv]);

  const vergessen = (trackId: string) => { offenVergessen(konto.id, trackId); neuLesen(); };

  /** Fingerabdruck mit sichtbarem Fortschritt; abbrechbar. Wirft ApiError „aborted“ bei Abbruch. */
  const pruefeDatei = useCallback(async (file: File, titel: string) => {
    const ac = new AbortController();
    ctrl.current = ac;
    setPruefung({ titel, name: file.name, done: 0, total: abschnittAnzahl(file.size) });
    try {
      return await fingerabdruck(file, ac.signal, (done, total) => setPruefung((p) => p && { ...p, done, total }));
    } finally {
      if (ctrl.current === ac) ctrl.current = null;
      setPruefung(null);
    }
  }, []);

  /** Sendet ab dem ersten Abschnitt, den der Server noch nicht lückenlos hat, und schließt ab. */
  const uebertragen = useCallback(async (basis: Omit<Lauf, "total" | "done" | "phase">) => {
    const ac = new AbortController();
    ctrl.current = ac;
    const total = abschnittAnzahl(basis.file.size);
    const setze = (p: Partial<Lauf>) => setLauf((l) => ({ ...(l ?? { ...basis, total, done: 0, phase: "senden" }), ...p }));
    setLauf({ ...basis, total, done: 0, phase: "senden" });
    try {
      const t0 = await api.getTrack(basis.trackId, ac.signal);
      if (t0.status !== "uploading") {
        offenVergessen(konto.id, basis.trackId); neuLesen();
        setze({ phase: "fertig", done: total, serverStatus: t0.status });
        return;
      }
      if (basis.hashes.length !== total) throw new ApiError(0, "content_changed", "Manifest passt nicht zur Datei.");
      let i = Math.min(t0.receivedChunks, total);
      setze({ done: i });
      while (i < total) {
        const [a, b] = abschnittBereich(i, basis.file.size);
        // Genau die geprüften Bytes senden: Abschnitt lesen, gegen Manifest prüfen, dann diesen Puffer senden.
        const buf = await basis.file.slice(a, b).arrayBuffer();
        if (!gleicherHash(await abschnittHash(buf), basis.hashes[i])) throw new ApiError(0, "content_changed", "Datei verändert.");
        const blob = new Blob([buf]);
        for (let v = 0; ; v++) {
          try { await api.putChunk(basis.trackId, i, blob, ac.signal); break; }
          catch (e) {
            if (!wiederholbar(e) || v >= WARTEN_MS.length) throw e;
            setze({ phase: "wartet", versuch: v + 1, fehler: e });
            await warten(WARTEN_MS[v], ac.signal);
            setze({ phase: "senden" });
          }
        }
        i++;
        setze({ done: i, phase: "senden", versuch: undefined, fehler: undefined });
      }
      setze({ phase: "abschluss" });
      const t = await api.finalizeTrack(basis.trackId, { chunkCount: total, durationMs: basis.durationMs }, ac.signal);
      offenVergessen(konto.id, basis.trackId); neuLesen();
      setze({ phase: "fertig", serverStatus: t.status });
    } catch (e) {
      // Dateilesefehler (z. B. Datei inzwischen verändert/entfernt) ist kein ApiError → ehrlicher Stopp, nichts gesendet.
      setze(e instanceof ApiError && e.code === "aborted" ? { phase: "abgebrochen" }
        : { phase: "fehler", fehler: e instanceof ApiError ? e : new ApiError(0, "content_changed", "Datei nicht lesbar.") });
    } finally {
      if (ctrl.current === ac) ctrl.current = null;
      api.usage().then(setUsage, () => {});
    }
  }, [konto.id, neuLesen]);

  if (ladeFehler) return <div className="page"><ErrorState title="Hochladen konnte nicht vorbereitet werden" error={ladeFehler} onRetry={laden} /></div>;
  if (!projekte || !cap) return <div className="page"><PageSpinner label="Wird geladen …" /></div>;

  return (
    <div className="page hochladen">
      <div className="page__head"><h1>Hochladen</h1></div>
      <p className="hochladen__einleitung u-muted">
        Vorhandene MP3-, WAV-, M4A-, MP4- oder WebM-Dateien in ein Projekt übernehmen. Die Datei wird in Abschnitten von 8 MiB gesendet;
        bei Unterbrechung lässt sich mit derselben Datei an der letzten vom Server bestätigten Stelle fortsetzen.
        Die Datei auf deinem Gerät bleibt unverändert – vollständig auf dem Server liegt sie erst, wenn das Projekt „Bereit“ zeigt.
      </p>

      {pruefung && <PruefAnzeige p={pruefung} abbrechen={() => ctrl.current?.abort()} />}
      {/* Formular bleibt während der Prüfung montiert (Auswahl + Abbruchmeldung gehen nicht verloren). */}
      <div hidden={!!pruefung}>
      {lauf
        ? <Fortschritt lauf={lauf} abbrechen={() => ctrl.current?.abort()}
            fortsetzen={() => uebertragen(lauf)} neu={() => setLauf(null)} />
        : projekte.length === 0
        ? <EmptyState icon={Folder} title="Noch kein Projekt" text="Lege zuerst ein Projekt an; Uploads landen immer in einem Projekt."
            action={<Link to="/projekte" className={buttonClass("primary")}>Zu den Projekten</Link>} />
        : <Formular key={vorwahl ?? ""} projekte={projekte} cap={cap} usage={usage} vorwahl={vorwahl ?? params.get("projekt")}
            starten={async (f) => {
              // Fingerabdruck VOR dem Anlegen: Abbruch hier hinterlässt keine Spur.
              const fp = await pruefeDatei(f.file, f.title);
              const { recording, track } = await api.createRecording(f.projectId, {
                title: f.title, kind: f.kind, mimeType: f.mimeType, participantName: f.participantName,
                startedAtMs: null, source: "upload", declaredBytes: f.file.size,
              });
              const gemerkt = offenMerken(konto.id, { trackId: track.id, projectId: f.projectId, title: recording.title, name: f.file.name,
                size: f.file.size, lastModified: f.file.lastModified, createdAt: recording.createdAt,
                fingerprint: fp.fingerprint, chunkCount: fp.hashes.length });
              neuLesen();
              void uebertragen({ file: f.file, trackId: track.id, projectId: f.projectId, title: recording.title, durationMs: f.durationMs,
                hashes: fp.hashes, ohneMerken: !gemerkt });
            }} />}
      </div>

      {lokal.ungueltig > 0 && !aktiv && (
        <p className="hochladen__hinweis" role="status">
          {lokal.ungueltig === 1 ? "Ein beschädigter Eintrag" : `${lokal.ungueltig} beschädigte Einträge`} in der lokalen Liste unterbrochener Uploads
          {" "}wird ignoriert.{" "}
          <Button size="sm" variant="ghost" onClick={() => { ungueltigeVerwerfen(konto.id); neuLesen(); }}>Verwerfen</Button>
        </p>
      )}

      {/* Während Prüfung/Senden nur versteckt: Zeilen bleiben montiert, Prüfergebnis geht nicht verloren. */}
      {offene.filter((o) => o.trackId !== lauf?.trackId).length > 0 && (
        <section className="hochladen__offen" aria-labelledby="hochladen-offen-titel" hidden={aktiv}>
          <h2 id="hochladen-offen-titel">Unterbrochene Uploads</h2>
          <p className="u-muted">Wähle dieselbe Datei erneut, um fortzusetzen. Ihr Inhalt wird vorher vollständig mit der begonnenen Datei verglichen.
            Die angefangene Spur bleibt sonst als „Unvollständig“ im Projekt; Löschen ist derzeit nicht möglich.</p>
          <ul>
            {offene.filter((o) => o.trackId !== lauf?.trackId).map((o) => (
              <OffenZeile key={o.trackId} o={o} besitz={besitz[o.trackId] ?? { s: "pruefe" }}
                projekt={projekte.find((p) => p.id === o.projectId)?.title}
                fortsetzen={async (file) => {
                  // R1: vollständige Inhaltsprüfung gegen den gespeicherten Fingerabdruck, bevor irgendetwas gesendet wird.
                  const fp = await pruefeDatei(file, o.title);
                  if (fp.fingerprint !== o.fingerprint) return false;
                  const { durationMs } = await pruefen(file);
                  void uebertragen({ file, trackId: o.trackId, projectId: o.projectId, title: o.title, durationMs, hashes: fp.hashes });
                  return true;
                }}
                neuHochladen={() => { setVorwahl(o.projectId); window.scrollTo({ top: 0 }); }}
                erneutPruefen={() => setPruefNonce((n) => n + 1)}
                vergessen={() => vergessen(o.trackId)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface Auswahl { file: File; projectId: string; title: string; participantName: string; mimeType: string; kind: "audio" | "video"; durationMs: number }

function Formular({ projekte, cap, usage, vorwahl, starten }: {
  projekte: Project[]; cap: Capabilities; usage: Usage | null; vorwahl: string | null; starten: (a: Auswahl) => Promise<void>;
}) {
  const konto = useKonto();
  const [projectId, setProjectId] = useState(projekte.some((p) => p.id === vorwahl) ? vorwahl! : projekte[0].id);
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<{ mimeType: string; kind: "audio" | "video"; durationMs: number } | null | "pruefe">(null);
  const [title, setTitle] = useState("");
  const [name, setName] = useState(konto.displayName);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<unknown>(null);

  const waehlen = async (f: File | null) => {
    setFile(f); setFehler(null); setInfo(f ? "pruefe" : null);
    if (!f) return;
    setTitle(titelAusDatei(f.name));
    const p = await pruefen(f);
    const typ = medienTyp(f.name, f.type, p.hatVideo, cap.upload.mimeTypes);
    setInfo(typ ? { ...typ, durationMs: p.durationMs } : null);
  };

  const s = usage?.storageBytes;
  const frei = s && s.limit != null ? Math.max(0, s.limit - s.used) : null;
  const zuGross = file ? file.size > cap.upload.maxBytes : false;
  const keinPlatz = file && frei != null ? file.size > frei : false;
  const typ = info && info !== "pruefe" ? info : null;
  const sicher = pruefungMoeglich();
  const ok = sicher && !!file && !!typ && !zuGross && !keinPlatz && title.trim().length > 0 && name.trim().length > 0 && !busy;

  const absenden = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || !file || !typ) return;
    setBusy(true); setFehler(null);
    try { await starten({ file, projectId, title: title.trim(), participantName: name.trim(), ...typ }); }
    catch (err) {
      setFehler(err instanceof ApiError && err.code === "aborted" ? new ApiError(0, "aborted", "Prüfung abgebrochen – es wurde nichts angelegt oder gesendet.") : err);
      setBusy(false);
    }
  };

  return (
    <form className="hochladen__form" onSubmit={absenden}>
      <label className="hochladen__label" htmlFor="hochladen-projekt">Projekt</label>
      <select id="hochladen-projekt" className="field" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={busy}>
        {projekte.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
      </select>

      <label className="hochladen__label" htmlFor="hochladen-datei">Datei</label>
      <input id="hochladen-datei" className="field hochladen__datei" type="file" accept={ACCEPT} disabled={busy}
        onChange={(e) => void waehlen(e.target.files?.[0] ?? null)} aria-describedby="hochladen-datei-info" />
      <p id="hochladen-datei-info" className="hochladen__info" role={file && (!typ && info !== "pruefe" || zuGross || keinPlatz) ? "alert" : undefined}>
        {!file ? `MP3, WAV, M4A, MP4 oder WebM, höchstens ${formatBytes(cap.upload.maxBytes)}.${frei != null ? ` Freies Speicherkontingent: ${formatBytes(frei)}.` : ""}`
          : info === "pruefe" ? "Datei wird geprüft …"
          : !typ ? "Dieses Dateiformat wird nicht unterstützt."
          : zuGross ? `Zu groß: ${formatBytes(file.size)}, erlaubt sind ${formatBytes(cap.upload.maxBytes)}.`
          : keinPlatz ? `Speicherkontingent reicht nicht: ${formatBytes(file.size)} nötig, ${formatBytes(frei)} frei.`
          : `${typ.kind === "video" ? "Video" : "Ton"} · ${typ.mimeType} · ${formatBytes(file.size)} · ${abschnittAnzahl(file.size)} Abschnitt(e)`}
      </p>

      <label className="hochladen__label" htmlFor="hochladen-titel">Titel der Aufnahme</label>
      <input id="hochladen-titel" className="field" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} disabled={busy} />

      <label className="hochladen__label" htmlFor="hochladen-name">Sprecher (Teilnehmername der Spur)</label>
      <input id="hochladen-name" className="field" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} disabled={busy} />

      {!sicher && <ErrorState compact title="Hochladen nicht möglich" message="Die Inhaltsprüfung (SHA-256) braucht eine sichere Verbindung. Öffne das Studio über die HTTPS-Adresse." />}
      {fehler ? <ErrorState compact title="Upload konnte nicht starten" message={fehlerText(fehler)} error={fehler} /> : null}
      <div><Button type="submit" variant="primary" icon={Upload} disabled={!ok}>{busy ? "Wird angelegt …" : "Hochladen"}</Button></div>
    </form>
  );
}

function Fortschritt({ lauf: l, abbrechen, fortsetzen, neu }: { lauf: Lauf; abbrechen: () => void; fortsetzen: () => void; neu: () => void }) {
  const prozent = Math.round((l.done / l.total) * 100);
  const gesendet = Math.min(l.file.size, l.done * ABSCHNITT_BYTES);
  const text: Record<Phase, string> = {
    senden: `Sendet Abschnitt ${Math.min(l.done + 1, l.total)} von ${l.total} …`,
    wartet: `Verbindungsproblem – neuer Versuch ${l.versuch} von ${WARTEN_MS.length} …`,
    abschluss: "Alle Abschnitte gesendet – Server wird zum Abschluss aufgefordert …",
    fertig: l.serverStatus === "ready" ? "Fertig verarbeitet." : l.serverStatus === "failed" ? "Der Server konnte die Datei nicht verarbeiten." : "Übertragen. Der Server verarbeitet die Datei jetzt.",
    abgebrochen: `Angehalten nach ${l.done} von ${l.total} Abschnitten.`,
    fehler: "Upload gestoppt.",
  };
  return (
    <section className="hochladen__lauf" aria-labelledby="hochladen-lauf-titel">
      <div className="hochladen__lauf-kopf">
        <FileAudio size={20} aria-hidden />
        <h2 id="hochladen-lauf-titel">{l.title} <span className="u-muted">· {l.file.name}</span></h2>
      </div>
      <progress className="hochladen__balken" max={l.total} value={l.done} aria-label="Upload-Fortschritt" />
      <p className="hochladen__status" role="status">
        {l.phase === "fertig" ? <Check size={16} aria-hidden /> : l.phase === "fehler" ? <CircleAlert size={16} aria-hidden /> : null}
        {text[l.phase]} <span className="u-muted u-mono">{prozent} % · {formatBytes(gesendet)} von {formatBytes(l.file.size)}</span>
      </p>
      {l.ohneMerken && l.phase !== "fertig" && <p className="hochladen__hinweis" role="status">Der Browser-Speicher ist nicht beschreibbar: Nach Neuladen lässt sich dieser Upload nicht fortsetzen.</p>}
      {l.phase === "abgebrochen" && <p className="u-muted">Bereits bestätigte Abschnitte bleiben auf dem Server. Die Spur erscheint bis zum Abschluss als „Unvollständig“ im Projekt.</p>}
      {l.phase === "fehler" && <ErrorState compact title="Upload gestoppt" message={fehlerText(l.fehler)} error={l.fehler} />}
      <div className="hochladen__aktionen">
        {(l.phase === "senden" || l.phase === "wartet") && <Button icon={Ban} onClick={abbrechen}>Abbrechen</Button>}
        {(l.phase === "abgebrochen" || l.phase === "fehler") && <Button variant="primary" icon={Play} onClick={fortsetzen}>Fortsetzen</Button>}
        {(l.phase === "fertig" || l.phase === "abgebrochen" || l.phase === "fehler") && <>
          <Link className={buttonClass("secondary")} to={`/projekte/${l.projectId}`}>Zum Projekt</Link>
          <Button variant="ghost" onClick={neu}>Weitere Datei</Button>
        </>}
      </div>
    </section>
  );
}

function PruefAnzeige({ p, abbrechen }: { p: Pruefung; abbrechen: () => void }) {
  return (
    <section className="hochladen__lauf" aria-labelledby="hochladen-pruef-titel">
      <div className="hochladen__lauf-kopf">
        <ShieldCheck size={20} aria-hidden />
        <h2 id="hochladen-pruef-titel">{p.titel} <span className="u-muted">· {p.name}</span></h2>
      </div>
      <progress className="hochladen__balken" max={p.total} value={p.done} aria-label="Fortschritt der Dateiprüfung" />
      <p className="hochladen__status" role="status">
        Datei wird geprüft (Prüfsumme) – Abschnitt {p.done} von {p.total}. Dabei wird nichts gesendet.
      </p>
      <div className="hochladen__aktionen"><Button icon={Ban} onClick={abbrechen}>Prüfung abbrechen</Button></div>
    </section>
  );
}

function OffenZeile({ o, besitz, projekt, fortsetzen, neuHochladen, erneutPruefen, vergessen }: {
  o: OffenerUpload; besitz: Besitz; projekt?: string; fortsetzen: (f: File) => Promise<boolean>;
  neuHochladen: () => void; erneutPruefen: () => void; vergessen: () => void;
}) {
  const [fehler, setFehler] = useState<string | null>(null);
  const id = `hochladen-offen-${o.trackId}`;
  const entfernen = <Button size="sm" variant="ghost" onClick={vergessen} title="Nur aus dieser Liste entfernen; am Server wird nichts gelöscht">Aus Liste entfernen</Button>;
  // Titel/Dateiname stammen aus dem lokalen Speicher → erst nach bestätigtem Besitz anzeigen (R3).
  if (besitz.s !== "ok") return (
    <li className="hochladen__offen-zeile">
      <div className="u-muted">
        {besitz.s === "pruefe" ? "Eintrag wird am Server geprüft …"
          : besitz.s === "fremd" ? "Unbekannte Spur: gehört nicht zu diesem Konto oder existiert nicht mehr. Nicht fortsetzbar."
          : "Server nicht erreichbar – Eintrag konnte nicht geprüft werden."}
      </div>
      {besitz.s === "fehler" && <Button size="sm" variant="secondary" icon={RotateCw} onClick={erneutPruefen}>Erneut prüfen</Button>}
      {besitz.s !== "pruefe" && entfernen}
    </li>
  );
  const kopf = (
    <div>
      <strong>{o.title}</strong>
      <span className="u-muted"> · {projekt ?? "Projekt"} · {o.name} · {formatBytes(o.size)} · {besitz.received} von {o.chunkCount} Abschnitten · begonnen {formatDateTime(o.createdAt)}</span>
    </div>
  );
  if (!o.fingerprint) return (
    <li className="hochladen__offen-zeile">
      {kopf}
      <p className="hochladen__hinweis" role="status">
        Begonnen ohne Inhaltsprüfung (ältere Version): Fortsetzen ist nicht sicher möglich, weil nicht feststellbar ist, ob eine gewählte Datei
        dieselben Bytes enthält. Lade die Datei neu hoch; die angefangene Spur bleibt als „Unvollständig“ im Projekt und wird nicht gelöscht.
      </p>
      <Button size="sm" variant="secondary" icon={Upload} onClick={neuHochladen}>Neu hochladen</Button>
      {entfernen}
    </li>
  );
  const sicher = pruefungMoeglich();
  return (
    <li className="hochladen__offen-zeile">
      {kopf}
      <label className={buttonClass("secondary", "sm") + (sicher ? "" : " is-disabled")} htmlFor={id} aria-disabled={!sicher}><Play size={16} aria-hidden />Datei wählen und fortsetzen</label>
      <input id={id} className="u-sr-only" type="file" accept={ACCEPT} disabled={!sicher}
        onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = "";
          if (!f) return;
          if (f.size !== o.size) { setFehler(`Das ist nicht dieselbe Datei (erwartet ${o.name}, ${formatBytes(o.size)}). Nichts gesendet.`); return; }
          setFehler(null);
          try {
            if (!await fortsetzen(f)) setFehler(`Inhalt stimmt nicht mit der begonnenen Datei überein (Prüfsumme verschieden). Nichts gesendet.`);
          } catch (err) {
            setFehler(err instanceof ApiError && err.code === "aborted" ? "Prüfung abgebrochen. Nichts gesendet." : "Datei konnte nicht gelesen werden. Nichts gesendet.");
          }
        }} />
      {entfernen}
      {!sicher && <p className="hochladen__fehler" role="alert">Inhaltsprüfung braucht eine sichere Verbindung (HTTPS).</p>}
      {fehler && <p className="hochladen__fehler" role="alert">{fehler}</p>}
    </li>
  );
}
