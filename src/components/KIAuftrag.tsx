// Gemeinsamer Text-KI-Ablauf (PA9): Prüfen (Schätzung) → Bestätigungsdialog mit Einwilligung → genau ein Auftrag → ehrlicher Status.
// Gesendet wird nur nach ausdrücklichem Klick im Dialog – nie beim Laden, Rollen- oder Reiterwechsel.
import { Ban, Check, CircleAlert, Clock, Send, Settings2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type Capabilities, type LlmEstimate } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import {
  AUFGABEN, DATEN_TEXT, evtlBezahlt, formatZahl, gleicheEingabe, jobFehlerText, kiSchluessel, KI_ZUSTAND_TEXT, kiZustand, laeuft, startFehlerText,
  type KiEingabe, type KiJob, type KiZustand,
} from "./ki";
import "./KIAuftrag.css";

const POLL_MS = 2000;

/** Pollt einen Auftrag, solange er läuft. Kein erneutes Senden, nur Lesen. */
export function useKiJob(start: KiJob | null, onEnde?: (j: KiJob) => void) {
  const [job, setJob] = useState<KiJob | null>(start);
  const gemeldet = useRef(new Set<string>());
  const ende = useRef(onEnde);
  ende.current = onEnde;
  useEffect(() => setJob(start), [start]);
  const id = job?.id, aktiv = laeuft(job);
  useEffect(() => {
    if (job && !laeuft(job) && !gemeldet.current.has(job.id)) {
      gemeldet.current.add(job.id);
      ende.current?.(job);
    }
  }, [job]);
  useEffect(() => {
    if (!id || !aktiv) return;
    let stop = false, timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const j = (await api.getJob(id)) as KiJob;
        if (stop) return;
        setJob(j);
        if (laeuft(j)) timer = setTimeout(tick, POLL_MS);
      } catch { if (!stop) timer = setTimeout(tick, POLL_MS * 5); }
    };
    timer = setTimeout(tick, POLL_MS);
    return () => { stop = true; clearTimeout(timer); };
  }, [id, aktiv]);
  return [job, setJob] as const;
}

const ICON: Record<KiZustand, ReactNode> = {
  eingereiht: <Clock size={16} aria-hidden />, wartet: <Clock size={16} aria-hidden />, laeuft: <Spinner size={16} label="Wird erstellt" />,
  fertig: <Check size={16} aria-hidden />, unklar: <CircleAlert size={16} aria-hidden />, unterbrochen: <CircleAlert size={16} aria-hidden />,
  fehlgeschlagen: <CircleAlert size={16} aria-hidden />, abgebrochen: <Ban size={16} aria-hidden />,
};

/** Statuszeile eines KI-Auftrags inkl. Abbrechen. Wiederholen gibt es bewusst nur als neuen Auftrag (neue Schätzung/Einwilligung/Schlüssel). */
export function KIJobStatus({ job, onJob }: { job: KiJob; onJob: (j: KiJob) => void }) {
  const z = kiZustand(job);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const abbrechen = async () => {
    setBusy(true); setFehler(null);
    try { onJob((await api.cancelJob(job.id)) as KiJob); } catch (e) { setFehler(startFehlerText(e)); } finally { setBusy(false); }
  };
  const detail = z === "wartet" ? `nächster Versuch ${formatDateTime(job.nextAttemptAt)} · ${jobFehlerText(job.errorCode)}`
    : z === "fehlgeschlagen" || z === "unklar" || z === "unterbrochen" ? jobFehlerText(job.errorCode) : null;
  return (
    <div className="ki-job" role="status">
      <span className={`ki-job__status ki-job__status--${z}`}>{ICON[z]}<span>{KI_ZUSTAND_TEXT[z]}</span>{detail && <span className="ki-job__detail">· {detail}</span>}</span>
      {job.usageEstimated && <Badge tone="warn" title="Der Anbieter hat keine Nutzung gemeldet; verbucht wurde der reservierte Wert.">Verbrauch geschätzt</Badge>}
      {laeuft(job) && <Button size="sm" variant="ghost" icon={Ban} onClick={abbrechen} disabled={busy}>Abbrechen</Button>}
      {evtlBezahlt(job) && (
        <p className="ki-job__hinweis">
          Möglicherweise wurde die Anfrage beim Anbieter bereits verarbeitet und berechnet; der reservierte Verbrauch ist verbucht.
          Es wird <strong>nicht</strong> automatisch erneut gesendet. Ein neuer Versuch ist ein neuer Auftrag mit neuer Prüfung und neuem Kontingent.
        </p>
      )}
      {fehler && <p className="ki-job__fehler" role="alert">{fehler}</p>}
    </div>
  );
}

type Phase =
  | { art: "ruhe" }
  | { art: "schaetzt" }
  | { art: "pruefen"; est: LlmEstimate; snap: KiEingabe; projektId: string; sendet: boolean };

/**
 * Ein Auslöser für genau eine Aufgabe. `eingabe` null = (noch) nicht auslösbar, Grund in `gesperrt`.
 * Die geschätzte Eingabe wird eingefroren; nur sie wird nach Einwilligung gesendet. Ändert sich die Eingabe, muss neu geprüft werden.
 */
export function KIAuftrag({ projektId, eingabe, llm, gesperrt, knopf, onJob }: {
  projektId: string | null; eingabe: KiEingabe | null; llm: Capabilities["llm"] | null | undefined;
  gesperrt?: string | null; knopf?: string; onJob?: (j: KiJob) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ art: "ruhe" });
  const aktuell = useRef({ projektId, eingabe });
  aktuell.current = { projektId, eingabe };
  const [fehler, setFehler] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  // Ein Schlüssel je bestätigter Absicht: bleibt nur bei Netzfehlern (Server liefert dann denselben Auftrag), sonst neu.
  const schluessel = useRef<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const offen = phase.art === "pruefen";
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (offen && !d.open) d.showModal?.();
    if (!offen && d.open) d.close();
  }, [offen]);

  // Eingabe nach der Prüfung verändert → Prüfung verfällt (es wird nie etwas anderes gesendet als geschätzt).
  useEffect(() => {
    if (phase.art === "pruefen" && !phase.sendet && (phase.projektId !== projektId || !gleicheEingabe(phase.snap, eingabe))) {
      schliessen();
      setFehler("Eingabe geändert – bitte erneut prüfen.");
    }
  });

  function schliessen() { schluessel.current = null; setOk(false); setPhase({ art: "ruhe" }); }

  const bereit = llm?.state === "ready";
  if (!llm || !bereit) {
    const text = !llm ? "Status der Text-KI konnte nicht geladen werden." : llm.state === "configuration_required"
      ? `Einrichtung fehlt${llm.missing.length ? ` (fehlt: ${llm.missing.join(", ")})` : ""}.` : "Text-KI derzeit nicht erreichbar.";
    return (
      <div className="ki-auftrag">
        <Button icon={Sparkles} disabled title={text}>{knopf ?? "Erstellen"}</Button>
        <p className="ki-auftrag__einrichtung"><Settings2 size={16} aria-hidden />Text-KI: {text} Es wird nichts erzeugt.</p>
      </div>
    );
  }

  const pruefen = async () => {
    if (!eingabe || !projektId) return;
    const snap: KiEingabe = JSON.parse(JSON.stringify(eingabe));
    const quellProjekt = projektId;
    setFehler(null); setPhase({ art: "schaetzt" });
    try {
      const est = await api.estimateGeneration(quellProjekt, snap);
      if (aktuell.current.projektId !== quellProjekt || !gleicheEingabe(snap, aktuell.current.eingabe)) {
        schliessen(); setFehler("Projekt oder Eingabe geändert – bitte erneut prüfen."); return;
      }
      schluessel.current = null; setOk(false);
      setPhase({ art: "pruefen", est, snap, projektId: quellProjekt, sendet: false });
    } catch (e) { setFehler(startFehlerText(e)); setPhase({ art: "ruhe" }); }
  };

  const senden = async () => {
    if (phase.art !== "pruefen" || !projektId || !ok || !phase.est.allowed) return;
    const { est, snap, projektId: quellProjekt } = phase;
    if (quellProjekt !== projektId || !gleicheEingabe(snap, eingabe)) {
      schliessen(); setFehler("Projekt oder Eingabe geändert – bitte erneut prüfen."); return;
    }
    setPhase({ ...phase, sendet: true }); setFehler(null);
    schluessel.current ??= kiSchluessel();
    try {
      const job = (await api.createGeneration(quellProjekt, { ...snap, consent: { provider: est.provider, model: est.model, dataScope: est.dataScope } }, schluessel.current)) as KiJob;
      schliessen();
      onJob?.(job);
    } catch (e) {
      const netz = e instanceof ApiError && e.isNetwork;
      if (!netz) schluessel.current = null;
      setFehler(netz ? "Server nicht erreichbar. Erneut „Senden“ fragt denselben Auftrag ab (kein zweiter Versand)." : startFehlerText(e));
      if (netz) setPhase({ art: "pruefen", est, snap, projektId: quellProjekt, sendet: false }); else schliessen();
    }
  };

  const est = phase.art === "pruefen" ? phase.est : null;
  return (
    <div className="ki-auftrag">
      <Button variant="primary" icon={Sparkles} onClick={pruefen} disabled={!eingabe || !projektId || phase.art !== "ruhe"} title={gesperrt ?? undefined}>
        {phase.art === "schaetzt" ? "Wird geprüft …" : `${knopf ?? "Erstellen"} …`}
      </Button>
      {gesperrt && <p className="ki-auftrag__hinweis">{gesperrt}</p>}
      {fehler && <p className="ki-auftrag__fehler" role="alert">{fehler}</p>}

      <dialog ref={dialog} className="ki-dialog" aria-labelledby="ki-dialog-titel" onCancel={(e) => { e.preventDefault(); if (!(phase.art === "pruefen" && phase.sendet)) schliessen(); }}>
        {est && phase.art === "pruefen" && (
          <div className="ki-dialog__inhalt">
            <h2 id="ki-dialog-titel">An KI-Anbieter senden?</h2>
            <p className="ki-dialog__aufgabe">{AUFGABEN[phase.snap.task].titel}</p>
            <dl className="ki-dialog__liste">
              <dt>Anbieter</dt><dd>{est.provider === "openai" ? "OpenAI" : est.provider}</dd>
              <dt>Modell</dt><dd className="u-mono">{est.model}</dd>
              <dt>Gesendet wird</dt><dd>{DATEN_TEXT[est.dataScope]} ({formatZahl(est.inputChars)} Zeichen)</dd>
              <dt>Reserviert</dt><dd>bis {formatZahl(est.reserveTokens)} Token (davon höchstens {formatZahl(est.maxOutputTokens)} Antwort)</dd>
              <dt>Restkontingent</dt><dd>{est.remainingTokens == null ? "unbegrenzt" : `${formatZahl(est.remainingTokens)} Token diesen Monat`}</dd>
            </dl>
            <p className="ki-dialog__klein">Abgerechnet wird der vom Anbieter gemeldete Verbrauch; meldet er keinen, gilt der reservierte Wert. Ergebnisse sind KI-Entwürfe und können Fehler enthalten.</p>
            {!est.allowed && <p className="ki-auftrag__fehler" role="alert">Kontingent reicht nicht – senden ist nicht möglich.</p>}
            <label className="ki-dialog__einwilligung">
              <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} disabled={!est.allowed || phase.sendet} />
              <span>Ich willige ein, dass diese Daten an {est.provider === "openai" ? "OpenAI" : est.provider} ({est.model}) gesendet werden.</span>
            </label>
            {fehler && <p className="ki-auftrag__fehler" role="alert">{fehler}</p>}
            <div className="ki-dialog__knoepfe">
              <Button variant="ghost" onClick={schliessen} disabled={phase.sendet}>Abbrechen</Button>
              <Button variant="primary" icon={Send} onClick={senden} disabled={!ok || !est.allowed || phase.sendet}>
                {phase.sendet ? "Wird gesendet …" : "Senden"}
              </Button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}
