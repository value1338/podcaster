// /projekte/:projektId/transkript/:trackId (PA8): Player, Segmente (Klick spult), Bearbeiten mit Revision, Zurücksetzen, TXT/SRT/VTT.
import { ChevronRight, Download, FileText, Pencil, RotateCcw, Save, X } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useBlocker, useParams } from "react-router";
import { Badge, Button, buttonClass, EmptyState, ErrorState, PageSpinner } from "../../components";
import { api, ApiError, type ProjectDetail, type Recording, type Track, type Transcript, type TranscriptSegment } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { exportGenauigkeit, istSimuliert, patchSegmente, segmentBei, zeitmarke } from "./transkript";

type Daten = { projekt: ProjectDetail; rec: Recording; track: Track };

export function TranskriptSeite() {
  const { projektId = "", trackId = "" } = useParams();
  const [daten, setDaten] = useState<Daten | null>(null);
  const [tr, setTr] = useState<Transcript | null>(null);
  const [fehler, setFehler] = useState<unknown>(null);

  const laden = useCallback(async () => {
    setFehler(null);
    try {
      const projekt = await api.getProject(projektId);
      const rec = projekt.recordings.find((r) => r.tracks.some((t) => t.id === trackId));
      const track = rec?.tracks.find((t) => t.id === trackId);
      if (!rec || !track) throw new ApiError(404, "not_found", "Spur nicht gefunden.");
      setDaten({ projekt, rec, track });
      setTr(await api.getTranscript(trackId));
    } catch (e) { setFehler(e); }
  }, [projektId, trackId]);
  useEffect(() => { void laden(); }, [laden]);

  const zurueck = <Link to={`/projekte/${projektId}`} className={buttonClass("secondary")}>Zum Projekt</Link>;
  if (fehler instanceof ApiError && (fehler.code === "no_transcript" || fehler.status === 404)) return (
    <div className="page">
      <EmptyState icon={FileText} title={fehler.code === "no_transcript" ? "Noch kein Transkript" : "Spur nicht gefunden"}
        text={fehler.code === "no_transcript" ? "Für diese Spur liegt kein Transkript vor. Starte die Transkription in der Spurzeile des Projekts." : "Die Spur existiert nicht (mehr) oder der Link ist falsch."}
        action={zurueck} />
    </div>
  );
  if (fehler) return <div className="page"><ErrorState title="Transkript konnte nicht geladen werden" error={fehler} onRetry={laden} /></div>;
  if (!daten || !tr) return <div className="page"><PageSpinner label="Transkript wird geladen …" /></div>;
  return <Ansicht daten={daten} tr={tr} setTr={setTr} />;
}

function Ansicht({ daten: { projekt, rec, track }, tr, setTr }: { daten: Daten; tr: Transcript; setTr: (t: Transcript) => void }) {
  const media = useRef<HTMLMediaElement | null>(null);
  const liste = useRef<HTMLOListElement>(null);
  const aktiv = useRef(-1);
  const aenderungen = useRef(new Map<string, string>());
  const [anzahl, setAnzahl] = useState(0);
  const [bearbeiten, setBearbeiten] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<unknown>(null);
  const [konflikt, setKonflikt] = useState<number | null>(null);
  const [zuruecksetzen, setZuruecksetzen] = useState(false);
  const [mediaFehler, setMediaFehler] = useState(false);
  const segs = tr.segments;

  // Hervorhebung direkt am DOM: kein React-Render pro timeupdate (900 Segmente bleiben flüssig).
  const markieren = useCallback((i: number) => {
    if (i === aktiv.current || !liste.current) return;
    const kinder = liste.current.children;
    kinder[aktiv.current]?.classList.remove("is-aktiv");
    kinder[aktiv.current]?.removeAttribute("aria-current");
    kinder[i]?.classList.add("is-aktiv");
    kinder[i]?.setAttribute("aria-current", "true");
    aktiv.current = i;
  }, []);
  const onZeit = useCallback(() => {
    if (media.current) markieren(segmentBei(segs, media.current.currentTime * 1000));
  }, [segs, markieren]);
  const springen = useCallback((ms: number) => {
    const m = media.current;
    if (!m) return;
    m.currentTime = ms / 1000;
    void m.play().catch(() => { /* Autoplay-Sperre: Position stimmt trotzdem */ });
    markieren(segmentBei(segs, ms));
  }, [segs, markieren]);
  const aendern = useCallback((id: string, text: string, original: string) => {
    if (text === original) aenderungen.current.delete(id); else aenderungen.current.set(id, text);
    setAnzahl(aenderungen.current.size);
  }, []);

  const ungespeichert = anzahl > 0;
  const blocker = useBlocker(ungespeichert);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm(`${anzahl} ungespeicherte Änderung(en) verwerfen?`)) blocker.proceed(); else blocker.reset();
  }, [blocker, anzahl]);
  useEffect(() => {
    if (!ungespeichert) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [ungespeichert]);

  const uebernehmen = (t: Transcript) => {
    aenderungen.current.clear(); setAnzahl(0); setKonflikt(null); setTr(t); aktiv.current = -1;
  };
  const speichern = async (revision = tr.revision) => {
    setBusy(true); setFehler(null);
    try { uebernehmen(await api.saveTranscript(track.id, { revision, segments: patchSegmente(segs, aenderungen.current) })); setBearbeiten(false); }
    catch (e) {
      if (e instanceof ApiError && e.code === "revision_conflict") setKonflikt(Number(e.details.revision));
      else setFehler(e);
    } finally { setBusy(false); }
  };
  const neuLaden = async () => {
    setBusy(true); setFehler(null);
    try { uebernehmen(await api.getTranscript(track.id)); setBearbeiten(false); } catch (e) { setFehler(e); } finally { setBusy(false); }
  };
  const maschinenfassung = async () => {
    setBusy(true); setFehler(null);
    try { uebernehmen(await api.resetTranscript(track.id, tr.revision)); setZuruecksetzen(false); setBearbeiten(false); }
    catch (e) {
      if (e instanceof ApiError && e.code === "revision_conflict") { setKonflikt(Number(e.details.revision)); setZuruecksetzen(false); }
      else setFehler(e);
    } finally { setBusy(false); }
  };

  const genau = exportGenauigkeit(tr);
  const src = api.trackFileUrl(track.id);
  const mediaProps = {
    controls: true, preload: "metadata" as const, src, onTimeUpdate: onZeit, onSeeked: onZeit,
    onError: () => setMediaFehler(true), "aria-label": `Wiedergabe: ${rec.title} · ${track.participantName}`,
  };

  return (
    <div className="page projekte-detail projekte-tr">
      <div className="page__head">
        <nav className="projekte-brotkrumen" aria-label="Brotkrumen">
          <Link to="/projekte">Projekte</Link>
          <ChevronRight size={18} aria-hidden />
          <Link to={`/projekte/${projekt.id}?aufnahme=${rec.id}`}>{projekt.title}</Link>
          <ChevronRight size={18} aria-hidden />
          <h1 aria-current="page">Transkript</h1>
        </nav>
      </div>

      <div className="projekte-tr__kopf">
        <div>
          <h2>{rec.title} · {track.participantName}</h2>
          <p className="u-muted">
            {[tr.language ? `Sprache ${tr.language}` : "Sprache automatisch", `Modell ${tr.model}`, `Gerät ${tr.device}`,
              `${segs.length} Segmente`, `Stand ${formatDateTime(tr.updatedAt)}`].join(" · ")}
          </p>
          <p className="u-muted">Keine Sprechertrennung: Als Sprecher gilt der Teilnehmername der Spur; mehrere Personen an einem Mikrofon werden nicht unterschieden.</p>
        </div>
        <div className="projekte-tr__marken">
          {istSimuliert(tr.model) && <Badge tone="warn">Simuliert · Testtreiber, kein echtes Transkript</Badge>}
          {tr.edited && <Badge tone="accent">Bearbeitet</Badge>}
        </div>
      </div>

      <div className="projekte-player projekte-tr__player">
        {track.kind === "video"
          ? <video ref={(el) => { media.current = el; }} playsInline {...mediaProps} />
          : <audio ref={(el) => { media.current = el; }} {...mediaProps} />}
        {mediaFehler && <p className="projekte-player__fehler" role="alert">Die Datei konnte nicht geladen werden – Springen im Transkript ist dann nicht möglich.</p>}
      </div>

      <div className="projekte-tr__leiste">
        {!bearbeiten
          ? <Button icon={Pencil} onClick={() => setBearbeiten(true)}>Text bearbeiten</Button>
          : <>
            <Button variant="primary" icon={Save} onClick={() => speichern()} disabled={busy || !ungespeichert}>
              {busy ? "Wird gespeichert …" : `Speichern${ungespeichert ? ` (${anzahl})` : ""}`}
            </Button>
            <Button variant="ghost" icon={X} disabled={busy}
              onClick={() => { if (!ungespeichert || window.confirm("Änderungen verwerfen?")) { uebernehmen(tr); setBearbeiten(false); } }}>
              Verwerfen
            </Button>
          </>}
        {tr.edited && !zuruecksetzen && <Button variant="ghost" icon={RotateCcw} onClick={() => setZuruecksetzen(true)} disabled={busy}>Maschinenfassung wiederherstellen</Button>}
        <span className="projekte-tr__downloads">
          <a className={buttonClass("secondary", "sm")} href={api.transcriptFileUrl(track.id, "txt")} download><Download size={16} aria-hidden />TXT</a>
          {genau.untertitel && <>
            <a className={buttonClass("secondary", "sm")} href={api.transcriptFileUrl(track.id, "srt")} download><Download size={16} aria-hidden />SRT</a>
            <a className={buttonClass("secondary", "sm")} href={api.transcriptFileUrl(track.id, "vtt")} download><Download size={16} aria-hidden />VTT</a>
          </>}
        </span>
      </div>
      <p className="projekte-transkript__hinweis">{genau.text}{ungespeichert ? " Downloads enthalten den zuletzt gespeicherten Stand." : ""}</p>

      {zuruecksetzen && (
        <div className="projekte-bergung__frage" role="alert">
          <p>Alle Textbearbeitungen dieses Transkripts werden durch die Maschinenfassung ersetzt.{ungespeichert ? " Auch ungespeicherte Änderungen gehen verloren." : ""}</p>
          <Button size="sm" variant="danger" onClick={maschinenfassung} disabled={busy}>Ja, zurücksetzen</Button>
          <Button size="sm" variant="ghost" onClick={() => setZuruecksetzen(false)} disabled={busy}>Abbrechen</Button>
        </div>
      )}
      {konflikt != null && (
        <div className="projekte-bergung__frage" role="alert">
          <p>Das Transkript wurde inzwischen anderswo geändert (Stand {konflikt}, deiner {tr.revision}). Deine {anzahl} Änderung(en) sind noch nicht gespeichert.</p>
          <Button size="sm" onClick={neuLaden} disabled={busy}>Neu laden (meine Änderungen verwerfen)</Button>
          {ungespeichert && <Button size="sm" variant="danger" onClick={() => speichern(konflikt)} disabled={busy}>Meine Fassung trotzdem speichern</Button>}
        </div>
      )}
      {fehler ? <ErrorState compact title="Aktion fehlgeschlagen" error={fehler} /> : null}

      <ol className="projekte-tr__liste" ref={liste} aria-label="Transkriptsegmente" key={tr.revision}>
        {segs.map((s) => <Segment key={s.id} s={s} bearbeiten={bearbeiten} onSpringen={springen} onAendern={aendern} />)}
      </ol>
    </div>
  );
}

const Segment = memo(function Segment({ s, bearbeiten, onSpringen, onAendern }: {
  s: TranscriptSegment; bearbeiten: boolean; onSpringen: (ms: number) => void; onAendern: (id: string, text: string, original: string) => void;
}) {
  return (
    <li className="projekte-tr__segment" data-start={s.startMs}>
      <button type="button" className="projekte-tr__zeit u-mono" onClick={() => onSpringen(s.startMs)} aria-label={`Zu ${zeitmarke(s.startMs)} springen`}>
        {zeitmarke(s.startMs)}
      </button>
      {bearbeiten
        ? <textarea className="field projekte-tr__feld" defaultValue={s.text} maxLength={2000} rows={2} aria-label={`Text ab ${zeitmarke(s.startMs)}`}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onAendern(s.id, e.target.value, s.text)} />
        : <button type="button" className="projekte-tr__text" onClick={() => onSpringen(s.startMs)}>
            {s.text || <span className="u-muted">(leer – wird in Exporten übersprungen)</span>}
          </button>}
      {s.edited && <span className="projekte-tr__bearbeitet" title="Bearbeitet">bearbeitet</span>}
    </li>
  );
});
