import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatResolution, plural } from "./format";
import { NAV } from "../nav";

describe("format", () => {
  it("formatDuration", () => {
    expect(formatDuration(76_000)).toBe("00:01:16");
    expect(formatDuration(3_600_999)).toBe("01:00:00");
    expect(formatDuration(null)).toBe("–");
    expect(formatDuration(-1)).toBe("–");
  });
  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(115 * 1024 ** 2)).toBe("115 MB");
    expect(formatBytes(undefined)).toBe("–");
  });
  it("formatResolution/plural", () => {
    expect(formatResolution(1280, 720)).toBe("1280×720");
    expect(formatResolution(null, 720)).toBe("");
    expect(plural(1, "Aufnahme", "Aufnahmen")).toBe("1 Aufnahme");
  });
});

describe("nav", () => {
  it("Pfade eindeutig, TBD genau Bild & Video / AI Twins / Voice Clones", () => {
    expect(new Set(NAV.map((n) => n.path)).size).toBe(NAV.length);
    expect(NAV.filter((n) => n.status === "tbd").map((n) => n.path)).toEqual(["/bild-video", "/ai-twins", "/voice-clones"]);
    expect(NAV.filter((n) => n.status !== "aktiv").every((n) => n.text.length > 0)).toBe(true);
  });
});
