// Reine Umrechnungen für die Verwaltung (PA6). Server speichert ganze, nicht-negative Zahlen oder null (= unbegrenzt).
import type { Invite, Plan } from "../../lib/api";

export interface Feld<K extends string> { key: K; label: string; einheit: string; faktor: number }

/** Plan-Felder in Anzeigeeinheiten. Speicher dezimal (1 GB = 10⁹ Byte) wie die Startwerte in V §3. */
export const PLAN_FELDER: Feld<Exclude<keyof Plan, "id" | "name">>[] = [
  { key: "asrSecondsMonth", label: "Transkription / Monat", einheit: "min", faktor: 60 },
  { key: "llmTokensMonth", label: "Text-KI-Token / Monat", einheit: "Token", faktor: 1 },
  { key: "llmCostMicroMonth", label: "Text-KI-Kosten / Monat", einheit: "USD", faktor: 1_000_000 },
  { key: "storageBytes", label: "Speicher", einheit: "GB", faktor: 1_000_000_000 },
  { key: "activeJobs", label: "Gleichzeitige Aufträge", einheit: "Anzahl", faktor: 1 },
];

/** Gespeicherten Wert als Eingabetext: null → "" (unbegrenzt). */
export function zuEingabe(wert: number | null, faktor: number): string {
  if (wert === null) return "";
  return String(Math.round((wert / faktor) * 1e6) / 1e6).replace(".", ",");
}

/** Eingabetext → gespeicherter Wert. "" → null. Wirft bei ungültiger Eingabe. */
export function ausEingabe(text: string, faktor: number): number | null {
  const t = text.trim().replace(/\s/g, "").replace(",", ".");
  if (t === "") return null;
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("Nur nicht-negative Zahlen oder leer (= unbegrenzt).");
  const n = Math.round(Number(t) * faktor);
  if (!Number.isSafeInteger(n)) throw new Error("Zahl ist zu groß.");
  return n;
}

export const formatUsd = (micro: number | null) =>
  micro === null ? "unbegrenzt" : (micro / 1_000_000).toLocaleString("de-DE", { style: "currency", currency: "USD", maximumFractionDigits: 4 });

export type EinladungsStatus = "offen" | "benutzt" | "abgelaufen";
export function einladungsStatus(i: Invite, jetzt = Date.now()): EinladungsStatus {
  if (i.usedAt) return "benutzt";
  return Date.parse(i.expiresAt) <= jetzt ? "abgelaufen" : "offen";
}

/** "YYYY-MM" des aktuellen UTC-Monats (Zählperiode V §3). */
export const aktuellePeriode = (d = new Date()) => d.toISOString().slice(0, 7);

/** Warnung: Schlüssel würde unverschlüsselt (http) an einen Nicht-Loopback-Host gehen. */
export function httpWarnung(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && !["localhost", "[::1]"].includes(u.hostname) && !/^127\./.test(u.hostname);
  } catch { return false; }
}

/** Für Mitglieder wählbare Pläne (intern nur Eigentümer, V §5.2). */
export const MITGLIEDS_PLAENE = ["free", "pro"] as const;
