// Routenplätze /projekte, /projekte/:projektId, /projekte/:projektId/exporte – Besitzer AP5.
import { ChevronDown, Folder, LayoutGrid, List, Plus, SearchX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, buttonClass, EmptyState, ErrorState, PageSpinner } from "../../components";
import { api, type Project } from "../../lib/api";
import { formatDate, formatDateTime, plural } from "../../lib/format";
import { filterSort, type Sortierung } from "./logik";
import { TitelDialog } from "./TitelDialog";
import "./projekte.css";

export { ProjektSeite } from "./Detail";
export { TranskriptSeite } from "./Transkript";

/** /projekte – Suchbegriff der Kopfzeile kommt als ?q= an; Sortierung/Ansicht ebenfalls in der URL. */
export function ProjekteSeite() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get("q") ?? "";
  const sort: Sortierung = params.get("sort") === "name" ? "name" : "erstellt";
  const ansicht = params.get("ansicht") === "liste" ? "liste" : "karten";
  const [list, setList] = useState<Project[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [neu, setNeu] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setList(await api.listProjects()); } catch (e) { setError(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setParam = (k: string, v: string | null) => setParams((p) => {
    if (v === null) p.delete(k); else p.set(k, v);
    return p;
  }, { replace: true });

  const shown = list ? filterSort(list, q, sort) : [];

  let body;
  if (error && !list) body = <ErrorState title="Projekte konnten nicht geladen werden" error={error} onRetry={load} />;
  else if (!list) body = <PageSpinner label="Projekte werden geladen …" />;
  else if (!list.length) body = (
    <EmptyState icon={Folder} title="Noch keine Projekte" text="Ein Projekt sammelt die Aufnahmen einer Folge oder Serie."
      action={<Button variant="primary" icon={Plus} onClick={() => setNeu(true)}>Neues Projekt</Button>} />
  );
  else if (!shown.length) body = (
    <EmptyState icon={SearchX} title={`Keine Projekte zu „${q.trim()}“`} text="Die Suche prüft Projekt- und Aufnahmetitel."
      action={<Link to="/projekte" className={buttonClass("secondary")}>Suche zurücksetzen</Link>} />
  );
  else body = (
    <ul className={`projekte-${ansicht}`} aria-label="Projekte">
      {shown.map((p) => (
        <li key={p.id}>
          <Link to={`/projekte/${p.id}`} className={`projekte-${ansicht}__eintrag`}>
            <span className="projekte-kachel" aria-hidden><Folder size={ansicht === "karten" ? 32 : 20} /></span>
            <span className="projekte-eintrag__text">
              <span className="projekte-eintrag__titel">{p.title}</span>
              <span className="projekte-eintrag__meta">
                Erstellt am {formatDate(p.createdAt)} · {plural(p.recordingCount, "Aufnahme", "Aufnahmen")}
                {p.lastRecordingAt && ansicht === "liste" && <> · zuletzt {formatDateTime(p.lastRecordingAt)}</>}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="page">
      <div className="page__head">
        <h1>{q.trim() ? <>Projekte <span className="u-muted projekte-suchtitel">· „{q.trim()}“</span></> : "Projekte"}</h1>
        <label className="projekte-sort">
          <span className="u-sr-only">Sortierung</span>
          <select value={sort} onChange={(e) => setParam("sort", e.target.value === "name" ? "name" : null)}>
            <option value="erstellt">Zuletzt erstellt</option>
            <option value="name">Name</option>
          </select>
          <ChevronDown size={16} aria-hidden />
        </label>
        <div className="projekte-ansicht" role="group" aria-label="Ansicht">
          <Button iconOnly icon={List} variant="ghost" aria-label="Liste" aria-pressed={ansicht === "liste"}
            onClick={() => setParam("ansicht", "liste")} />
          <Button iconOnly icon={LayoutGrid} variant="ghost" aria-label="Karten" aria-pressed={ansicht === "karten"}
            onClick={() => setParam("ansicht", null)} />
        </div>
        <Button variant="primary" icon={Plus} onClick={() => setNeu(true)}>Neu</Button>
      </div>
      {error && list ? <ErrorState compact title="Aktualisierung fehlgeschlagen" error={error} onRetry={load} /> : null}
      {body}
      {neu && (
        <TitelDialog heading="Neues Projekt" submitLabel="Anlegen" onClose={() => setNeu(false)}
          onSave={async (title) => { const p = await api.createProject(title); navigate(`/projekte/${p.id}`); }} />
      )}
    </div>
  );
}
