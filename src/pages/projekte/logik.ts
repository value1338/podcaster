// Reine Logik für Projekte/Startseite (AP5/AP6) – ohne React, testbar mit vitest.
import type { Export, ExportFormat, Project, ProjectDetail, Recording, Track } from "../../lib/api";

/** Abschnittslänge der Aufnahme-Engine (Umsetzung §6.1: MediaRecorder.start(4000)). */
export const CHUNK_MS = 4000;
/** Ohne neuen Abschnitt so lange → Spur gilt als „unvollständig“ (Upload abgerissen). */
export const STALE_MS = 2 * 60_000;

export type SpurZustand = "hochladen" | "unvollstaendig" | "verarbeitung" | "bereit" | "fehlgeschlagen";

export function spurZustand(t: Track, now = Date.now()): SpurZustand {
  switch (t.status) {
    case "ready": return "bereit";
    case "processing": return "verarbeitung";
    case "failed": return "fehlgeschlagen";
    case "uploading": {
      const last = t.lastChunkAt ? Date.parse(t.lastChunkAt) : NaN;
      // Noch kein Abschnitt: Startzeit der Aufnahme (Client-Uhr) als Anhaltspunkt.
      const ref = Number.isFinite(last) ? last : t.startedAtMs ?? NaN;
      return Number.isFinite(ref) && now - ref > STALE_MS ? "unvollstaendig" : "hochladen";
    }
  }
}

export const SPUR_TEXT: Record<SpurZustand, string> = {
  hochladen: "Lädt hoch",
  unvollstaendig: "Unvollständig",
  verarbeitung: "Wird verarbeitet",
  bereit: "Bereit",
  fehlgeschlagen: "Fehlgeschlagen",
};

export const SPUR_TON = {
  hochladen: "accent", unvollstaendig: "warn", verarbeitung: "accent", bereit: "ok", fehlgeschlagen: "error",
} as const;

export const EXPORT_TEXT: Record<Export["status"], string> = {
  queued: "Wird vorbereitet", processing: "Wird vorbereitet", ready: "Bereit", failed: "Fehlgeschlagen",
};

export const FORMAT_TEXT: Record<ExportFormat, string> = { mp3: "MP3", wav: "WAV", mp4: "MP4 (H.264)" };

/** Lesbarer Name des Originalformats aus dem MIME-Typ. */
export function originalFormat(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  const codec = /codecs=([^;]+)/i.exec(mime)?.[1]?.replace(/"/g, "");
  if (base === "video/webm") {
    const v = codec?.includes("vp9") ? "VP9" : codec?.includes("vp8") ? "VP8" : codec?.includes("av01") ? "AV1" : codec?.includes("avc1") ? "H.264" : null;
    return v ? `WebM (${v}${codec?.includes("opus") ? "/Opus" : ""})` : "WebM";
  }
  if (base.endsWith("/webm")) return codec?.includes("opus") ? "WebM/Opus" : "WebM";
  if (base === "audio/mp4") return "M4A/AAC";
  if (base === "video/mp4") return codec?.includes("avc1") ? "MP4 (H.264/AAC)" : "MP4";
  return base || "Original";
}

/** Exportformate je Spurart (Umsetzung §6.4). */
export function exportFormate(t: Track): ExportFormat[] {
  return t.kind === "video" ? ["mp4", "mp3", "wav"] : ["mp3", "wav"];
}

/** Neuester Export je Format (Server entdoppelt, nach „Erneut“ gibt es aber alte failed). */
export function letzterExport(t: Track, f: ExportFormat): Export | undefined {
  return t.exports.filter((e) => e.format === f).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Polling nur, solange etwas wirklich läuft (Umsetzung §5). Abgerissene Uploads zählen nicht. */
export function laeuftArbeit(p: Pick<ProjectDetail, "recordings">, now = Date.now()): boolean {
  return p.recordings.some((r) => r.tracks.some((t) => {
    const z = spurZustand(t, now);
    return z === "hochladen" || z === "verarbeitung" || t.exports.some((e) => e.status === "queued" || e.status === "processing");
  }));
}

export type Sortierung = "erstellt" | "name";

export function filterSort(list: (Project & { recordingTitles?: string[] })[], q: string, sort: Sortierung): Project[] {
  const n = q.trim().toLocaleLowerCase("de");
  const out = n ? list.filter((p) => [p.title, ...(p.recordingTitles ?? [])].some((title) => title.toLocaleLowerCase("de").includes(n))) : [...list];
  return out.sort(sort === "name"
    ? (a, b) => a.title.localeCompare(b.title, "de", { sensitivity: "base", numeric: true })
    : (a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Aufnahmedauer = längste bekannte Spurdauer. */
export function aufnahmeDauer(r: Recording): number | null {
  const d = r.tracks.map((t) => t.durationMs).filter((x): x is number => x != null);
  return d.length ? Math.max(...d) : null;
}

/** Schlechtester Spurzustand einer Aufnahme (für Übersichten). */
export function aufnahmeZustand(r: Recording, now = Date.now()): SpurZustand | null {
  const rang: SpurZustand[] = ["fehlgeschlagen", "unvollstaendig", "hochladen", "verarbeitung", "bereit"];
  const z = r.tracks.map((t) => spurZustand(t, now));
  return rang.find((x) => z.includes(x)) ?? null;
}

/** Bergung: lückenloser Anfang, Dauer aus Abschnittszahl geschätzt (maßgeblich danach ffprobe). */
export function bergungsInput(t: Track) {
  return { chunkCount: t.receivedChunks, durationMs: t.receivedChunks * CHUNK_MS, allowPartial: true };
}
