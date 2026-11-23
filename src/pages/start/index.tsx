// Routenplatz / – Besitzer AP6. Begrüßung, Agentenleiste, Schnellaktionen, Wiederherstellung, „Zuletzt aufgenommen“ aus echten Daten.
import { AudioLines, CircleDot, History, Mic, Scissors, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Badge, buttonClass, EmptyState, ErrorState, PageSpinner } from "../../components";
import { api, type Recording } from "../../lib/api";
import { formatDateTime, formatDuration } from "../../lib/format";
import { aufnahmeDauer, aufnahmeZustand, SPUR_TEXT, SPUR_TON } from "../projekte/logik";
import { Agenten } from "./Agenten";
import { Wiederherstellen } from "./Wiederherstellen";
import "./start.css";

const ANZAHL = 6;
/** ponytail: N+1-Abfragen (Liste + bis zu 6 Projektdetails). Bei vielen Projekten: Server-Endpunkt „letzte Aufnahmen“. */
const MAX_PROJEKTE = ANZAHL;

type Eintrag = Recording & { projectTitle: string };

async function ladeZuletzt(): Promise<Eintrag[]> {
  const projekte = (await api.listProjects())
    .filter((p) => p.lastRecordingAt)
    .sort((a, b) => b.lastRecordingAt!.localeCompare(a.lastRecordingAt!))
    .slice(0, MAX_PROJEKTE);
  const details = await Promise.all(projekte.map((p) => api.getProject(p.id)));
  return details
    .flatMap((d) => d.recordings.map((r) => ({ ...r, projectTitle: d.title })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, ANZAHL);
}

export function StartSeite() {
  const [liste, setListe] = useState<Eintrag[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setListe(await ladeZuletzt()); } catch (e) { setError(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="page start">
      <h1 className="start-gruss">Was nimmst du heute auf?</h1>

      <Wiederherstellen />

      <Agenten />

      <ul className="start-aktionen" aria-label="Schnellaktionen">
        <li>
          <Link to="/studio" className="start-aktion">
            <span className="start-aktion__icon start-aktion__icon--rec" aria-hidden><CircleDot size={22} /></span>
            <span className="start-aktion__text"><span className="start-aktion__titel">Aufnehmen</span><span className="start-aktion__hint">Neue Aufnahme starten</span></span>
          </Link>
        </li>
        {[{ icon: Upload, titel: "Hochladen", hint: "Mit einer Datei beginnen" }, { icon: Scissors, titel: "Bearbeiten", hint: "Aufnahmen schneiden" }].map((a) => (
          <li key={a.titel}>
            <div className="start-aktion" aria-disabled="true">
              <span className="start-aktion__icon" aria-hidden><a.icon size={22} /></span>
              <span className="start-aktion__text">
                <span className="start-aktion__titel">{a.titel} <Badge tone="spaeter">Später</Badge></span>
                <span className="start-aktion__hint">{a.hint}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>

      <section aria-labelledby="start-zuletzt-titel" className="start-zuletzt">
        <div className="start-zuletzt__kopf">
          <h2 id="start-zuletzt-titel">Zuletzt aufgenommen</h2>
          {liste?.length ? <Link to="/projekte" className={buttonClass("ghost", "sm")}>Alle Projekte</Link> : null}
        </div>
        {error ? <ErrorState title="Aufnahmen konnten nicht geladen werden" error={error} onRetry={load} />
          : !liste ? <PageSpinner label="Aufnahmen werden geladen …" />
          : !liste.length ? (
            <EmptyState icon={History} title="Noch keine Aufnahme" text="Deine Aufnahmen erscheinen hier, sobald du im Studio aufgenommen hast."
              action={<Link to="/studio" className={buttonClass("primary")}><Mic size={18} aria-hidden />Aufnehmen</Link>} />
          ) : (
            <ul className="start-karten">
              {liste.map((r) => {
                const z = aufnahmeZustand(r);
                return (
                  <li key={r.id}>
                    <Link to={`/projekte/${r.projectId}?aufnahme=${encodeURIComponent(r.id)}`} className="start-karte">
                      <span className="start-karte__bild" aria-hidden>
                        <AudioLines size={32} />
                        <span className="start-karte__dauer u-mono">{formatDuration(aufnahmeDauer(r))}</span>
                      </span>
                      <span className="start-karte__titel">{r.title}</span>
                      <span className="start-karte__meta">{r.projectTitle} · {formatDateTime(r.createdAt)}</span>
                      {z && z !== "bereit" && <Badge tone={SPUR_TON[z]}>{SPUR_TEXT[z]}</Badge>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
      </section>
    </div>
  );
}
