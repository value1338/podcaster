// Reiter „Erstellt für Dich“ (PA9): Text-KI-Aufgaben aus Transkript/Brief, ehrliche Auftragszustände, Ergebnisliste/Detail.
// Ergebnisse werden nur als Text angezeigt (kein HTML/Markdown-Rendering), Download über die eigene API.
import { AudioLines, Copy, Download, FileText, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Badge, Button, buttonClass, EmptyState, ErrorState, Spinner } from "../../components";
import { KIAuftrag, KIJobStatus, useKiJob } from "../../components/KIAuftrag";
import { AUFGABEN, AUFGABEN_REIHE, formatZahl, zeitmarke, type KiEingabe, type KiJob } from "../../components/ki";
import { api, type Capabilities, type Generation, type LlmTask, type ProjectDetail, type Track } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { MAX_BRIEF } from "../start/agenten";

const istAufgabe = (s: string | null): s is LlmTask => !!s && (AUFGABEN_REIHE as string[]).includes(s);

export function Erstellt({ projekt, llm }: { projekt: ProjectDetail; llm: Capabilities["llm"] | null | undefined }) {
  const [params, setParams] = useSearchParams();
  const spuren = projekt.recordings.flatMap((r) => r.tracks.map((t) => ({ r, t }))).filter(({ t }) => t.transcription?.status === "ready");
  const [aufgabe, setAufgabe] = useState<LlmTask>(() => (istAufgabe(params.get("aufgabe")) ? (params.get("aufgabe") as LlmTask) : "shownotes"));
  const [spurId, setSpurId] = useState(() => params.get("spur") ?? "");
  const [brief, setBrief] = useState("");
  const [liste, setListe] = useState<Generation[] | null>(null);
  const [listeFehler, setListeFehler] = useState<unknown>(null);
  const [jobs, setJobs] = useState<KiJob[]>([]);

  const spur = spuren.find(({ t }) => t.id === spurId) ?? spuren[0];
  const ladeListe = useCallback(async () => {
    try { setListe(await api.listGenerations(projekt.id)); setListeFehler(null); } catch (e) { setListeFehler(e); }
  }, [projekt.id]);
  useEffect(() => { void ladeListe(); }, [ladeListe]);
  // Nur lesen: offene/fehlgeschlagene Aufträge nach Neuladen wieder sichtbar machen. Nichts wird neu gesendet.
  useEffect(() => {
    api.listJobs({ projectId: projekt.id }).then(
      (l) => setJobs((l as KiJob[]).filter((j) => j.kind === "llm" && j.status !== "succeeded").slice(0, 5)), () => {});
  }, [projekt.id]);

  const brauchtBrief = aufgabe === "producer_outline";
  const eingabe: KiEingabe | null = brauchtBrief
    ? (brief.trim() ? { task: aufgabe, brief: brief.trim() } : null)
    : (spur ? { task: aufgabe, trackId: spur.t.id } : null);
  const gesperrt = brauchtBrief
    ? (brief.trim() ? null : "Bitte einen Aufnahmebrief eingeben.")
    : (spur ? null : "Noch keine Spur mit fertigem Transkript – im Reiter Aufnahmen zuerst transkribieren.");

  const ergebnisId = params.get("ergebnis");
  const zeige = (id: string | null) => setParams((p) => { if (id) p.set("ergebnis", id); else p.delete("ergebnis"); return p; }, { replace: true });
  const neuerJob = (j: KiJob) => setJobs((alt) => [j, ...alt.filter((x) => x.id !== j.id)]);
  const jobEnde = (j: KiJob) => {
    if (j.status === "succeeded") {
      void ladeListe();
      setJobs((alt) => alt.filter((x) => x.id !== j.id));
      if (j.result?.generationId) zeige(j.result.generationId);
    }
  };

  return (
    <div className="projekte-erstellt">
      <section className="projekte-ki" aria-labelledby="projekte-ki-titel">
        <h2 id="projekte-ki-titel" className="projekte-abschnitt">Neu erstellen</h2>
        <div className="projekte-ki__felder">
          <label className="projekte-ki__feld">
            <span>Aufgabe</span>
            <select className="field" value={aufgabe} onChange={(e) => setAufgabe(e.target.value as LlmTask)}>
              {AUFGABEN_REIHE.map((a) => <option key={a} value={a}>{AUFGABEN[a].titel}</option>)}
            </select>
          </label>
          {!brauchtBrief && (
            <label className="projekte-ki__feld">
              <span>Quelle (Transkript)</span>
              <select className="field" value={spur?.t.id ?? ""} onChange={(e) => setSpurId(e.target.value)} disabled={!spuren.length}>
                {!spuren.length && <option value="">Kein fertiges Transkript</option>}
                {spuren.map(({ r, t }) => <option key={t.id} value={t.id}>{r.title} · {t.participantName}</option>)}
              </select>
            </label>
          )}
        </div>
        {brauchtBrief && (
          <label className="projekte-ki__feld">
            <span>Aufnahmebrief (1–{MAX_BRIEF} Zeichen)</span>
            <textarea className="field projekte-ki__brief" rows={4} maxLength={MAX_BRIEF} value={brief} onChange={(e) => setBrief(e.target.value)}
              placeholder="Thema, Gäste, Fragen, Reihenfolge …" />
          </label>
        )}
        <p className="projekte-transkript__hinweis">{AUFGABEN[aufgabe].text} Gesendet wird erst nach Prüfung und deiner Einwilligung.</p>
        <KIAuftrag projektId={projekt.id} eingabe={eingabe} llm={llm} gesperrt={gesperrt} knopf="Prüfen und erstellen" onJob={neuerJob} />
        {jobs.length > 0 && (
          <ul className="projekte-ki__jobs" aria-label="KI-Aufträge">
            {jobs.map((j) => <JobZeile key={j.id} start={j} onEnde={jobEnde} />)}
          </ul>
        )}
      </section>

      <section aria-labelledby="projekte-ergebnisse-titel">
        <h2 id="projekte-ergebnisse-titel" className="projekte-abschnitt">Ergebnisse</h2>
        {listeFehler && !liste ? <ErrorState compact title="Ergebnisse konnten nicht geladen werden" error={listeFehler} onRetry={ladeListe} />
          : !liste ? <Spinner label="Ergebnisse werden geladen …" />
          : !liste.length ? <EmptyState icon={Sparkles} title="Noch nichts erstellt" text="Erstellte Shownotes, Kapitel, Titel und Entwürfe erscheinen hier." />
          : (
            <div className="projekte-ergebnisse">
              <ul className="projekte-ergebnisse__liste" aria-label="Ergebnisse">
                {liste.map((g) => (
                  <li key={g.id}>
                    <button type="button" className="projekte-auswahl__eintrag" aria-current={g.id === ergebnisId || undefined} onClick={() => zeige(g.id)}>
                      <span className="projekte-auswahl__titel">{AUFGABEN[g.task]?.titel ?? g.task}</span>
                      <span className="projekte-auswahl__meta">
                        <span>{formatDateTime(g.createdAt)}</span>
                        <span>{spurName(projekt, g.trackId) ?? "Aufnahmebrief"}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {ergebnisId && <ErgebnisDetail key={ergebnisId} id={ergebnisId} projekt={projekt} vorhanden={liste.find((g) => g.id === ergebnisId) ?? null} />}
            </div>
          )}
      </section>
    </div>
  );
}

function JobZeile({ start, onEnde }: { start: KiJob; onEnde: (j: KiJob) => void }) {
  const [job, setJob] = useKiJob(start, onEnde);
  if (!job) return null;
  return <li className="projekte-ki__job"><span className="u-muted">{formatDateTime(job.createdAt)}</span><KIJobStatus job={job} onJob={setJob} /></li>;
}

function spurName(p: ProjectDetail, trackId: string | null): string | null {
  for (const r of p.recordings) for (const t of r.tracks) if (t.id === trackId) return `${r.title} · ${t.participantName}`;
  return null;
}
const findeSpur = (p: ProjectDetail, id: string | null): Track | null => p.recordings.flatMap((r) => r.tracks).find((t) => t.id === id) ?? null;

function ErgebnisDetail({ id, projekt, vorhanden }: { id: string; projekt: ProjectDetail; vorhanden: Generation | null }) {
  const [g, setG] = useState<Generation | null>(vorhanden);
  const [fehler, setFehler] = useState<unknown>(null);
  const [kopiert, setKopiert] = useState<string | null>(null);
  useEffect(() => { if (!vorhanden) api.getGeneration(id).then(setG, setFehler); }, [id, vorhanden]);
  if (fehler) return <ErrorState compact title="Ergebnis konnte nicht geladen werden" error={fehler} />;
  if (!g) return <Spinner label="Ergebnis wird geladen …" />;

  const kopieren = async () => {
    try { await navigator.clipboard.writeText(g.content); setKopiert("In die Zwischenablage kopiert."); }
    catch { setKopiert("Kopieren nicht möglich (Browser erlaubt es hier nicht) – bitte Text markieren."); }
  };
  const verbrauch = g.inputTokens != null && g.outputTokens != null
    ? `${formatZahl(g.inputTokens + g.outputTokens)} Token` : "Verbrauch nicht gemeldet";

  return (
    <article className="projekte-ergebnis" aria-labelledby="projekte-ergebnis-titel">
      <header className="projekte-ergebnis__kopf">
        <h3 id="projekte-ergebnis-titel">{AUFGABEN[g.task]?.titel ?? g.task}</h3>
        <Badge tone="accent">KI-Entwurf</Badge>
        {g.usageEstimated && <Badge tone="warn">Verbrauch geschätzt</Badge>}
        <p className="projekte-transkript__hinweis">
          {formatDateTime(g.createdAt)} · {spurName(projekt, g.trackId) ?? "aus Aufnahmebrief"} · {g.provider === "openai" ? "OpenAI" : g.provider} <span className="u-mono">{g.model}</span> · {verbrauch}
        </p>
        <div className="projekte-ergebnis__aktionen">
          <Button size="sm" icon={Copy} onClick={kopieren}>Kopieren</Button>
          <a className={buttonClass("secondary", "sm")} href={api.generationFileUrl(g.id)} download><Download size={16} aria-hidden />Textdatei herunterladen</a>
        </div>
        {kopiert && <p className="projekte-transkript__hinweis" role="status">{kopiert}</p>}
      </header>
      {g.data?.chapters?.length ? <Kapitel kapitel={g.data.chapters} track={findeSpur(projekt, g.trackId)} projektId={projekt.id} /> : null}
      <pre className="projekte-ergebnis__text">{g.content}</pre>
    </article>
  );
}

/** U13: Kapitel springen im eigenen Player der Quellspur (Range-Datei, kein Blob). */
function Kapitel({ kapitel, track, projektId }: { kapitel: { startMs: number; title: string }[]; track: Track | null; projektId: string }) {
  const media = useRef<HTMLMediaElement | null>(null);
  const abspielbar = !!track && track.status === "ready" && track.local !== false;
  const springe = (ms: number) => {
    const m = media.current;
    if (!m) return;
    m.currentTime = ms / 1000;
    void m.play().catch(() => {});
  };
  return (
    <div className="projekte-kapitel">
      {abspielbar && (track.kind === "video"
        ? <video ref={(e) => { media.current = e; }} controls preload="metadata" playsInline src={api.trackFileUrl(track.id)} aria-label="Wiedergabe der Quellspur" />
        : <div className="projekte-kapitel__audio"><AudioLines size={20} aria-hidden /><audio ref={(e) => { media.current = e; }} controls preload="metadata" src={api.trackFileUrl(track.id)} aria-label="Wiedergabe der Quellspur" /></div>)}
      {!abspielbar && <p className="projekte-transkript__hinweis">Quellspur derzeit nicht abspielbar (nicht lokal oder nicht bereit) – Springen nicht möglich.</p>}
      <ol className="projekte-kapitel__liste" aria-label="Kapitel">
        {kapitel.map((k) => (
          <li key={k.startMs}>
            <button type="button" className="projekte-kapitel__knopf" onClick={() => springe(k.startMs)} disabled={!abspielbar} data-start-ms={k.startMs}>
              <span className="u-mono">{zeitmarke(k.startMs)}</span><span>{k.title}</span>
            </button>
          </li>
        ))}
      </ol>
      {track && <Link className={buttonClass("ghost", "sm")} to={`/projekte/${projektId}/transkript/${track.id}`}><FileText size={16} aria-hidden />Transkript öffnen</Link>}
    </div>
  );
}
