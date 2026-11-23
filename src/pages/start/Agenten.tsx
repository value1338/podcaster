// Agentenleiste (Referenz 01): vier Rollen, Eingabefeld, Vorschlagschips.
// Echt: Producer › Aufnahme vorbereiten (Projekt, Episodentitel, Sprecher, Brief → vorbereitetes Studio).
// PA9: Producer › Aufnahme ausarbeiten und Marketer-Aufgaben nur bei capabilities.llm.ready, sonst sichtbar „Einrichtung fehlt“.
// Gesendet wird nur nach Prüfung + Einwilligung (KIAuftrag), nie beim Laden oder Rollenwechsel. Editor/Clipper bleiben TBD.
import { ArrowRight, ExternalLink, Info, Sparkles, Video } from "lucide-react";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Badge, Button, ErrorState, Spinner } from "../../components";
import { api, type Capabilities, type Project } from "../../lib/api";
import { KIAuftrag, KIJobStatus, useKiJob } from "../../components/KIAuftrag";
import type { KiJob } from "../../components/ki";
import { useKonto } from "../../lib/sitzung";
import { formatDateTime } from "../../lib/format";
import { Avatar } from "./Avatare";
import {
  erstelltZiel, faehigkeitStatus, MAX_BRIEF, MAX_TITEL, NEU, pruefe, ROLLEN, rolleTbd, studioZiel, type Faehigkeit, type Fehler, type RolleId,
} from "./agenten";

type Llm = Capabilities["llm"] | null | undefined;

const leseName = (userId: string) => { try { return localStorage.getItem(`podcast-studio:${userId}:sprecher`) ?? ""; } catch { return ""; } };

export function Agenten() {
  const [rolleId, setRolleId] = useState<RolleId>("producer");
  const rolle = ROLLEN.find((r) => r.id === rolleId)!;
  const id = useId();
  // Nur Fähigkeiten lesen (GET), kein KI-Aufruf. undefined = lädt, null = nicht ladbar.
  const [llm, setLlm] = useState<Llm>(undefined);
  useEffect(() => { api.capabilities().then((c) => setLlm(c.llm), () => setLlm(null)); }, []);

  return (
    <section className="start-agenten" aria-labelledby={`${id}-titel`}>
      <h2 id={`${id}-titel`} className="u-sr-only">Agenten</h2>
      <div className="start-agenten__rollen" role="radiogroup" aria-label="Agent wählen">
        {ROLLEN.map((r) => (
          <label key={r.id} className="start-agent" data-aktiv={r.id === rolleId || undefined}>
            <input type="radio" name={`${id}-rolle`} value={r.id} checked={r.id === rolleId}
              onChange={() => setRolleId(r.id)} className="u-sr-only" />
            <Avatar rolle={r.id} />
            <span className="start-agent__karte">
              <span className="start-agent__name">{r.name}{rolleTbd(r) && <Badge tone="spaeter">TBD</Badge>}</span>
              <span className="start-agent__unter">{r.untertitel}</span>
            </span>
          </label>
        ))}
      </div>

      {/* Producer bleibt eingehängt, damit Eingaben beim Rollenwechsel erhalten bleiben. */}
      <Producer hidden={rolleId !== "producer"} llm={llm} />
      {rolleId === "marketer" && <Marketer llm={llm} />}
      {rolleId !== "producer" && rolleId !== "marketer" && (
        <div className="start-prompt start-prompt--tbd" aria-live="polite">
          <p className="start-tbd__titel"><Info size={18} aria-hidden />{rolle.name}: noch nicht verfügbar <Badge tone="spaeter">TBD</Badge></p>
          <p className="start-tbd__text">Geplant – noch ohne Funktion, es wird nichts geschnitten, erzeugt oder veröffentlicht:</p>
          <Chips faehigkeiten={rolle.faehigkeiten} />
        </div>
      )}
    </section>
  );
}

function Chips({ faehigkeiten, llm, onAktiv }: { faehigkeiten: Faehigkeit[]; llm?: Llm; onAktiv?: (f: Faehigkeit) => void }) {
  return (
    <ul className="start-chips" aria-label="Aufgaben">
      {faehigkeiten.map((f) => {
        const st = faehigkeitStatus(f, llm);
        return (
          <li key={f.titel}>
            {st === "verfuegbar" && onAktiv
              ? <button type="button" className="start-chip start-chip--aktiv" onClick={() => onAktiv(f)}>
                  {f.task ? <Sparkles size={16} aria-hidden /> : <Video size={16} aria-hidden />}{f.titel}
                </button>
              : st === "einrichtung"
              ? <span className="start-chip" aria-disabled="true" title={llm === undefined ? "Status wird geladen" : "Text-KI ist nicht eingerichtet"}>
                  {f.titel} <Badge tone="warn">{llm === undefined ? "…" : "Einrichtung fehlt"}</Badge>
                </span>
              : <span className="start-chip" aria-disabled="true">{f.titel} <Badge tone="spaeter">TBD</Badge></span>}
          </li>
        );
      })}
    </ul>
  );
}

/** Marketer: Projekt wählen → Aufgabe öffnet „Erstellt für Dich“ mit Vorauswahl. Hier wird nichts gesendet. */
function Marketer({ llm }: { llm: Llm }) {
  const navigate = useNavigate();
  const marketer = ROLLEN.find((r) => r.id === "marketer")!;
  const [projekte, setProjekte] = useState<Project[] | null>(null);
  const [fehler, setFehler] = useState<unknown>(null);
  const [projektId, setProjektId] = useState("");
  const laden = useCallback(() => {
    setFehler(null);
    api.listProjects().then((l) => { setProjekte(l); setProjektId((a) => a || (l[0]?.id ?? "")); }, setFehler);
  }, []);
  useEffect(laden, [laden]);
  return (
    <div className="start-prompt" role="group" aria-label="Marketer">
      <p className="start-prompt__hinweis"><Info size={14} aria-hidden />{marketer.hinweis} Quelle ist ein fertiges Transkript; gesendet wird nur Text, kein Audio/Video.</p>
      <div className="start-feld">
        <label htmlFor="start-mkt-projekt">Projekt</label>
        {fehler != null ? <ErrorState compact title="Projekte konnten nicht geladen werden" error={fehler} onRetry={laden} />
          : !projekte ? <Spinner label="Projekte werden geladen …" />
          : !projekte.length ? <p className="start-prompt__hinweis">Noch kein Projekt – erst aufnehmen oder hochladen und transkribieren.</p>
          : (
            <select id="start-mkt-projekt" className="start-feld__select" value={projektId} onChange={(e) => setProjektId(e.target.value)}>
              {projekte.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          )}
      </div>
      <Chips faehigkeiten={marketer.faehigkeiten} llm={llm}
        onAktiv={projektId ? (f) => f.task && navigate(erstelltZiel(projektId, f.task)) : undefined} />
    </div>
  );
}

/** Läuft/fertig-Anzeige des Producer-Ausarbeitungsauftrags; Ergebnis liegt im Projekt unter „Erstellt für Dich“. */
function AusarbeitungStatus({ start, projektId }: { start: KiJob; projektId: string }) {
  const [job, setJob] = useKiJob(start);
  if (!job) return null;
  const gen = job.status === "succeeded" ? job.result?.generationId : null;
  return (
    <div className="start-ki-job">
      <KIJobStatus job={job} onJob={setJob} />
      {gen && <Link to={`/projekte/${encodeURIComponent(projektId)}/erstellt?ergebnis=${encodeURIComponent(gen)}`}><ExternalLink size={14} aria-hidden /> Ausarbeitung öffnen</Link>}
    </div>
  );
}

function Producer({ hidden, llm }: { hidden: boolean; llm: Llm }) {
  const konto = useKonto();
  const navigate = useNavigate();
  const [projekte, setProjekte] = useState<Project[] | null>(null);
  const [ladeFehler, setLadeFehler] = useState<unknown>(null);
  const [brief, setBrief] = useState("");
  const [projektId, setProjektId] = useState("");
  const [neuerTitel, setNeuerTitel] = useState("");
  const [episode, setEpisode] = useState(() => `Aufnahme ${formatDateTime(new Date().toISOString())}`);
  const [sprecher, setSprecher] = useState(() => leseName(konto.id));
  const [fehler, setFehler] = useState<Fehler>({});
  const [senden, setSenden] = useState<{ laeuft: boolean; fehler: unknown }>({ laeuft: false, fehler: null });
  const [ausarbeiten, setAusarbeiten] = useState(false);
  const [kiJob, setKiJob] = useState<{ job: KiJob; projektId: string } | null>(null);

  const laden = useCallback(() => {
    setLadeFehler(null);
    setProjekte(null);
    api.listProjects().then((l) => {
      const s = [...l].sort((a, b) => (b.lastRecordingAt ?? b.createdAt).localeCompare(a.lastRecordingAt ?? a.createdAt));
      setProjekte(s);
      setProjektId((alt) => alt || (s[0]?.id ?? NEU));
    }, setLadeFehler);
  }, []);
  useEffect(laden, [laden]);

  const producer = ROLLEN[0];
  const v = { projektId, neuerProjekttitel: neuerTitel, episodentitel: episode, sprecher };

  async function absenden(e: FormEvent) {
    e.preventDefault();
    const f = pruefe(v);
    setFehler(f);
    if (Object.keys(f).length) {
      document.getElementById(`start-prod-${Object.keys(f)[0]}`)?.focus();
      return;
    }
    setSenden({ laeuft: true, fehler: null });
    try {
      // Serverseitig angelegt wird nur hier, nach ausdrücklichem Klick.
      const ziel = projektId === NEU ? (await api.createProject(neuerTitel.trim())).id : projektId;
      navigate(studioZiel(ziel, episode, sprecher), { state: brief.trim() ? { brief: brief.trim() } : null });
    } catch (err) {
      setSenden({ laeuft: false, fehler: err });
    }
  }

  const err = (k: keyof Fehler) => fehler[k] && <p id={`start-prod-${k}-fehler`} className="start-feld__fehler">{fehler[k]}</p>;
  const desc = (k: keyof Fehler) => (fehler[k] ? `start-prod-${k}-fehler` : undefined);

  return (
    <form className="start-prompt" onSubmit={absenden} noValidate aria-label="Aufnahme vorbereiten" hidden={hidden}>
      <label htmlFor="start-prod-brief" className="u-sr-only">Aufnahmebrief (optional)</label>
      <textarea id="start-prod-brief" className="start-prompt__text" rows={3} maxLength={MAX_BRIEF} value={brief}
        placeholder={producer.hinweis} onChange={(e) => setBrief(e.target.value)} aria-describedby="start-prod-hinweis" />
      <p id="start-prod-hinweis" className="start-prompt__hinweis">
        <Info size={14} aria-hidden />
        Dein Brief erscheint unverändert als Spickzettel im Studio und wird dafür nicht auf dem Server gespeichert.
        Nur „Aufnahme ausarbeiten“ sendet ihn – nach Prüfung und deiner Einwilligung – an den KI-Anbieter und speichert ihn mit dem Auftrag.
        Freie KI-Unterhaltung <Badge tone="spaeter">TBD</Badge>.
      </p>

      <div className="start-prompt__felder">
        <div className="start-feld">
          <label htmlFor="start-prod-projekt">Projekt</label>
          {ladeFehler != null ? (
            <ErrorState compact title="Projekte konnten nicht geladen werden" error={ladeFehler} onRetry={laden} />
          ) : !projekte ? (
            <Spinner label="Projekte werden geladen …" />
          ) : (
            <select id="start-prod-projekt" className="start-feld__select" value={projektId}
              onChange={(e) => setProjektId(e.target.value)} aria-invalid={!!fehler.projekt} aria-describedby={desc("projekt")}>
              {projekte.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              <option value={NEU}>+ Neues Projekt anlegen</option>
            </select>
          )}
          {err("projekt")}
        </div>
        {projektId === NEU && (
          <div className="start-feld">
            <label htmlFor="start-prod-neuerProjekttitel">Name des neuen Projekts</label>
            <input id="start-prod-neuerProjekttitel" className="field" value={neuerTitel} maxLength={MAX_TITEL} placeholder="z. B. Mein Podcast"
              onChange={(e) => setNeuerTitel(e.target.value)} aria-invalid={!!fehler.neuerProjekttitel} aria-describedby={desc("neuerProjekttitel")} />
            {err("neuerProjekttitel")}
          </div>
        )}
        <div className="start-feld">
          <label htmlFor="start-prod-episodentitel">Episodentitel</label>
          <input id="start-prod-episodentitel" className="field" value={episode} maxLength={MAX_TITEL}
            onChange={(e) => setEpisode(e.target.value)} aria-invalid={!!fehler.episodentitel} aria-describedby={desc("episodentitel")} />
          {err("episodentitel")}
        </div>
        <div className="start-feld">
          <label htmlFor="start-prod-sprecher">Dein Name auf der Spur</label>
          <input id="start-prod-sprecher" className="field" value={sprecher} maxLength={MAX_TITEL} placeholder="Ich"
            onChange={(e) => setSprecher(e.target.value)} aria-invalid={!!fehler.sprecher} aria-describedby={desc("sprecher")} />
          {err("sprecher")}
        </div>
      </div>

      <div className="start-prompt__fuss">
        {senden.fehler != null && <ErrorState compact title="Projekt konnte nicht angelegt werden" error={senden.fehler} />}
        <Button type="submit" variant="primary" icon={ArrowRight} disabled={senden.laeuft || !projekte}>
          {senden.laeuft ? "Wird vorbereitet …" : "Studio vorbereitet öffnen"}
        </Button>
      </div>

      {ausarbeiten && (
        <div className="start-ki" role="group" aria-label="Aufnahme ausarbeiten">
          <p className="start-prompt__hinweis">
            <Sparkles size={14} aria-hidden />Aufnahme ausarbeiten: Gliederung, Einstieg, Fragenliste und Zeitplan aus deinem Brief (KI-Entwurf).
          </p>
          <KIAuftrag projektId={projektId && projektId !== NEU ? projektId : null} llm={llm} knopf="Aufnahme ausarbeiten"
            eingabe={projektId && projektId !== NEU && brief.trim() ? { task: "producer_outline", brief: brief.trim() } : null}
            gesperrt={!projektId || projektId === NEU ? "Bitte ein vorhandenes Projekt wählen (Ergebnis wird dort abgelegt)." : !brief.trim() ? "Bitte oben einen Aufnahmebrief eingeben." : null}
            onJob={(job) => setKiJob({ job, projektId })} />
          {kiJob && <AusarbeitungStatus key={kiJob.job.id} start={kiJob.job} projektId={kiJob.projektId} />}
        </div>
      )}

      <Chips faehigkeiten={producer.faehigkeiten} llm={llm} onAktiv={(f) => {
        if (f.task === "producer_outline") { setAusarbeiten(true); return; }
        (document.getElementById("start-prod-projekt") ?? document.getElementById("start-prod-episodentitel"))?.focus();
      }} />
    </form>
  );
}
