// /studio und /studio/:projektId – Besitzer AP4. Läuft ohne Shell (wie Referenz 02).
import { ArrowLeft, FolderOpen, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Button, buttonClass, ErrorState, PageSpinner, Spinner } from "../../components";
import { api, ApiError, type Project, type ProjectDetail } from "../../lib/api";
import { formatDateTime, plural } from "../../lib/format";
import { leseVorgabe } from "../start/agenten";
import { StudioRahmen } from "./Rahmen";
import { Studioraum } from "./Studioraum";
import "./Studio.css";

/** /studio – Projekt wählen oder neu anlegen, dann Weiterleitung. */
export function StudioEinstieg() {
  const navigate = useNavigate();
  const [projekte, setProjekte] = useState<Project[] | null>(null);
  const [ladeFehler, setLadeFehler] = useState<unknown>(null);
  const [titel, setTitel] = useState("");
  const [anlegen, setAnlegen] = useState<{ laeuft: boolean; fehler: unknown }>({ laeuft: false, fehler: null });

  const laden = useCallback(() => {
    setLadeFehler(null);
    setProjekte(null);
    api.listProjects().then(setProjekte, setLadeFehler);
  }, []);
  useEffect(laden, [laden]);

  async function neu(e: FormEvent) {
    e.preventDefault();
    const t = titel.trim();
    if (!t) return;
    setAnlegen({ laeuft: true, fehler: null });
    try {
      const p = await api.createProject(t);
      navigate(`/studio/${p.id}`);
    } catch (err) {
      setAnlegen({ laeuft: false, fehler: err });
    }
  }

  const sortiert = projekte && [...projekte].sort((a, b) => (b.lastRecordingAt ?? b.createdAt).localeCompare(a.lastRecordingAt ?? a.createdAt));

  return (
    <StudioRahmen kontext="Aufnehmen" ende={<Link to="/" className={buttonClass("ghost", "sm")}><ArrowLeft size={16} aria-hidden />Zur Startseite</Link>}>
      <main className="studio-einstieg">
        <h1>Wofür nimmst du auf?</h1>
        <p className="u-muted">Jede Aufnahme gehört zu einem Projekt.</p>

        {ladeFehler != null ? (
          <ErrorState title="Projekte konnten nicht geladen werden" error={ladeFehler} onRetry={laden} compact />
        ) : !sortiert ? (
          <PageSpinner label="Projekte werden geladen …" />
        ) : sortiert.length > 0 ? (
          <section aria-labelledby="studio-projekte">
            <h2 id="studio-projekte" className="studio-einstieg__titel">Vorhandenes Projekt</h2>
            <ul className="studio-einstieg__liste">
              {sortiert.map((p) => (
                <li key={p.id}>
                  <Link to={`/studio/${p.id}`} className="studio-einstieg__projekt">
                    <FolderOpen size={20} aria-hidden />
                    <span className="studio-einstieg__projekt-name">{p.title}</span>
                    <span className="u-muted studio-einstieg__projekt-info">
                      {plural(p.recordingCount, "Aufnahme", "Aufnahmen")}
                      {p.lastRecordingAt && ` · zuletzt ${formatDateTime(p.lastRecordingAt)}`}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="studio-hinweis">Noch keine Projekte – lege direkt eins an.</p>
        )}

        <form className="studio-einstieg__neu" onSubmit={neu}>
          <label htmlFor="studio-neu" className="studio-einstieg__titel">Neues Projekt</label>
          <div className="studio-einstieg__zeile">
            <input id="studio-neu" className="field" value={titel} maxLength={120} required placeholder="z. B. Folge 12"
              onChange={(e) => setTitel(e.target.value)} disabled={anlegen.laeuft} />
            <Button type="submit" variant="primary" icon={Plus} disabled={anlegen.laeuft || !titel.trim()}>
              {anlegen.laeuft ? "Wird angelegt …" : "Anlegen & aufnehmen"}
            </Button>
          </div>
          {anlegen.laeuft && <Spinner label="Projekt wird angelegt …" />}
          {anlegen.fehler != null && <ErrorState title="Projekt konnte nicht angelegt werden" error={anlegen.fehler} compact />}
        </form>
      </main>
    </StudioRahmen>
  );
}

/** /studio/:projektId – Warteraum → Aufnahme → Abschluss.
 *  Optional vorbereitet (Producer, Startseite): ?titel=…&name=…, Brief über history state. */
export function StudioSeite() {
  const { projektId = "" } = useParams();
  const [suche] = useSearchParams();
  const { state } = useLocation();
  const [vorgabe] = useState(() => leseVorgabe(suche, state)); // nur beim Einstieg; spätere URL-Änderungen ignorieren
  const [projekt, setProjekt] = useState<ProjectDetail | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [fehler, setFehler] = useState<unknown>(null);

  // PA7: die Engine nimmt für genau dieses Konto auf (TrackMeta.userId, Sprecher, Reauth-Prüfung).
  const laden = useCallback(() => {
    setFehler(null);
    setProjekt(null);
    Promise.all([api.getProject(projektId), api.session()]).then(([p, si]) => {
      if (!si.user) throw new ApiError(401, "unauthenticated", "Bitte anmelden.");
      setUserId(si.user.id);
      setProjekt(p);
    }).catch(setFehler);
  }, [projektId]);
  useEffect(laden, [laden]);

  if (fehler != null) {
    const nichtGefunden = fehler instanceof ApiError && fehler.status === 404;
    return (
      <StudioRahmen ende={<Link to="/studio" className={buttonClass("ghost", "sm")}><ArrowLeft size={16} aria-hidden />Projekt wählen</Link>}>
        <main className="studio-einstieg">
          {nichtGefunden ? (
            <ErrorState title="Projekt nicht gefunden" message="Dieses Projekt gibt es nicht (mehr). Wähle ein anderes Projekt." error={fehler}
              actions={<Link to="/studio" className={buttonClass("primary")}>Projekt wählen</Link>} />
          ) : (
            <ErrorState title="Projekt konnte nicht geladen werden" error={fehler} onRetry={laden} />
          )}
        </main>
      </StudioRahmen>
    );
  }
  if (!projekt || !userId) {
    return <StudioRahmen><PageSpinner label="Studio wird vorbereitet …" /></StudioRahmen>;
  }
  return <Studioraum key={userId} projekt={projekt} userId={userId} vorgabe={vorgabe} />;
}

