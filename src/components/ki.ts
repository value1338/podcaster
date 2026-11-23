// Gemeinsame Text-KI-Logik (PA9) für „Erstellt für Dich“ und Agenten – ohne React, testbar mit vitest.
// Nur Vertrags-Aufgaben (LlmTask), keine Preise in der UI: Bedarf/Rest kommen ausschließlich aus LlmEstimate.
import { ApiError, type GenerationInput, type Job, type LlmDataScope, type LlmTask } from "../lib/api";

export type KiEingabe = Omit<GenerationInput, "consent">;

export const AUFGABEN: Record<LlmTask, { titel: string; text: string }> = {
  shownotes: { titel: "Shownotes / Beschreibung", text: "Zusammenfassung und Themenliste aus dem Transkript." },
  chapters: { titel: "Kapitel", text: "Kapitelmarken – nur an echten Segmentanfängen des Transkripts." },
  titles: { titel: "Titelvorschläge", text: "Zehn Titelvorschläge für die Folge." },
  social: { titel: "Social-Media-Entwürfe", text: "Je ein Entwurf für LinkedIn, Instagram und einen Kurzpost." },
  marketer_plan: { titel: "Veröffentlichungsplan & Newsletter", text: "Kernbotschaft, Zielgruppe, drei Zitate mit Zeitmarke, Newsletter-Absatz." },
  producer_outline: { titel: "Aufnahme ausarbeiten (Skript)", text: "Gliederung, Einstieg, Fragenliste und Zeitplan aus deinem Aufnahmebrief." },
};
export const AUFGABEN_REIHE: LlmTask[] = ["shownotes", "chapters", "titles", "social", "marketer_plan", "producer_outline"];

/** Was den Server Richtung Anbieter verlässt (Vertrag §5.6) – nie Audio/Video, E-Mail, Konto-IDs. */
export const DATEN_TEXT: Record<LlmDataScope, string> = {
  transcript_text: "Transkripttext (mit Segment-Zeitmarken), Projekt- und Aufnahmetitel, Teilnehmername – kein Audio, kein Video.",
  brief_text: "Dein Aufnahmebrief und der Projekttitel – kein Audio, kein Video.",
};

/** Gemeinsame API-Jobansicht einschließlich geschätztem Verbrauch und unklarem Ergebnis. */
export type KiJob = Job;

export type KiZustand = "eingereiht" | "wartet" | "laeuft" | "fertig" | "unklar" | "unterbrochen" | "fehlgeschlagen" | "abgebrochen";

export function kiZustand(j: KiJob): KiZustand {
  if (j.status === "queued") return j.nextAttemptAt ? "wartet" : "eingereiht";
  if (j.status === "running") return "laeuft";
  if (j.status === "succeeded") return "fertig";
  if (j.status === "canceled") return "abgebrochen";
  if (j.errorCode === "interrupted") return "unterbrochen";
  if (j.unclear || j.errorCode === "llm_unclear") return "unklar";
  return "fehlgeschlagen";
}
export const laeuft = (j: KiJob | null) => !!j && (j.status === "queued" || j.status === "running");

export const KI_ZUSTAND_TEXT: Record<KiZustand, string> = {
  eingereiht: "Eingereiht",
  wartet: "Wartet auf Wiederholung",
  laeuft: "Wird erstellt",
  fertig: "Fertig",
  unklar: "Ergebnis unklar",
  unterbrochen: "Unterbrochen",
  fehlgeschlagen: "Fehlgeschlagen",
  abgebrochen: "Abgebrochen",
};

const JOB_FEHLER: Record<string, string> = {
  llm_unavailable: "Der KI-Anbieter war nicht erreichbar.",
  llm_rejected: "Der KI-Anbieter hat die Anfrage abgelehnt.",
  llm_bad_response: "Die Antwort war ungültig (z. B. erfundene Kapitelzeit) und wurde verworfen.",
  llm_unclear: "Nach dem Versand blieb unklar, ob der Anbieter die Anfrage verarbeitet hat.",
  interrupted: "Der Server wurde während des Auftrags neu gestartet.",
  internal: "Interner Fehler auf dem Server.",
};
export const jobFehlerText = (code: string | null) => (code ? JOB_FEHLER[code] ?? `Fehler (${code}).` : "Unbekannter Fehler.");

/** Möglicherweise bezahlt: Server verbucht konservativ, nichts wird automatisch erneut gesendet. */
export const evtlBezahlt = (j: KiJob) =>
  (j.status === "failed" && (!!j.unclear || j.errorCode === "interrupted" || j.errorCode === "llm_unclear"))
  || (j.status === "canceled" && !!j.usageEstimated); // Abbruch nach Versand: Server verbucht konservativ

export function startFehlerText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Unerwarteter Fehler.";
  const d = e.details;
  switch (e.code) {
    case "quota_exceeded": return `Kontingent reicht nicht (${d.scope === "platform" ? "Plattform-Deckel" : "dein Konto"}). Es wurde nichts gesendet.`;
    case "consent_required": return "Anbieter oder Modell haben sich geändert. Bitte neu prüfen und erneut zustimmen. Es wurde nichts gesendet.";
    case "configuration_required": return `Text-KI ist nicht eingerichtet${Array.isArray(d.missing) && d.missing.length ? ` (fehlt: ${d.missing.join(", ")})` : ""}. Es wurde nichts gesendet.`;
    case "no_transcript": return "Für diese Spur gibt es noch kein Transkript.";
    case "no_timestamps": return "Das Transkript hat keine Zeitmarken – Kapitel sind nicht möglich.";
    case "input_too_large": return "Der Text ist für eine Anfrage zu groß.";
    case "jobs_limit": return "Zu viele laufende Aufträge. Bitte warten, bis einer fertig ist.";
    case "rate_limited": return "Zu viele Anfragen in kurzer Zeit. Bitte kurz warten.";
    case "invalid_input": return "Eingabe ungültig (Aufnahmebrief 1–4000 Zeichen).";
    case "idempotency_conflict": return "Auftragsschlüssel bereits verwendet. Bitte neu prüfen.";
    default: return e.message;
  }
}

/** Zeitmarke hh:mm:ss wie im Kapitel-Markdown des Servers. */
export function zeitmarke(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

export const gleicheEingabe = (a: KiEingabe | null, b: KiEingabe | null) => JSON.stringify(a) === JSON.stringify(b);

export const formatZahl = (n: number) => n.toLocaleString("de-DE");

/** Idempotency-Key (32 hex). getRandomValues statt randomUUID: funktioniert auch ohne sicheren Kontext (HTTP im LAN). */
export function kiSchluessel(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
