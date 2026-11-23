import { describe, expect, it } from "vitest";
import { ApiError, type Capabilities, type Job, type Track, type TranscriptSegment } from "../../lib/api";
import { asrRest, asrSekunden, exportGenauigkeit, fehlerText, patchSegmente, segmentBei, startFehlerText, transkriptZustand, zeitmarke, neuerSchluessel } from "./transkript";

const asr = (state: Capabilities["asr"]["state"]): Capabilities["asr"] =>
  ({ state, model: null, device: null, timestamps: null, diarization: false, missing: state === "ready" ? [] : ["STUDIO_ASR_DRIVER"] });
const spur = (status: string, jobId: string | null = "j1") =>
  ({ id: "t", durationMs: 61_500, transcription: { status, jobId, edited: false, updatedAt: null } }) as unknown as Track;
const job = (p: Partial<Job>) => ({ id: "j1", status: "queued", nextAttemptAt: null, errorCode: null, ...p }) as Job;

describe("transkriptZustand", () => {
  it("ohne Dienst: Einrichtung fehlt / nicht erreichbar, aber vorhandenes Transkript bleibt fertig", () => {
    expect(transkriptZustand(spur("none", null), null, asr("configuration_required"))).toBe("einrichtung");
    expect(transkriptZustand(spur("none", null), null, asr("unavailable"))).toBe("nicht_erreichbar");
    expect(transkriptZustand(spur("ready"), null, asr("configuration_required"))).toBe("fertig");
    expect(transkriptZustand(spur("none", null), null, asr("ready"))).toBe("keins");
  });
  it("Auftragszustände", () => {
    expect(transkriptZustand(spur("queued"), job({}), null)).toBe("eingereiht");
    expect(transkriptZustand(spur("queued"), job({ nextAttemptAt: "2026-11-20T12:00:00Z" }), null)).toBe("wartet");
    expect(transkriptZustand(spur("running"), job({ status: "running" }), null)).toBe("laeuft");
    expect(transkriptZustand(spur("failed"), job({ status: "failed" }), null)).toBe("fehlgeschlagen");
    expect(transkriptZustand(spur("failed"), job({ status: "canceled" }), null)).toBe("abgebrochen");
    // frischer Auftrag schlägt veraltete Projektansicht
    expect(transkriptZustand(spur("running"), job({ status: "queued", nextAttemptAt: "x" }), null)).toBe("wartet");
    expect(transkriptZustand(spur("running"), job({ status: "canceled" }), null)).toBe("abgebrochen");
    // fremder (veralteter) Auftrag zählt nicht
    expect(transkriptZustand(spur("queued"), job({ id: "alt", nextAttemptAt: "x" }), null)).toBe("eingereiht");
  });
});

it("Abrechnung wie Server: ceil(Sekunden); Rest aus Kontingent", () => {
  expect(asrSekunden(61_500)).toBe(62);
  expect(asrSekunden(null)).toBe(0);
  const m = { used: 100, reserved: 20, limit: 3600 };
  const u = { asrSeconds: m } as never;
  expect(asrRest(u)).toBe(3480);
  expect(asrRest({ asrSeconds: { ...m, limit: null } } as never)).toBeNull();
});

it("segmentBei: binäre Suche, auch vor dem ersten Segment und am Ende", () => {
  const s = Array.from({ length: 900 }, (_, i) => ({ startMs: i * 4000 }));
  expect(segmentBei(s, -1)).toBe(-1);
  expect(segmentBei(s, 0)).toBe(0);
  expect(segmentBei(s, 3999)).toBe(0);
  expect(segmentBei(s, 4000)).toBe(1);
  expect(segmentBei(s, 10_000_000)).toBe(899);
  expect(segmentBei([], 5)).toBe(-1);
});

it("zeitmarke", () => {
  expect(zeitmarke(65_000)).toBe("1:05");
  expect(zeitmarke(3_725_000)).toBe("1:02:05");
});

it("exportGenauigkeit: SRT/VTT nur mit Zeitstempeln", () => {
  const seg = (edited: boolean) => ({ edited }) as TranscriptSegment;
  expect(exportGenauigkeit({ timestamps: "none", segments: [] }).untertitel).toBe(false);
  expect(exportGenauigkeit({ timestamps: "segment", segments: [] }).text).toMatch(/geschätzt/);
  expect(exportGenauigkeit({ timestamps: "word", segments: [seg(false)] }).text).not.toMatch(/proportional/);
  expect(exportGenauigkeit({ timestamps: "word", segments: [seg(true)] }).text).toMatch(/proportional/);
});

it("patchSegmente sendet alle IDs", () => {
  const segs = [{ id: "s1", text: "a" }, { id: "s2", text: "b" }] as TranscriptSegment[];
  expect(patchSegmente(segs, new Map([["s2", "B"]]))).toEqual([{ id: "s1", text: "a" }, { id: "s2", text: "B" }]);
});

it("startFehlerText: Kontingent, Einrichtung, neuer Auftrag", () => {
  expect(startFehlerText(new ApiError(402, "quota_exceeded", "", { used: 3000, reserved: 0, limit: 3600, requested: 900, scope: "account" })))
    .toMatch(/benötigt 15 Min\., belegt 50 von 60 Min\./);
  expect(startFehlerText(new ApiError(503, "configuration_required", "", { missing: ["STUDIO_ASR_URL"] }))).toMatch(/STUDIO_ASR_URL/);
  expect(startFehlerText(new ApiError(409, "new_job_required", ""))).toMatch(/neuen Auftrag/);
});

it("neuerSchluessel passt zum Server-Format", () => {
  const k = neuerSchluessel();
  expect(k).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  expect(k).not.toBe(neuerSchluessel());
});

it("transcript_edited nennt auch die neuere Zwischenbearbeitung (R7 trotz bestätigtem Ersetzen)", () => {
  expect(fehlerText("transcript_edited")).toMatch(/neuere Bearbeitung/);
  expect(fehlerText("transcript_edited")).toMatch(/bleibt erhalten/);
});
