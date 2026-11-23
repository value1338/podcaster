import { describe, expect, it } from "vitest";
import { aktuellePeriode, ausEingabe, einladungsStatus, formatUsd, httpWarnung, PLAN_FELDER, zuEingabe } from "./logik";

describe("PA6 Verwaltungs-Logik", () => {
  it("warnt nur bei http an Nicht-Loopback", () => {
    expect(httpWarnung("http://192.168.1.5:8000/v1")).toBe(true);
    expect(httpWarnung("http://host.docker.internal:9000")).toBe(true);
    for (const ok of ["https://api.example/v1", "http://127.0.0.1:8080", "http://localhost/v1", "http://[::1]:1", "", "kaputt"]) expect(httpWarnung(ok)).toBe(false);
  });
  it("rechnet Planwerte verlustfrei hin und zurück", () => {
    const f = Object.fromEntries(PLAN_FELDER.map((x) => [x.key, x.faktor]));
    expect(zuEingabe(3600, f.asrSecondsMonth)).toBe("60");
    expect(ausEingabe("60", f.asrSecondsMonth)).toBe(3600);
    expect(zuEingabe(10_000_000_000, f.storageBytes)).toBe("10");
    expect(ausEingabe("0,5", f.storageBytes)).toBe(500_000_000);
    expect(ausEingabe("1,25", f.llmCostMicroMonth)).toBe(1_250_000);
    expect(zuEingabe(null, 1)).toBe("");
    expect(ausEingabe("  ", 1)).toBeNull();
    expect(ausEingabe("200 000", 1)).toBe(200000);
  });
  it("weist negative und ungültige Eingaben ab", () => {
    expect(() => ausEingabe("-1", 1)).toThrow();
    expect(() => ausEingabe("abc", 1)).toThrow();
    expect(() => ausEingabe("1e9", 1)).toThrow();
    expect(() => ausEingabe("99999999999999999999", 1)).toThrow(/zu groß/);
  });
  it("leitet den Einladungsstatus ab", () => {
    const basis = { id: "i", email: null, planId: "free", createdAt: "2026-11-01T00:00:00Z" };
    const jetzt = Date.parse("2026-11-20T00:00:00Z");
    expect(einladungsStatus({ ...basis, expiresAt: "2026-11-21T00:00:00Z", usedAt: null }, jetzt)).toBe("offen");
    expect(einladungsStatus({ ...basis, expiresAt: "2026-11-19T00:00:00Z", usedAt: null }, jetzt)).toBe("abgelaufen");
    expect(einladungsStatus({ ...basis, expiresAt: "2026-11-19T00:00:00Z", usedAt: "2026-11-02T00:00:00Z" }, jetzt)).toBe("benutzt");
  });
  it("formatiert Periode und Kosten", () => {
    expect(aktuellePeriode(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
    expect(formatUsd(null)).toBe("unbegrenzt");
    expect(formatUsd(1_500_000)).toMatch(/1,5/);
  });
});
