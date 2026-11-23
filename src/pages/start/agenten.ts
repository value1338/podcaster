// Agentenleiste der Startseite: Rollen, Fähigkeiten (echt oder TBD), Vorbereitung → Studio-Übergabe.
// Producer „Aufnahme vorbereiten“ ist regelbasiert. Text-KI-Aufgaben (PA9) sind nur verfügbar, wenn capabilities.llm bereit ist;
// sie senden nie selbst, sondern laufen über Prüfung + Einwilligung (KIAuftrag). Editor/Clipper bleiben TBD (kein Schnitt aus Text).
import type { Capabilities, LlmTask } from "../../lib/api";

export type RolleId = "producer" | "editor" | "clipper" | "marketer";

/** verfuegbar = ohne Dienst nutzbar; task = Text-KI-Aufgabe laut Vertrag, nur mit bereitem LLM-Dienst. */
export interface Faehigkeit { titel: string; verfuegbar: boolean; task?: LlmTask }
export interface Rolle {
  id: RolleId;
  name: string;
  untertitel: string;
  /** Platzhalter des Eingabefelds. */
  hinweis: string;
  faehigkeiten: Faehigkeit[];
}

export const ROLLEN: Rolle[] = [
  {
    id: "producer", name: "Producer", untertitel: "Bereitet deine Aufnahme vor",
    hinweis: "Aufnahmebrief: Themen, Fragen, Reihenfolge … – erscheint im Studio als Spickzettel",
    faehigkeiten: [
      { titel: "Aufnahme vorbereiten", verfuegbar: true },
      { titel: "Aufnahme ausarbeiten", verfuegbar: false, task: "producer_outline" },
      { titel: "Skript schreiben", verfuegbar: false },
      { titel: "Webinar vorbereiten", verfuegbar: false },
    ],
  },
  {
    id: "editor", name: "Editor", untertitel: "Schneidet deine Episode",
    hinweis: "Der Editor ist noch nicht verfügbar.",
    faehigkeiten: [
      { titel: "Füllwörter und Pausen entfernen", verfuegbar: false },
      { titel: "Episode schneiden", verfuegbar: false },
      { titel: "Klang verbessern", verfuegbar: false },
    ],
  },
  {
    id: "clipper", name: "Clipper", untertitel: "Findet starke Momente",
    hinweis: "Der Clipper ist noch nicht verfügbar.",
    faehigkeiten: [
      { titel: "Kurze Clips finden", verfuegbar: false },
      { titel: "Hochformat-Clips erstellen", verfuegbar: false },
      { titel: "Untertitel einblenden", verfuegbar: false },
    ],
  },
  {
    id: "marketer", name: "Marketer", untertitel: "Bringt die Folge unter Leute",
    hinweis: "Wähle ein Projekt – erstellt wird im Reiter „Erstellt für Dich“ nach Prüfung und Einwilligung.",
    faehigkeiten: [
      { titel: "Shownotes schreiben", verfuegbar: false, task: "shownotes" },
      { titel: "Social-Media-Posts entwerfen", verfuegbar: false, task: "social" },
      { titel: "Newsletter-Text vorschlagen", verfuegbar: false, task: "marketer_plan" },
      { titel: "Titel vorschlagen", verfuegbar: false, task: "titles" },
    ],
  },
];

export const MAX_TITEL = 120; // docs/API.md: Titel 1–120 Zeichen
export const MAX_BRIEF = 4000;
export const NEU = "__neu__";

export interface Vorbereitung {
  projektId: string;      // vorhandene ID oder NEU
  neuerProjekttitel: string;
  episodentitel: string;
  sprecher: string;
}
export type Fehler = Partial<Record<"projekt" | "neuerProjekttitel" | "episodentitel" | "sprecher", string>>;

export function pruefe(v: Vorbereitung): Fehler {
  const f: Fehler = {};
  if (!v.projektId) f.projekt = "Bitte ein Projekt wählen.";
  if (v.projektId === NEU) {
    const t = v.neuerProjekttitel.trim();
    if (!t) f.neuerProjekttitel = "Bitte einen Projektnamen eingeben.";
    else if (t.length > MAX_TITEL) f.neuerProjekttitel = `Höchstens ${MAX_TITEL} Zeichen.`;
  }
  const e = v.episodentitel.trim();
  if (!e) f.episodentitel = "Bitte einen Episodentitel eingeben.";
  else if (e.length > MAX_TITEL) f.episodentitel = `Höchstens ${MAX_TITEL} Zeichen.`;
  if (v.sprecher.trim().length > MAX_TITEL) f.sprecher = `Höchstens ${MAX_TITEL} Zeichen.`;
  return f;
}

/** Zielroute des vorbereiteten Studios (relativ zur App-Basis, für navigate()). */
export function studioZiel(projektId: string, episodentitel: string, sprecher: string): string {
  const q = new URLSearchParams({ titel: episodentitel.trim() });
  if (sprecher.trim()) q.set("name", sprecher.trim());
  return `/studio/${encodeURIComponent(projektId)}?${q}`;
}

export interface StudioVorgabe { titel?: string; name?: string; brief?: string }

/** Liest die Übergabe im Studio; ungültige/überlange Werte werden verworfen bzw. gekürzt. */
export function leseVorgabe(q: URLSearchParams, state: unknown): StudioVorgabe {
  const kurz = (s: string | null, max: number) => (s ?? "").trim().slice(0, max) || undefined;
  const b = (state as { brief?: unknown } | null)?.brief;
  return {
    titel: kurz(q.get("titel"), MAX_TITEL),
    name: kurz(q.get("name"), MAX_TITEL),
    brief: typeof b === "string" ? kurz(b, MAX_BRIEF) : undefined,
  };
}

export type FaehigkeitStatus = "verfuegbar" | "einrichtung" | "tbd";
/** KI-Aufgaben: verfügbar nur bei llm.state==='ready'; sonst sichtbar „Einrichtung fehlt“ (nicht auslösbar). */
export function faehigkeitStatus(f: Faehigkeit, llm: Capabilities["llm"] | null | undefined): FaehigkeitStatus {
  if (f.verfuegbar) return "verfuegbar";
  if (!f.task) return "tbd";
  return llm?.state === "ready" ? "verfuegbar" : "einrichtung";
}
/** Rolle ganz ohne nutzbare Fähigkeit (Editor, Clipper) = TBD. */
export const rolleTbd = (r: Rolle) => r.faehigkeiten.every((f) => !f.verfuegbar && !f.task);

/** Ziel für Marketer-Aufgaben: Reiter „Erstellt für Dich“ mit vorgewählter Aufgabe – dort erst Prüfung/Einwilligung. */
export const erstelltZiel = (projektId: string, task: LlmTask) => `/projekte/${encodeURIComponent(projektId)}/erstellt?aufgabe=${task}`;
