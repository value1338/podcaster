// Einzige Quelle für Navigation UND Routen (Besitzer: AP0).
// Aktive Einträge bekommen ihre Seite in App.tsx, alle anderen die Platzhalterseite.
import {
  AudioLines, Calendar, Folder, Globe, House, Images, type LucideIcon, Newspaper,
  Podcast, Radio, Scissors, ShieldCheck, Upload, UserRoundPlus, Users, Video,
} from "lucide-react";

export type NavStatus = "aktiv" | "tbd" | "spaeter";
export type NavGroupId = "haupt" | "erstellen" | "generieren" | "veroeffentlichen";

export interface NavEntry {
  path: string;        // ohne Basis, beginnt mit "/"
  title: string;
  icon: LucideIcon;
  group: NavGroupId;
  status: NavStatus;
  /** Ein Satz für die Platzhalterseite: was der Bereich einmal tun soll. */
  text: string;
  /** Nur für diese Rolle sichtbar (Route selbst prüft zusätzlich). */
  nur?: "owner";
}

export const NAV_GROUPS: { id: NavGroupId; title: string | null }[] = [
  { id: "haupt", title: null },
  { id: "erstellen", title: "Erstellen" },
  { id: "generieren", title: "Generieren" },
  { id: "veroeffentlichen", title: "Veröffentlichen" },
];

const TBD = "Inhalt und Umfang dieses Bereichs sind noch nicht festgelegt.";

export const NAV: NavEntry[] = [
  { path: "/", title: "Startseite", icon: House, group: "haupt", status: "aktiv", text: "" },
  { path: "/projekte", title: "Projekte", icon: Folder, group: "haupt", status: "aktiv", text: "" },
  { path: "/verwaltung", title: "Verwaltung", icon: ShieldCheck, group: "haupt", status: "aktiv", text: "", nur: "owner" },
  { path: "/planer", title: "Planer", icon: Calendar, group: "haupt", status: "aktiv",
    text: "Episoden und Aufnahmetermine planen." },
  { path: "/studio", title: "Aufnehmen", icon: Video, group: "erstellen", status: "aktiv", text: "" },
  { path: "/hochladen", title: "Hochladen", icon: Upload, group: "erstellen", status: "aktiv", text: "" },
  { path: "/bearbeiten", title: "Bearbeiten", icon: Scissors, group: "erstellen", status: "aktiv",
    text: "Aufnahmen schneiden und zu Episoden zusammenstellen." },
  { path: "/live-stream", title: "Live-Stream", icon: Radio, group: "erstellen", status: "aktiv",
    text: "Eine Aufnahme gleichzeitig live übertragen." },
  { path: "/bild-video", title: "Bild & Video", icon: Images, group: "generieren", status: "tbd", text: TBD },
  { path: "/ai-twins", title: "AI Twins", icon: UserRoundPlus, group: "generieren", status: "tbd", text: TBD },
  { path: "/voice-clones", title: "Voice Clones", icon: AudioLines, group: "generieren", status: "tbd", text: TBD },
  { path: "/webinar", title: "Webinar", icon: Users, group: "veroeffentlichen", status: "spaeter",
    text: "Webinare mit Publikum durchführen." },
  { path: "/hosting", title: "Hosting", icon: Podcast, group: "veroeffentlichen", status: "spaeter",
    text: "Episoden veröffentlichen und als RSS-Feed bereitstellen." },
  { path: "/newsletter", title: "Newsletter", icon: Newspaper, group: "veroeffentlichen", status: "spaeter",
    text: "Neue Episoden per Newsletter ankündigen." },
  { path: "/webseite", title: "Webseite", icon: Globe, group: "veroeffentlichen", status: "spaeter",
    text: "Eine eigene Podcast-Webseite aus den Episoden erzeugen." },
];

/** Öffentliche Kontorouten (ohne Shell, ohne Sitzung) und Konto-Seite (über das Kontomenü). */
export const KONTO_ROUTEN = { anmelden: "/anmelden", einladung: "/einladung/:token?", konto: "/konto" } as const;

export const STATUS_LABEL: Record<Exclude<NavStatus, "aktiv">, string> = { tbd: "TBD", spaeter: "Später" };
