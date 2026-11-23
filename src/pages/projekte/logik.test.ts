import { describe, expect, it } from "vitest";
import type { Export, Project, Track } from "../../lib/api";
import { aufnahmeZustand, bergungsInput, filterSort, laeuftArbeit, letzterExport, originalFormat, spurZustand, STALE_MS } from "./logik";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const track = (o: Partial<Track> = {}): Track => ({
  id: "t", recordingId: "r", participantName: "Ich", kind: "audio", source: "studio", mimeType: "audio/webm;codecs=opus",
  status: "ready", error: null, receivedChunks: 3, bytes: 1, durationMs: 12000, width: null, height: null, sha256: null,
  startedAtMs: NOW - 60_000, lastChunkAt: iso(1000), hasRaw: false, exports: [], ...o,
});
const exp = (o: Partial<Export>): Export => ({
  id: "e", trackId: "t", format: "mp3", status: "ready", error: null, bytes: null, createdAt: iso(0), finishedAt: null, ...o,
});
const proj = (title: string, createdAt: string): Project => ({ id: title, title, createdAt, recordingCount: 0, lastRecordingAt: null });

describe("spurZustand", () => {
  it("bildet Serverstatus ab", () => {
    expect(spurZustand(track(), NOW)).toBe("bereit");
    expect(spurZustand(track({ status: "processing" }), NOW)).toBe("verarbeitung");
    expect(spurZustand(track({ status: "failed" }), NOW)).toBe("fehlgeschlagen");
  });
  it("unterscheidet laufenden und abgerissenen Upload", () => {
    expect(spurZustand(track({ status: "uploading" }), NOW)).toBe("hochladen");
    expect(spurZustand(track({ status: "uploading", lastChunkAt: iso(STALE_MS + 1) }), NOW)).toBe("unvollstaendig");
    expect(spurZustand(track({ status: "uploading", lastChunkAt: null, startedAtMs: NOW - STALE_MS - 1 }), NOW)).toBe("unvollstaendig");
    expect(spurZustand(track({ status: "uploading", lastChunkAt: null, startedAtMs: null }), NOW)).toBe("hochladen");
  });
});

describe("laeuftArbeit (Polling)", () => {
  const p = (...tracks: Track[]) => ({ recordings: [{ id: "r", projectId: "p", title: "A", createdAt: iso(0), tracks }] });
  it("pollt nur bei laufender Arbeit", () => {
    expect(laeuftArbeit(p(track()), NOW)).toBe(false);
    expect(laeuftArbeit(p(track({ status: "processing" })), NOW)).toBe(true);
    expect(laeuftArbeit(p(track({ status: "uploading" })), NOW)).toBe(true);
    expect(laeuftArbeit(p(track({ status: "uploading", lastChunkAt: iso(STALE_MS * 2) })), NOW)).toBe(false);
    expect(laeuftArbeit(p(track({ exports: [exp({ status: "queued" })] })), NOW)).toBe(true);
    expect(laeuftArbeit(p(track({ exports: [exp({ status: "failed" })] })), NOW)).toBe(false);
    expect(laeuftArbeit({ recordings: [] }, NOW)).toBe(false);
  });
});

describe("filterSort", () => {
  const list = [proj("Folge 10", iso(1000)), proj("ägypten", iso(3000)), proj("Folge 2", iso(2000))];
  it("sortiert nach Erstellung und Name (deutsch, numerisch)", () => {
    expect(filterSort(list, "", "erstellt").map((p) => p.title)).toEqual(["Folge 10", "Folge 2", "ägypten"]);
    expect(filterSort(list, "", "name").map((p) => p.title)).toEqual(["ägypten", "Folge 2", "Folge 10"]);
  });
  it("filtert ohne Groß-/Kleinschreibung", () => {
    expect(filterSort(list, "  folge ", "name").map((p) => p.title)).toEqual(["Folge 2", "Folge 10"]);
    expect(filterSort(list, "xyz", "name")).toEqual([]);
  });
  it("findet ein Projekt auch über den Titel einer enthaltenen Aufnahme", () => {
    const interview = { ...proj("Meine Serie", iso(0)), recordingTitles: ["Gespräch mit Anna", "Technik"] };
    expect(filterSort([...list, interview], "  ANNA ", "name").map((p) => p.title)).toEqual(["Meine Serie"]);
    expect(filterSort([interview], "unbekannt", "name")).toEqual([]);
  });
});

describe("Hilfen", () => {
  it("neuester Export je Format", () => {
    const t = track({ exports: [exp({ id: "alt", status: "failed", createdAt: iso(5000) }), exp({ id: "neu", status: "queued", createdAt: iso(0) })] });
    expect(letzterExport(t, "mp3")?.id).toBe("neu");
    expect(letzterExport(t, "wav")).toBeUndefined();
  });
  it("Originalformat", () => {
    expect(originalFormat("audio/webm;codecs=opus")).toBe("WebM/Opus");
    expect(originalFormat("audio/mp4")).toBe("M4A/AAC");
    expect(originalFormat("video/webm;codecs=vp9,opus")).toBe("WebM (VP9/Opus)");
    expect(originalFormat("video/webm;codecs=vp8,opus")).toBe("WebM (VP8/Opus)");
    expect(originalFormat("video/mp4;codecs=avc1.42E01E,mp4a.40.2")).toBe("MP4 (H.264/AAC)");
  });
  it("schlechtester Aufnahmezustand und Bergung", () => {
    const r = { id: "r", projectId: "p", title: "A", createdAt: iso(0), tracks: [track(), track({ status: "failed" })] };
    expect(aufnahmeZustand(r, NOW)).toBe("fehlgeschlagen");
    expect(bergungsInput(track({ receivedChunks: 5 }))).toEqual({ chunkCount: 5, durationMs: 20000, allowPartial: true });
  });
});
