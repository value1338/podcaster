// Reine Hilfsfunktionen der Aufnahme-Engine (AP3): Formatwahl, Browsergrenzen, Fehlerzuordnung.
import type { StudioPhase } from "./types";

/** Reihenfolge nach Umsetzung.md §6.2 – Auswahl zur Laufzeit, keine Versionsannahmen. */
export const AUDIO_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"] as const;

/** Video (AP9): VP9 → VP8 → MP4/H.264 – ebenfalls zur Laufzeit geprüft. */
export const VIDEO_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4",
] as const;

/** Ziel-Videobitrate (Umsetzung §6.2): 8 Mbit/s ab 1080p, sonst 5 Mbit/s. Der Browser darf abweichen. */
export function videoBitrate(height: number | null): number {
  return (height ?? 0) >= 1000 ? 8_000_000 : 5_000_000;
}

/**
 * Obergrenze für vom Server noch nicht bestätigte Abschnitte im Arbeitsspeicher (Rettungs-Map).
 * ponytail: feste Grenze mit kontrolliertem Stopp (Video 8 Mbit/s ≈ 8–9 min Offline-Zeit, Audio ≈ 4 h).
 * Upgrade-Pfad bei Bedarf längerer Offline-Zeiten: Queue lädt lokal gesicherte Abschnitte aus IndexedDB nach.
 */
export const RAM_PUFFER_MAX_BYTES = 512 * 1024 ** 2;

export function pickMimeType(isTypeSupported: (t: string) => boolean, candidates: readonly string[] = AUDIO_MIME_CANDIDATES): string | null {
  for (const t of candidates) {
    try { if (isTypeSupported(t)) return t; } catch { /* manche Browser werfen bei unbekannten Typen */ }
  }
  return null;
}

/**
 * Safari/WebKit (inkl. aller iOS-Browser): Abschnittsaufnahme ist in AP3 NICHT nachgewiesen
 * (kein WebKit auf der VM). Bis ein Test auf echtem Gerät vorliegt, gilt Stufe 1 dort als nicht unterstützt.
 */
export const SAFARI_FREIGEGEBEN = false;

export function istWebkitSafari(ua: string, maxTouchPoints = 0): boolean {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  if (ios) return true; // alle iOS-Browser nutzen WebKit
  return /AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua);
}

/** getUserMedia-Fehler → Studio-Zustand (Scope §7). */
export function mapMediaError(e: unknown): { phase: StudioPhase; code: string; message: string } {
  const name = (e as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return { phase: "verweigert", code: "verweigert", message: "Der Browser hat den Zugriff auf das Mikrofon verweigert." };
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return { phase: "kein-geraet", code: "kein_geraet", message: "Es wurde kein Mikrofon gefunden." };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return { phase: "geraet-belegt", code: "geraet_belegt", message: "Das Mikrofon wird gerade von einer anderen App verwendet oder ist blockiert." };
    default:
      return {
        phase: "geraet-belegt", code: "mikrofon_fehler",
        message: `Das Mikrofon konnte nicht geöffnet werden (${name || "unbekannter Fehler"}).`,
      };
  }
}

/** Kamera-Fehler – getrennt vom Mikrofon, damit Audio weiter möglich bleibt. */
export function mapCameraError(e: unknown): { code: string; message: string } {
  const name = (e as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return { code: "kamera_verweigert", message: "Der Browser hat den Zugriff auf die Kamera verweigert." };
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return { code: "kamera_kein_geraet", message: "Es wurde keine Kamera gefunden." };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return { code: "kamera_belegt", message: "Die Kamera wird gerade von einer anderen App verwendet oder ist blockiert." };
    default:
      return { code: "kamera_fehler", message: `Die Kamera konnte nicht geöffnet werden (${name || "unbekannter Fehler"}).` };
  }
}

/** Wiederholbare Upload-Fehler: Netz, Abbruch/Zeitlimit, Server überlastet, Sitzung fehlt (PA7). Alles andere ist endgültig. */
export function istWiederholbar(e: unknown): boolean {
  const err = e as { status?: number; code?: string };
  if (typeof err?.status !== "number") return true; // unbekannter Fehler (z. B. TypeError) → wie Netz behandeln
  if (err.code === "upload_busy") return true; // API.md 2026-11-20 (AP1): paralleler Schreibzugriff → wiederholen
  // 401 (V §11): Sitzung abgelaufen → Abschnitte bleiben lokal, Senden wartet auf erneute Anmeldung.
  return err.status === 0 || err.status === 401 || err.status === 408 || err.status === 429 || err.status >= 500;
}

/** Fehler bedeutet „erst wieder anmelden“ (Sitzung fehlt oder Konto im Browser gewechselt). */
export function brauchtAnmeldung(e: unknown): boolean {
  return (e as { status?: number })?.status === 401;
}

/** Wartezeit vor Versuch n (0-basiert): 1 s, 2 s, 4 s … max. 30 s (Umsetzung.md §6.1). */
export function backoffMs(versuch: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(versuch, 5));
}

/** Fristen (F2): Statusabfragen, Abschluss/Abschnitt, lokaler Speicher. */
export const STATUS_FRIST_MS = 20_000;
export const SENDE_FRIST_MS = 60_000;
export const IDB_FRIST_MS = 10_000;

/** Echter Abbruch der Anfrage nach `ms` (bricht den fetch ab, nicht nur das Warten). */
export function frist(ms: number): AbortSignal {
  // ponytail: statt AbortSignal.timeout – gleiche Wirkung, überall vorhanden und mit Test-Uhren prüfbar.
  const c = new AbortController();
  setTimeout(() => c.abort(new DOMException("Frist abgelaufen", "TimeoutError")), ms);
  return c.signal;
}

/**
 * Wartet höchstens `ms` auf eine lokale Speicheroperation (IndexedDB lässt sich nicht abbrechen).
 * Läuft die Frist ab, gilt die Operation als fehlgeschlagen; ein spätes Gelingen schadet nicht.
 */
export function mitFrist<T>(p: Promise<T>, ms: number = IDB_FRIST_MS): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new DOMException("Lokaler Speicher antwortet nicht", "TimeoutError")), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}
