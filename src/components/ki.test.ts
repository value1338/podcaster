import { describe, expect, it } from "vitest";
import { ApiError, type Job } from "../lib/api";
import { AUFGABEN, AUFGABEN_REIHE, DATEN_TEXT, evtlBezahlt, gleicheEingabe, kiSchluessel, kiZustand, laeuft, startFehlerText, zeitmarke, type KiJob } from "./ki";

const job = (p: Partial<KiJob>): KiJob => ({
  id: "j", kind: "llm", status: "queued", subject: { type: "project", id: "p" }, progress: null, attempts: 0, nextAttemptAt: null,
  errorCode: null, errorMessage: null, result: null, createdAt: "", startedAt: null, finishedAt: null, ...p,
} as Job);

describe("Text-KI-Logik (PA9)", () => {
  it("nur Vertrags-Aufgaben, Datenumfang ohne Audio/Video", () => {
    expect(AUFGABEN_REIHE.sort()).toEqual(Object.keys(AUFGABEN).sort());
    expect(AUFGABEN_REIHE).toHaveLength(6);
    for (const t of Object.values(DATEN_TEXT)) expect(t).toContain("kein Audio, kein Video");
  });

  it("Zustände ehrlich: wartet/unklar/unterbrochen/abgebrochen", () => {
    expect(kiZustand(job({}))).toBe("eingereiht");
    expect(kiZustand(job({ nextAttemptAt: "2026-11-20T10:00:00Z" }))).toBe("wartet");
    expect(kiZustand(job({ status: "running" }))).toBe("laeuft");
    expect(kiZustand(job({ status: "succeeded" }))).toBe("fertig");
    expect(kiZustand(job({ status: "canceled" }))).toBe("abgebrochen");
    expect(kiZustand(job({ status: "failed", errorCode: "llm_unclear", unclear: true }))).toBe("unklar");
    expect(kiZustand(job({ status: "failed", errorCode: "interrupted", unclear: true }))).toBe("unterbrochen");
    expect(kiZustand(job({ status: "failed", errorCode: "llm_bad_response" }))).toBe("fehlgeschlagen");
    expect(laeuft(job({ status: "running" }))).toBe(true);
    expect(laeuft(job({ status: "failed" }))).toBe(false);
  });

  it("möglicherweise bezahlt nur bei unklar/unterbrochen", () => {
    expect(evtlBezahlt(job({ status: "failed", errorCode: "llm_unclear" }))).toBe(true);
    expect(evtlBezahlt(job({ status: "failed", errorCode: "interrupted" }))).toBe(true);
    expect(evtlBezahlt(job({ status: "failed", errorCode: "llm_bad_response" }))).toBe(false);
    expect(evtlBezahlt(job({ status: "running", unclear: true }))).toBe(false);
    expect(evtlBezahlt(job({ status: "canceled", usageEstimated: true }))).toBe(true);
    expect(evtlBezahlt(job({ status: "canceled" }))).toBe(false);
  });

  it("Fehlertexte, Zeitmarken, Schlüssel, Eingabevergleich", () => {
    expect(startFehlerText(new ApiError(402, "quota_exceeded", "x", { scope: "platform" }))).toContain("Plattform-Deckel");
    expect(startFehlerText(new ApiError(503, "configuration_required", "x", { missing: ["OPENAI_API_KEY"] }))).toContain("OPENAI_API_KEY");
    expect(startFehlerText(new ApiError(400, "consent_required", "x"))).toContain("nichts gesendet");
    expect(zeitmarke(3_723_400)).toBe("01:02:03");
    expect(zeitmarke(0)).toBe("00:00:00");
    const k = kiSchluessel();
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(kiSchluessel()).not.toBe(k);
    expect(gleicheEingabe({ task: "titles", trackId: "t" }, { task: "titles", trackId: "t" })).toBe(true);
    expect(gleicheEingabe({ task: "titles", trackId: "t" }, { task: "titles", trackId: "u" })).toBe(false);
    expect(gleicheEingabe({ task: "producer_outline", brief: "a" }, null)).toBe(false);
  });
});
