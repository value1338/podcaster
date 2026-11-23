// Banner „Unterbrochene Aufnahme gefunden“ (Scope §7) über listPending/resumePending/discardPending.
import { RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, buttonClass, ErrorState } from "../../components";
import { api, type Track } from "../../lib/api";
import { plural } from "../../lib/format";
import { ladeWiederherstellung, type PendingRecording, type Wiederherstellung } from "./wiederherstellung";

export function Wiederherstellen() {
  const [w, setW] = useState<Wiederherstellung | null>(null);
  const [liste, setListe] = useState<PendingRecording[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let aktiv = true;
    (async () => {
      try {
        const m = await ladeWiederherstellung();
        if (!m || !aktiv) return;
        const l = await m.listPending();
        if (aktiv) { setW(m); setListe(l); }
      } catch (e) { if (aktiv) setError(e); }
    })();
    return () => { aktiv = false; };
  }, []);

  if (error) return <ErrorState compact title="Lokal gespeicherte Aufnahmen konnten nicht geprüft werden" error={error} />;
  if (!w || !liste.length) return null;
  return (
    <section className="start-banner" aria-label="Unterbrochene Aufnahmen">
      {liste.map((p) => <Eintrag key={p.trackId} p={p} w={w} entfernen={() => setListe((l) => l.filter((x) => x.trackId !== p.trackId))} />)}
    </section>
  );
}

type Zustand = { art: "offen" } | { art: "frage" } | { art: "laeuft"; done: number; total: number } | { art: "fertig"; track: Track } | { art: "fehler"; error: unknown };

function Eintrag({ p, w, entfernen }: { p: PendingRecording; w: Wiederherstellung; entfernen: () => void }) {
  const [z, setZ] = useState<Zustand>({ art: "offen" });
  const datum = new Date(p.startedAtMs).toLocaleString("de-DE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  const wiederherstellen = async () => {
    setZ({ art: "laeuft", done: 0, total: p.localChunks });
    try {
      const track = await w.resumePending(p.trackId, api, (done, total) => setZ({ art: "laeuft", done, total }));
      setZ({ art: "fertig", track });
    } catch (e) { setZ({ art: "fehler", error: e }); }
  };
  const verwerfen = async () => {
    try { await w.discardPending(p.trackId); entfernen(); } catch (e) { setZ({ art: "fehler", error: e }); }
  };

  const zuProjekt = (
    <Link to={`/projekte/${p.projectId}${z.art === "fertig" ? `?aufnahme=${encodeURIComponent(z.track.recordingId)}` : ""}`}
      className={buttonClass("secondary", "sm")}>Zum Projekt</Link>
  );

  return (
    <div className="start-banner__eintrag" role="status">
      <TriangleAlert size={20} aria-hidden className="start-banner__icon" />
      <div className="start-banner__text">
        <p className="start-banner__titel">Unterbrochene Aufnahme „{p.title}“ vom {datum} gefunden</p>
        <p className="start-banner__hint">
          {z.art === "laeuft" ? `Wird hochgeladen … ${z.done}/${z.total} Abschnitte`
            : z.art === "fertig" ? (z.track.status === "ready" ? "Wiederhergestellt und bereit." : "Wiederhergestellt – der Server verarbeitet die Aufnahme jetzt.")
            : z.art === "frage" ? `${plural(p.localChunks, "lokaler Abschnitt wird", "lokale Abschnitte werden")} endgültig gelöscht. Bereits hochgeladene Teile bleiben auf dem Server.`
            : `${plural(p.localChunks, "Abschnitt liegt", "Abschnitte liegen")} nur in diesem Browser und ${p.localChunks === 1 ? "ist" : "sind"} noch nicht gesichert.`}
        </p>
        {z.art === "laeuft" && z.total > 0 && <progress className="start-banner__fortschritt" max={z.total} value={z.done} aria-label="Fortschritt der Wiederherstellung" />}
        {z.art === "fehler" && <ErrorState compact title="Wiederherstellung fehlgeschlagen" error={z.error} message={z.error instanceof Error ? `${z.error.message} Die lokalen Abschnitte bleiben erhalten.` : undefined} />}
      </div>
      <div className="start-banner__aktionen">
        {z.art === "offen" || z.art === "fehler" ? <>
          <Button size="sm" variant="primary" icon={RotateCcw} onClick={wiederherstellen}>{z.art === "fehler" ? "Erneut versuchen" : "Wiederherstellen"}</Button>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setZ({ art: "frage" })}>Verwerfen</Button>
        </> : z.art === "frage" ? <>
          <Button size="sm" variant="danger" onClick={verwerfen}>Ja, verwerfen</Button>
          <Button size="sm" variant="ghost" onClick={() => setZ({ art: "offen" })}>Abbrechen</Button>
        </> : z.art === "fertig" ? zuProjekt : null}
      </div>
    </div>
  );
}
