// Reine Logik für Transkript-Zustände und -Seite (PA8) – ohne React, testbar mit vitest.
import { ApiError, type Capabilities, type Job, type Track, type Transcript, type TranscriptSegment, type Usage } from "../../lib/api";

/** Gerundete Abrechnungseinheit wie im Server (§5.5): ceil(Dauer in s). */
export const asrSekunden = (durationMs: number | null) => (durationMs && durationMs > 0 ? Math.ceil(durationMs / 1000) : 0);
export const minuten = (sekunden: number) => Math.ceil(sekunden / 60);

/** Restliche ASR-Sekunden des Kontos; null = unbegrenzt oder unbekannt. */
export function asrRest(u: Usage | null): number | null {
  if (!u || u.asrSeconds.limit == null) return null;
  return Math.max(0, u.asrSeconds.limit - u.asrSeconds.used - u.asrSeconds.reserved);
}

export type TranskriptZustand =
  | "einrichtung" | "nicht_erreichbar" | "keins" | "eingereiht" | "wartet" | "laeuft" | "abbruch"
  | "fehlgeschlagen" | "abgebrochen" | "fertig";

/** Zustand der Spurzeile aus Spur, letztem Auftrag (falls geladen) und Dienstfähigkeit. */
export function transkriptZustand(t: Track, job: Job | null, asr: Capabilities["asr"] | null): TranskriptZustand {
  const j = job && job.id === t.transcription?.jobId ? job : null;
  let s = t.transcription?.status ?? "none";
  // Der gepollte Auftrag ist frischer als die Projektansicht (z. B. running → queued mit nextAttemptAt).
  if (j && (s === "queued" || s === "running") && j.status !== "succeeded") {
    s = j.status === "queued" || j.status === "running" ? j.status : "failed";
  }
  if (s === "queued" || s === "running") {
    // „abbruch“ setzt die Oberfläche selbst nach dem Klick (Job-Ansicht enthält cancelRequested nicht).
    if (s === "queued" && j?.nextAttemptAt) return "wartet";
    return s === "running" ? "laeuft" : "eingereiht";
  }
  if (s === "failed") return j?.status === "canceled" ? "abgebrochen" : "fehlgeschlagen";
  if (s === "ready") return "fertig";
  if (asr && asr.state === "configuration_required") return "einrichtung";
  if (asr && asr.state === "unavailable") return "nicht_erreichbar";
  return "keins";
}

export const ZUSTAND_TEXT: Record<TranskriptZustand, string> = {
  einrichtung: "Transkription: Einrichtung fehlt",
  nicht_erreichbar: "Transkriptionsdienst nicht erreichbar",
  keins: "Noch kein Transkript",
  eingereiht: "Transkription eingereiht",
  wartet: "Wartet auf Wiederholung",
  laeuft: "Transkription läuft",
  abbruch: "Abbruch angefordert",
  fehlgeschlagen: "Transkription fehlgeschlagen",
  abgebrochen: "Transkription abgebrochen",
  fertig: "Transkript fertig",
};

const FEHLER: Record<string, string> = {
  asr_unavailable: "Der Transkriptionsdienst war nicht erreichbar.",
  asr_gpu_required: "Der Dienst lief nur auf der CPU; laut Einstellung ist eine GPU vorgeschrieben.",
  asr_timeout: "Der Transkriptionsdienst hat nicht rechtzeitig geantwortet.",
  asr_rejected: "Der Transkriptionsdienst hat die Anfrage abgelehnt.",
  asr_bad_response: "Der Transkriptionsdienst lieferte eine ungültige Antwort.",
  // R7: auch bei bestätigtem Ersetzen, wenn während des Auftrags erneut bearbeitet wurde (expectedRevision).
  transcript_edited: "Das Transkript wurde bearbeitet – Ersetzen war nicht bestätigt oder es gab während des Auftrags eine neuere Bearbeitung. Die Bearbeitung bleibt erhalten.",
  configuration_required: "Der Transkriptionsdienst ist nicht eingerichtet.",
  interrupted: "Der Auftrag wurde unterbrochen.",
  internal: "Interner Fehler auf dem Server.",
};
export const fehlerText = (code: string | null) => (code ? FEHLER[code] ?? `Fehlercode ${code}.` : "Grund unbekannt.");

/** Text zu einem Fehler beim Anstoßen/Wiederholen – mit Kontingentangaben, ohne Werte von Geheimnissen. */
export function startFehlerText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Unerwarteter Fehler.";
  const d = e.details as Record<string, unknown>;
  switch (e.code) {
    case "quota_exceeded": {
      const used = Number(d.used ?? 0) + Number(d.reserved ?? 0), limit = Number(d.limit ?? 0), req = Number(d.requested ?? 0);
      const wer = d.scope === "platform" ? "Das Plattform-Kontingent" : "Dein Kontingent";
      return `${wer} reicht nicht: benötigt ${minuten(req)} Min., belegt ${minuten(used)} von ${minuten(limit)} Min.` +
        (typeof d.resetsAt === "string" ? ` Neu ab ${new Date(d.resetsAt).toLocaleDateString("de-DE")}.` : "");
    }
    case "configuration_required":
      return `Transkription ist nicht eingerichtet${Array.isArray(d.missing) && d.missing.length ? ` (fehlt: ${d.missing.join(", ")})` : ""}.`;
    case "jobs_limit": return "Zu viele laufende Aufträge. Warte, bis einer fertig ist.";
    case "not_ready": return "Die Spur ist noch nicht fertig verarbeitet.";
    case "not_local": return "Die Spur liegt nur im Archiv. Erst zurückholen.";
    case "new_job_required": return "Dieser Auftrag kann nicht unter derselben Nummer wiederholt werden. Starte ihn als neuen Auftrag.";
    default: return e.message;
  }
}

/** Zufälliger Idempotenzschlüssel ([A-Za-z0-9_-], 32 Zeichen) – auch ohne sicheren Kontext. */
export function neuerSchluessel(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Index des Segments, das zur Zeit `ms` gehört (letztes mit startMs ≤ ms), -1 davor. Binäre Suche. */
export function segmentBei(segs: Pick<TranscriptSegment, "startMs">[], ms: number): number {
  let lo = 0, hi = segs.length - 1, r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].startMs <= ms) { r = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return r;
}

export function zeitmarke(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, "0")}` : String(mm)) + ":" + String(ss).padStart(2, "0");
}

/** Welche Downloads sind ehrlich möglich und wie genau sind ihre Zeiten? */
export function exportGenauigkeit(t: Pick<Transcript, "timestamps" | "segments">): { untertitel: boolean; text: string } {
  if (t.timestamps === "none") return { untertitel: false, text: "Der Dienst lieferte keine Zeitstempel – SRT/VTT sind nicht möglich, nur TXT." };
  const bearbeitet = t.segments.some((s) => s.edited);
  if (t.timestamps === "word") return {
    untertitel: true,
    text: "Untertitelzeiten aus Wortzeiten." + (bearbeitet ? " Bearbeitete Segmente haben keine Wortzeiten mehr; dort wird proportional zur Zeichenzahl geteilt." : ""),
  };
  return { untertitel: true, text: "Nur Segmentzeiten: lange Segmente werden für Untertitel proportional zur Zeichenzahl geteilt (geschätzt)." };
}

/** Segmente für PATCH: alle IDs, Text aus den Änderungen oder dem Stand. */
export function patchSegmente(segs: TranscriptSegment[], aenderungen: Map<string, string>) {
  return segs.map((s) => ({ id: s.id, text: aenderungen.get(s.id) ?? s.text }));
}

/** Kennzeichnung des Testtreibers (PA3 `fake`): kein echtes Transkript. */
export const istSimuliert = (model: string | null | undefined) => model === "test-only";
