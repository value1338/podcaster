// Gemeinsame Bausteine für Konto und Verwaltung (PA6).
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, ErrorState, PageSpinner } from "../../components";
import type { MeterState, Usage } from "../../lib/api";
import { formatDate, formatDateTime } from "../../lib/format";
import { absoluteUrl, einrichtungFehlt, type Einheit, formatMenge, meterAnteil, meterText, meterVoll, nichtBereitgestellt } from "./logik";

/** Einmaliger Abruf mit Lade-/Fehlerzustand. */
export function useAbruf<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [daten, setDaten] = useState<T | null>(null);
  const [fehler, setFehler] = useState<unknown>(null);
  const lauf = useRef(0);
  const laden = useCallback(() => {
    const n = ++lauf.current;
    setFehler(null);
    fn().then((d) => n === lauf.current && setDaten(d), (e) => n === lauf.current && setFehler(e));
  }, deps);
  useEffect(laden, [laden]);
  return { daten, fehler, laden, setDaten };
}

/** Lade-/Fehler-/„noch nicht bereitgestellt“-Rahmen um einen Abruf. */
export function Abrufzustand({ fehler, laedt, titel, onRetry, children }: {
  fehler: unknown; laedt: boolean; titel: string; onRetry: () => void; children: () => React.ReactNode;
}) {
  if (fehler != null) {
    const fehlt = einrichtungFehlt(fehler);
    if (fehlt) {
      return <ErrorState compact title={`${titel}: Einrichtung fehlt`} error={fehler}
        message={`Der Dienst ist auf dem Server noch nicht eingerichtet${fehlt.length ? ` (fehlt: ${fehlt.join(", ")})` : ""}.`} onRetry={onRetry} retryLabel="Erneut prüfen" />;
    }
    if (nichtBereitgestellt(fehler)) {
      return <ErrorState compact title={`${titel}: noch nicht verfügbar`} error={fehler}
        message="Der Server stellt diese Daten in der aktuellen Version noch nicht bereit." onRetry={onRetry} retryLabel="Erneut prüfen" />;
    }
    return <ErrorState compact title={`${titel} konnte nicht geladen werden`} error={fehler} onRetry={onRetry} />;
  }
  if (laedt) return <PageSpinner label={`${titel} wird geladen …`} />;
  return <>{children()}</>;
}

export function Zaehler({ titel, m, einheit }: { titel: string; m: MeterState; einheit: Einheit }) {
  const anteil = meterAnteil(m);
  const voll = meterVoll(m);
  return (
    <div className="konto-zaehler">
      <div className="konto-zaehler__kopf">
        <span>{titel}</span>
        {voll && <Badge tone="warn">Kontingent erreicht</Badge>}
      </div>
      <div className="konto-zaehler__wert u-mono">{meterText(m, einheit)}</div>
      {m.reserved > 0 && <div className="u-muted konto-zaehler__klein">davon reserviert für laufende Aufträge: <span className="u-mono">{formatMenge(m.reserved, einheit)}</span></div>}
      {anteil !== null && (
        <div className="konto-zaehler__balken" role="meter" aria-label={titel} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(anteil * 100)} aria-valuetext={meterText(m, einheit)}>
          <span style={{ width: `${anteil * 100}%` }} className={voll ? "is-voll" : undefined} />
        </div>
      )}
    </div>
  );
}

export function Verbrauch({ usage }: { usage: Usage }) {
  return (
    <div className="konto-verbrauch">
      <div className="konto-zaehler-raster">
        <Zaehler titel="Transkription" m={usage.asrSeconds} einheit="sekunden" />
        <Zaehler titel="Text-KI (Token)" m={usage.llmTokens} einheit="token" />
        <Zaehler titel="Speicher" m={usage.storageBytes} einheit="bytes" />
        <Zaehler titel="Gleichzeitige Aufträge" m={usage.activeJobs} einheit="anzahl" />
      </div>
      <p className="u-muted konto-zaehler__klein">Zeitraum <span className="u-mono">{usage.period}</span> · Monatszähler beginnen neu am {formatDate(usage.resetsAt)}. Speicher und Aufträge sind keine Monatswerte.</p>
    </div>
  );
}

/** Einmal angezeigter Link (Einladung/Rücksetzen). Liegt nur im Komponentenzustand, nie im Browserspeicher. */
export function LinkAnzeige({ url, expiresAt, art, onFertig }: { url: string; expiresAt: string; art: string; onFertig: () => void }) {
  const voll = absoluteUrl(url, window.location.origin);
  const feld = useRef<HTMLInputElement>(null);
  const [kopiert, setKopiert] = useState<"ja" | "nein" | null>(null);
  const kopieren = async () => {
    try { await navigator.clipboard.writeText(voll); setKopiert("ja"); }
    catch { feld.current?.select(); setKopiert("nein"); }
  };
  return (
    <div className="konto-link" role="status">
      <p><strong>{art}</strong> – wird nur jetzt angezeigt. Gültig bis {formatDateTime(expiresAt)}, einmal verwendbar.</p>
      <div className="konto-link__zeile">
        <input ref={feld} className="field u-mono" readOnly value={voll} aria-label={`${art} (Adresse)`} onFocus={(e) => e.currentTarget.select()} />
        <Button icon={kopiert === "ja" ? Check : Copy} onClick={kopieren}>{kopiert === "ja" ? "Kopiert" : "Kopieren"}</Button>
      </div>
      {kopiert === "nein" && <p className="u-muted konto-zaehler__klein">Kopieren nicht möglich – Adresse ist markiert, bitte manuell kopieren.</p>}
      <p className="u-muted konto-zaehler__klein">Kein Mailversand: Link selbst sicher weitergeben.</p>
      <div><Button size="sm" onClick={onFertig}>Schließen</Button></div>
    </div>
  );
}
