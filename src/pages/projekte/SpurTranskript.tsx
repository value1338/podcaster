// Transkriptstatus und -aktionen in der Spurzeile (PA8). Echte Daten nur über api.ts; ohne Dienst „Einrichtung fehlt“.
import { Ban, Check, CircleAlert, Clock, FileText, Play, RotateCw, Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Badge, Button, buttonClass, Spinner } from "../../components";
import { api, ApiError, type Capabilities, type Job, type Track, type Usage } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import {
  asrRest, asrSekunden, fehlerText, istSimuliert, minuten, neuerSchluessel, startFehlerText, transkriptZustand,
  ZUSTAND_TEXT, type TranskriptZustand,
} from "./transkript";

const POLL_MS = 2000;

export function SpurTranskript({ track: t, projektId, asr, usage, reload }: {
  track: Track; projektId: string; asr: Capabilities["asr"] | null; usage: Usage | null; reload: () => Promise<void>;
}) {
  const jobId = t.transcription?.jobId ?? null;
  const st = t.transcription?.status ?? "none";
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neuNoetig, setNeuNoetig] = useState(false);
  const [abbruch, setAbbruch] = useState(false);
  const [frage, setFrage] = useState<null | "neu" | "ersetzen">(null);
  // Ein Schlüssel je Absicht: bleibt bei Netzfehlern erhalten (Server liefert denselben Auftrag), sonst neu.
  const schluessel = useRef<string | null>(null);
  // R4: Pollfehler sichtbar machen (Stand der letzten erfolgreichen Abfrage), Wiederholung läuft weiter.
  const [pollFehler, setPollFehler] = useState(false);
  const [stand, setStand] = useState<string | null>(null);
  const [pollNonce, setPollNonce] = useState(0);

  // Auftrag nachladen; pollen, solange er läuft. Endet er, einmal das Projekt neu laden.
  useEffect(() => {
    if (!jobId || st === "none") { setJob(null); setPollFehler(false); return; }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const j = await api.getJob(jobId);
        if (stop) return;
        setJob(j); setPollFehler(false); setStand(new Date().toISOString());
        if (j.status === "queued" || j.status === "running") timer = setTimeout(tick, POLL_MS);
        else if (st === "queued" || st === "running") { setAbbruch(false); void reload(); }
      } catch {
        if (stop) return;
        setPollFehler(true);
        timer = setTimeout(tick, POLL_MS * 5); // Netzfehler: langsamer weiter, Anzeige bleibt (als veraltet markiert)
      }
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [jobId, st, reload, pollNonce]);

  const sek = asrSekunden(t.durationMs);
  const rest = asrRest(usage);
  const reicht = rest == null || rest >= sek;
  let z: TranskriptZustand = transkriptZustand(t, job, asr);
  if (abbruch && (z === "laeuft" || z === "eingereiht" || z === "wartet")) z = "abbruch";
  const dienstBereit = !asr || asr.state === "ready";

  const ausfuehren = async (fn: () => Promise<unknown>) => {
    setBusy(true); setFehler(null);
    try { await fn(); await reload(); }
    catch (e) {
      if (e instanceof ApiError && e.code === "transcript_edited") setFrage("ersetzen");
      else if (e instanceof ApiError && e.code === "new_job_required") setNeuNoetig(true);
      setFehler(startFehlerText(e));
    } finally { setBusy(false); }
  };

  const starten = (replaceEdited = false) => ausfuehren(async () => {
    setFrage(null);
    schluessel.current ??= neuerSchluessel();
    try {
      await api.startTranscription(t.id, { language: null, replaceEdited }, schluessel.current);
      schluessel.current = null; setNeuNoetig(false);
    } catch (e) {
      if (!(e instanceof ApiError && e.isNetwork)) schluessel.current = null;
      throw e;
    }
  });
  const erneut = () => jobId && ausfuehren(() => api.retryJob(jobId));
  const abbrechen = () => jobId && ausfuehren(async () => {
    const j = await api.cancelJob(jobId);
    setJob(j);
    if (j.status === "running") setAbbruch(true);
  });

  const icon: Record<TranskriptZustand, ReactNode> = {
    einrichtung: <Settings2 size={16} aria-hidden />, nicht_erreichbar: <CircleAlert size={16} aria-hidden />,
    keins: <FileText size={16} aria-hidden />, eingereiht: <Clock size={16} aria-hidden />, wartet: <Clock size={16} aria-hidden />,
    laeuft: <Spinner size={16} label="Transkription läuft" />, abbruch: <Spinner size={16} label="Abbruch angefordert" />,
    fehlgeschlagen: <CircleAlert size={16} aria-hidden />, abgebrochen: <Ban size={16} aria-hidden />, fertig: <Check size={16} aria-hidden />,
  };
  const detail =
    z === "einrichtung" ? (asr?.missing.length ? `fehlt: ${asr.missing.join(", ")}` : null)
    : z === "laeuft" ? (job?.progress ? `Fenster ${job.progress.done}/${job.progress.total}` : "wird vorbereitet")
    : z === "wartet" ? `nächster Versuch ${formatDateTime(job?.nextAttemptAt)} · ${fehlerText(job?.errorCode ?? null)}`
    : z === "fehlgeschlagen" ? (job ? fehlerText(job.errorCode) : null)
    : z === "fertig" ? [t.transcription?.edited ? "bearbeitet" : null, t.transcription?.updatedAt ? formatDateTime(t.transcription.updatedAt) : null].filter(Boolean).join(" · ") || null
    : null;

  const kosten = `≈ ${minuten(sek)} Min.`;
  const kontingent = rest == null ? (usage ? "Kontingent unbegrenzt." : null) : `Verbleibend: ${minuten(rest)} Min. diesen Monat.`;

  return (
    <div className="projekte-transkript" role="group" aria-label={`Transkript ${t.participantName}`}>
      <div className="projekte-transkript__zeile">
        <span className={`projekte-status projekte-status--tr-${z}`}>
          {icon[z]}<span>{ZUSTAND_TEXT[z]}</span>{detail && <span className="projekte-status__detail">· {detail}</span>}
        </span>
        {istSimuliert(asr?.model) && <Badge tone="warn">Simuliert · Testtreiber</Badge>}
        <div className="projekte-transkript__aktionen">
          {z === "keins" && (
            <Button size="sm" icon={FileText} onClick={() => starten()} disabled={busy || !reicht || sek === 0}
              title={reicht ? undefined : "Kontingent reicht nicht"}>
              Transkribieren ({kosten})
            </Button>
          )}
          {(z === "einrichtung" || z === "nicht_erreichbar") && (
            <Button size="sm" icon={FileText} disabled title={ZUSTAND_TEXT[z]}>Transkribieren</Button>
          )}
          {(z === "eingereiht" || z === "wartet" || z === "laeuft") && (
            <Button size="sm" variant="ghost" icon={Ban} onClick={abbrechen} disabled={busy}>Abbrechen</Button>
          )}
          {z === "fehlgeschlagen" && !neuNoetig && (
            <Button size="sm" icon={RotateCw} onClick={erneut} disabled={busy || !dienstBereit}>Erneut</Button>
          )}
          {(z === "abgebrochen" || neuNoetig) && (
            <Button size="sm" icon={Play} onClick={() => starten()} disabled={busy || !dienstBereit || !reicht}>
              Als neuen Auftrag starten ({kosten})
            </Button>
          )}
          {z === "fertig" && (
            <>
              <Link className={buttonClass("secondary", "sm")} to={`/projekte/${projektId}/transkript/${t.id}`}>
                <FileText size={16} aria-hidden />Transkript öffnen
              </Link>
              <Button size="sm" variant="ghost" icon={RotateCw} onClick={() => setFrage("neu")} disabled={busy || !dienstBereit}>
                Neu transkribieren
              </Button>
            </>
          )}
        </div>
      </div>
      {/* job ist stets der letzte Auftrag (transcription.jobId). Kein Zeitvergleich mit updatedAt: im R7-Fall
          (Bearbeitung während des Auftrags) ist die Bearbeitung jünger als der gescheiterte Auftrag. */}
      {z === "fertig" && job?.id === jobId && (job.status === "failed" || job.status === "canceled") && (
        <p className="projekte-transkript__hinweis" role="status">
          Letzte Neu-Transkription {job.status === "canceled" ? "abgebrochen" : `fehlgeschlagen: ${fehlerText(job.errorCode)}`} Das bisherige Transkript ist unverändert.
        </p>
      )}
      {pollFehler && (
        <p className="projekte-transkript__hinweis" role="status">
          <CircleAlert size={14} aria-hidden /> Aktualisierung fehlgeschlagen – angezeigter Stand {stand ? `von ${formatDateTime(stand)}` : "ist nicht bestätigt"} und
          {" "}eventuell veraltet. Neuer Versuch läuft automatisch.{" "}
          <Button size="sm" variant="ghost" icon={RotateCw} onClick={() => setPollNonce((n) => n + 1)}>Jetzt aktualisieren</Button>
        </p>
      )}
      {z === "keins" && <p className="projekte-transkript__hinweis">Verbraucht {kosten} Transkriptionskontingent ({sek} s). {kontingent}</p>}

      {frage && (
        <div className="projekte-bergung__frage" role="alert">
          <p>
            {frage === "ersetzen"
              ? "Dieses Transkript wurde bearbeitet. Ein neuer Auftrag ersetzt deine Bearbeitungen, sobald er erfolgreich ist (scheitert er, bleibt alles wie es ist)."
              : `Neu transkribieren ist ein neuer Auftrag und verbraucht erneut ${kosten}.${t.transcription?.edited ? " Deine Bearbeitungen werden bei Erfolg ersetzt." : ""}`}
          </p>
          <Button size="sm" variant="danger" onClick={() => starten(frage === "ersetzen" || !!t.transcription?.edited)} disabled={busy || !reicht}>
            Ja, neu transkribieren
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFrage(null)} disabled={busy}>Abbrechen</Button>
        </div>
      )}
      {fehler && <p className="projekte-spur__fehlertext" role="alert">{fehler}</p>}
    </div>
  );
}
