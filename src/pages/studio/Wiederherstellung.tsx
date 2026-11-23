// Wiederherstellung unterbrochener Aufnahmen dieses Projekts (Scope §7 „wiederherstellung“). Besitzer AP4.
import { History, RotateCw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, buttonClass, ErrorState, Spinner } from "../../components";
import { api, ApiError, type Track } from "../../lib/api";
import { formatDateTime, plural } from "../../lib/format";
import { discardPending, listPending, resumePending, type PendingRecording } from "../../lib/recorder";

type Lauf =
  | { art: "frage" }
  | { art: "laeuft"; done: number; total: number }
  | { art: "fehler"; fehler: unknown }
  | { art: "verwerfen?" }
  | { art: "erledigt"; track: Track };

/** Nur Aufnahmen des Kontos `userId` (PA7): fremde lokale Einträge werden weder gezeigt noch gelöscht. */
export function Wiederherstellung({ projectId, userId, onSchliessen }: { projectId: string; userId: string; onSchliessen(): void }) {
  const [liste, setListe] = useState<PendingRecording[] | null>(null);
  const [lesefehler, setLesefehler] = useState<unknown>(null);
  const [lauf, setLauf] = useState<Lauf>({ art: "frage" });

  const laden = useCallback(() => {
    setLesefehler(null);
    listPending(userId, api).then((l) => setListe(l.filter((p) => p.projectId === projectId)), setLesefehler);
  }, [projectId, userId]);
  useEffect(laden, [laden]);

  if (lesefehler != null) {
    return <ErrorState compact title="Lokale Sicherung nicht lesbar" message="Unterbrochene Aufnahmen konnten nicht geprüft werden." error={lesefehler} onRetry={laden} />;
  }
  const p = liste?.[0];
  if (!p && lauf.art !== "erledigt") return null;

  async function hochladen(allowPartial = false) {
    setLauf({ art: "laeuft", done: 0, total: 0 });
    try {
      const track = await resumePending(p!.trackId, userId, api, (done, total) => setLauf({ art: "laeuft", done, total }), { allowPartial });
      setLauf({ art: "erledigt", track });
    } catch (e) {
      setLauf({ art: "fehler", fehler: e });
    }
  }
  async function verwerfen() {
    try { await discardPending(p!.trackId, userId, api); setLauf({ art: "frage" }); laden(); }
    catch (e) { setLauf({ art: "fehler", fehler: e }); }
  }

  if (lauf.art === "erledigt") {
    return (
      <section className="studio-wieder" aria-label="Wiederherstellung">
        <p className="studio-wieder__titel"><History size={18} aria-hidden />Unterbrochene Aufnahme übertragen</p>
        <p className="studio-klein u-muted">
          {lauf.track.status === "ready" ? "Sie ist auf dem Server fertig verarbeitet." : "Der Server verarbeitet sie jetzt; das Ergebnis erscheint im Projekt."}
        </p>
        <div className="studio-aktionen">
          <Link to={`/projekte/${projectId}`} className={buttonClass("secondary", "sm")}>Zum Projekt</Link>
          <Button size="sm" variant="ghost" onClick={() => { setLauf({ art: "frage" }); laden(); }}>OK</Button>
        </div>
      </section>
    );
  }

  const fehler = lauf.art === "fehler" ? lauf.fehler : null;
  const fehlend = fehler instanceof ApiError && fehler.code === "chunks_missing";
  const keineDaten = fehler instanceof ApiError && (fehler.code === "keine_daten" || fehler.code === "lokal_nicht_gefunden");

  return (
    <section className="studio-wieder" aria-label="Wiederherstellung">
      <p className="studio-wieder__titel"><History size={18} aria-hidden />Unterbrochene Aufnahme vom {formatDateTime(new Date(p!.startedAtMs).toISOString())} gefunden</p>
      <p className="studio-klein u-muted">
        „{p!.title}“ · {plural(p!.localChunks, "Abschnitt", "Abschnitte")} nur in diesem Browser gesichert, {p!.chunkCount} insgesamt.
        {liste!.length > 1 && ` Weitere unterbrochene Aufnahmen: ${liste!.length - 1}.`}
      </p>
      {p!.nichtLokal > 0 && (
        <p className="studio-klein">
          {plural(p!.nichtLokal, "Abschnitt", "Abschnitte")} konnten bei der Aufnahme nicht im Browser gesichert werden.
          Hat der Server sie nicht mehr erhalten, fehlen sie; die Wiederherstellung meldet das dann, statt still unvollständig abzuschließen.
        </p>
      )}

      {lauf.art === "laeuft" && (
        <Spinner visible label={lauf.total ? `${lauf.done}/${lauf.total} Abschnitte übertragen …` : "Stand des Servers wird geprüft …"} />
      )}
      {fehler != null && (
        <ErrorState compact title={fehlend ? "Abschnitte fehlen" : "Wiederherstellung nicht abgeschlossen"} error={fehler}
          message={fehlend ? "Einige Abschnitte liegen weder lokal noch auf dem Server. Du kannst den lückenlosen Anfang sichern – alles danach fehlt." : undefined} />
      )}

      {lauf.art === "verwerfen?" ? (
        <div className="studio-frage" role="group" aria-label="Rückfrage">
          <p>Lokale Abschnitte endgültig löschen? Was der Server schon hat, bleibt dort als unvollständige Spur liegen.</p>
          <div className="studio-aktionen">
            <Button size="sm" variant="danger" icon={Trash2} onClick={() => void verwerfen()}>Ja, verwerfen</Button>
            <Button size="sm" onClick={() => setLauf({ art: "frage" })}>Abbrechen</Button>
          </div>
        </div>
      ) : lauf.art !== "laeuft" && (
        <div className="studio-aktionen">
          {!keineDaten && (
            <Button size="sm" variant="secondary" icon={fehler ? RotateCw : Upload} onClick={() => void hochladen()}>
              {fehler ? "Erneut versuchen" : "Hochladen & abschließen"}
            </Button>
          )}
          {fehlend && <Button size="sm" variant="secondary" onClick={() => void hochladen(true)}>Nur lückenlosen Anfang sichern</Button>}
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setLauf({ art: "verwerfen?" })}>Verwerfen …</Button>
          <Button size="sm" variant="ghost" onClick={onSchliessen}>Später</Button>
        </div>
      )}
    </section>
  );
}
