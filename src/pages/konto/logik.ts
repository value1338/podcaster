// Reine Hilfen für Konto/Verwaltung (PA6) – ohne React, damit sie getestet werden können.
import { ApiError, type MeterState } from "../../lib/api";

export const KENNWORT_MIN = 10;
export const KENNWORT_MAX = 200;

/** Clientseitige Vorprüfung wie V §2.1 (Server prüft maßgeblich). null = in Ordnung. */
export function kennwortProblem(neu: string, wiederholung: string): string | null {
  if (neu.length < KENNWORT_MIN) return `Das Kennwort braucht mindestens ${KENNWORT_MIN} Zeichen.`;
  if (neu.length > KENNWORT_MAX) return `Das Kennwort darf höchstens ${KENNWORT_MAX} Zeichen haben.`;
  if (neu !== wiederholung) return "Die beiden Kennwörter stimmen nicht überein.";
  return null;
}

/** Wartezeit aus 429 rate_limited (retryAfterS) in Sekunden, sonst null. */
export function wartezeit(e: unknown): number | null {
  if (!(e instanceof ApiError) || e.status !== 429) return null;
  const s = Number(e.details.retryAfterS);
  return Number.isFinite(s) && s > 0 ? Math.ceil(s) : 60;
}

export function formatWarten(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  return m === 1 ? "1 Minute" : `${m} Minuten`;
}

/** Endpunkt liefert der Server (noch) nicht – ehrlich anzeigen statt Werte zu erfinden. */
export const nichtBereitgestellt = (e: unknown) => e instanceof ApiError && e.status === 404 && e.code === "not_found";

/** 503 configuration_required → Namen fehlender Einstellungen (nie Werte), sonst null. */
export function einrichtungFehlt(e: unknown): string[] | null {
  if (!(e instanceof ApiError) || e.code !== "configuration_required") return null;
  const m = e.details.missing;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === "string") : [];
}

/** Verständlicher Satz zu Fehlern aus Anmelden/Einlösen/Kennwortwechsel. */
export function kontoFehlertext(e: unknown): string {
  if (!(e instanceof ApiError)) return "Unerwarteter Fehler.";
  switch (e.code) {
    case "invalid_credentials": return "E-Mail oder Kennwort ist falsch.";
    case "rate_limited": return `Zu viele Versuche. Bitte in ${formatWarten(wartezeit(e) ?? 60)} erneut versuchen.`;
    case "setup_required": return "Das Studio ist noch nicht eingerichtet.";
    case "token_invalid": return "Dieser Link ist ungültig, abgelaufen oder wurde schon benutzt.";
    case "email_taken": return "Für diese E-Mail gibt es bereits ein Konto.";
    case "invalid_input": return e.message || "Bitte Eingaben prüfen.";
    case "csrf": return "Anfrage abgewiesen (Herkunft). Bitte die Seite über die offizielle Adresse öffnen.";
    default: return e.message;
  }
}

export type Einheit = "sekunden" | "token" | "bytes" | "anzahl";

/** Speicher dezimal (1 GB = 10⁹ Byte) wie Planwerte in V §3 und der Plan-Editor. */
export function formatSpeicher(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return i === 0 ? `${v} B` : `${v.toLocaleString("de-DE", { maximumFractionDigits: 1 })} ${u[i]}`;
}

export function formatMenge(n: number, einheit: Einheit): string {
  switch (einheit) {
    case "sekunden": return `${Math.ceil(n / 60).toLocaleString("de-DE")} min`;
    case "token": return n.toLocaleString("de-DE");
    case "bytes": return formatSpeicher(n);
    case "anzahl": return n.toLocaleString("de-DE");
  }
}

/** Belegt = verbraucht + reserviert (V §4 Regel 1). Anteil 0–1 oder null bei unbegrenzt. */
export function meterAnteil(m: MeterState): number | null {
  if (m.limit === null) return null;
  if (m.limit <= 0) return 1;
  return Math.min(1, (m.used + m.reserved) / m.limit);
}

export function meterText(m: MeterState, einheit: Einheit): string {
  const belegt = formatMenge(m.used + m.reserved, einheit);
  return m.limit === null ? `${belegt} · unbegrenzt` : `${belegt} von ${formatMenge(m.limit, einheit)}`;
}

/** Kontingent erreicht/überschritten (blockiert neue Aufträge bzw. Aufnahmen). */
export const meterVoll = (m: MeterState) => m.limit !== null && m.used + m.reserved >= m.limit;

/** Link aus der API (relativ zur Serverbasis) als vollständige Adresse zum Weitergeben. */
export function absoluteUrl(url: string, origin: string): string {
  return new URL(url, origin).href;
}
