import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { absoluteUrl, einrichtungFehlt, formatSpeicher, meterText as mt, formatWarten, kennwortProblem, kontoFehlertext, meterAnteil, meterText, meterVoll, nichtBereitgestellt, wartezeit } from "./logik";
import { anmeldePfad, istStudioRaum, sicheresZiel } from "../../lib/sitzung";

describe("PA6 Konto-Logik", () => {
  it("prüft Kennwortlänge und Wiederholung", () => {
    expect(kennwortProblem("kurz", "kurz")).toMatch(/mindestens 10/);
    expect(kennwortProblem("x".repeat(201), "x".repeat(201))).toMatch(/höchstens 200/);
    expect(kennwortProblem("lang-genug-1", "lang-genug-2")).toMatch(/nicht überein/);
    expect(kennwortProblem("lang-genug-1", "lang-genug-1")).toBeNull();
  });
  it("liest Wartezeit aus 429 und formatiert sie", () => {
    expect(wartezeit(new ApiError(429, "rate_limited", "x", { retryAfterS: 125.2 }))).toBe(126);
    expect(wartezeit(new ApiError(401, "invalid_credentials", "x"))).toBeNull();
    expect(formatWarten(30)).toBe("30 s");
    expect(formatWarten(61)).toBe("2 Minuten");
    expect(kontoFehlertext(new ApiError(401, "invalid_credentials", "x"))).toBe("E-Mail oder Kennwort ist falsch.");
    expect(kontoFehlertext(new ApiError(404, "token_invalid", "x"))).toMatch(/ungültig, abgelaufen/);
  });
  it("erkennt nicht bereitgestellte Endpunkte nur an 404 not_found", () => {
    expect(nichtBereitgestellt(new ApiError(404, "not_found", "x"))).toBe(true);
    expect(nichtBereitgestellt(new ApiError(404, "token_invalid", "x"))).toBe(false);
    expect(nichtBereitgestellt(new ApiError(500, "internal_error", "x"))).toBe(false);
  });
  it("liest fehlende Einstellungen aus configuration_required", () => {
    expect(einrichtungFehlt(new ApiError(503, "configuration_required", "x", { service: "archive", missing: ["STUDIO_ARCHIVE_DRIVER"] }))).toEqual(["STUDIO_ARCHIVE_DRIVER"]);
    expect(einrichtungFehlt(new ApiError(404, "not_found", "x"))).toBeNull();
  });
  it("rechnet Zähler inklusive Reservierung", () => {
    const m = { used: 1800, reserved: 600, limit: 3600 };
    expect(meterAnteil(m)).toBeCloseTo(2 / 3);
    expect(meterText(m, "sekunden")).toBe("40 min von 60 min");
    expect(meterVoll(m)).toBe(false);
    expect(meterVoll({ used: 3000, reserved: 600, limit: 3600 })).toBe(true);
    expect(meterAnteil({ used: 5, reserved: 0, limit: null })).toBeNull();
    expect(meterText({ used: 5, reserved: 0, limit: null }, "anzahl")).toBe("5 · unbegrenzt");
    expect(meterAnteil({ used: 9, reserved: 0, limit: 3 })).toBe(1);
  });
  it("zeigt Speicher dezimal wie die Planwerte", () => {
    expect(formatSpeicher(200_000_000_000)).toBe("200 GB");
    expect(formatSpeicher(1_500_000)).toBe("1,5 MB");
    expect(formatSpeicher(999)).toBe("999 B");
    expect(mt({ used: 0, reserved: 0, limit: 10_000_000_000 }, "bytes")).toBe("0 B von 10 GB");
  });
  it("macht Links absolut", () => {
    expect(absoluteUrl("/podcast/einladung/abc", "https://h.example")).toBe("https://h.example/podcast/einladung/abc");
  });
  it("lässt nur eigene Rücksprungziele zu", () => {
    expect(sicheresZiel("/projekte?q=a")).toBe("/projekte?q=a");
    for (const böse of ["//evil.example", "https://evil.example", "/\\evil", "/anmelden", "/einladung/x", null, ""]) expect(sicheresZiel(böse)).toBe("/");
    expect(anmeldePfad("/konto", "kennwort")).toBe("/anmelden?weiter=%2Fkonto&grund=kennwort");
    expect(anmeldePfad("/", undefined)).toBe("/anmelden");
  });
  it("erkennt den Studioraum (dort kein Redirect bei Sitzungsablauf)", () => {
    expect(istStudioRaum("/studio/1234")).toBe(true);
    expect(istStudioRaum("/studio")).toBe(false);
    expect(istStudioRaum("/projekte/1")).toBe(false);
  });
});
