import { createHash } from "node:crypto"; // nur Test-Gegenprobe (Node); Produktcode nutzt WebCrypto
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import {
  ABSCHNITT_BYTES, abschnittAnzahl, abschnittBereich, eintragPruefen, fingerabdruck, medienTyp, offeneLesen, offenMerken,
  offenVergessen, titelAusDatei, ungueltigeVerwerfen, wiederholbar, type OffenerUpload,
} from "./logik";

const ALLE = ["audio/webm", "audio/mp4", "video/webm", "video/mp4", "audio/mpeg", "audio/wav"];

describe("medienTyp", () => {
  it("bildet Endungen auf Server-MIME ab, unabhängig vom Browsertyp", () => {
    expect(medienTyp("a.MP3", "", null, ALLE)).toEqual({ mimeType: "audio/mpeg", kind: "audio" });
    expect(medienTyp("a.wav", "audio/x-wav", null, ALLE)).toEqual({ mimeType: "audio/wav", kind: "audio" });
    expect(medienTyp("a.m4a", "audio/x-m4a", null, ALLE)).toEqual({ mimeType: "audio/mp4", kind: "audio" });
  });
  it("mp4/webm: Browserprüfung entscheidet, sonst Browsertyp", () => {
    expect(medienTyp("a.mp4", "video/mp4", false, ALLE)).toEqual({ mimeType: "audio/mp4", kind: "audio" });
    expect(medienTyp("a.mp4", "", true, ALLE)).toEqual({ mimeType: "video/mp4", kind: "video" });
    expect(medienTyp("a.webm", "video/webm", null, ALLE)).toEqual({ mimeType: "video/webm", kind: "video" });
  });
  it("lehnt Unbekanntes und nicht freigegebene Typen ab", () => {
    expect(medienTyp("a.ogg", "audio/ogg", null, ALLE)).toBeNull();
    expect(medienTyp("a.mp3", "audio/mpeg", null, ["audio/wav"])).toBeNull();
  });
});

describe("Abschnitte", () => {
  it("teilt in 8 MiB und deckt die Datei lückenlos ab", () => {
    const n = 3 * ABSCHNITT_BYTES + 5;
    expect(abschnittAnzahl(n)).toBe(4);
    expect(abschnittAnzahl(ABSCHNITT_BYTES)).toBe(1);
    expect(abschnittAnzahl(1)).toBe(1);
    let pos = 0;
    for (let i = 0; i < 4; i++) { const [a, b] = abschnittBereich(i, n); expect(a).toBe(pos); pos = b; }
    expect(pos).toBe(n);
  });
});

describe("wiederholbar", () => {
  it("nur Netz/5xx/429/upload_busy, nie Abbruch oder fachliche Fehler", () => {
    expect(wiederholbar(new ApiError(0, "network", ""))).toBe(true);
    expect(wiederholbar(new ApiError(0, "timeout", ""))).toBe(true);
    expect(wiederholbar(new ApiError(503, "x", ""))).toBe(true);
    expect(wiederholbar(new ApiError(409, "upload_busy", ""))).toBe(true);
    expect(wiederholbar(new ApiError(0, "aborted", ""))).toBe(false);
    expect(wiederholbar(new ApiError(413, "too_large", ""))).toBe(false);
    expect(wiederholbar(new ApiError(402, "quota_exceeded", ""))).toBe(false);
    expect(wiederholbar(new Error("x"))).toBe(false);
  });
});

it("titelAusDatei", () => {
  expect(titelAusDatei("Folge 3.final.mp3")).toBe("Folge 3.final");
  expect(titelAusDatei(".mp3")).toBe("Upload");
});

// ───── R1: Inhaltsidentität ─────
const M = ABSCHNITT_BYTES;
const datei = (n: number, aendern?: (b: Uint8Array) => void) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 13)) & 255;
  aendern?.(b);
  return new Blob([b]);
};
const fp = (b: Blob) => fingerabdruck(b, new AbortController().signal, () => {});

describe("fingerabdruck", () => {
  it("SHA-256 je 8-MiB-Abschnitt (Gegenprobe Node) und stabiler Gesamtwert", async () => {
    const b = datei(2 * M + 77);
    const { hashes, fingerprint } = await fp(b);
    expect(hashes).toHaveLength(3);
    const roh = new Uint8Array(await b.arrayBuffer());
    expect(Buffer.from(hashes[2]).toString("hex")).toBe(createHash("sha256").update(roh.subarray(2 * M)).digest("hex"));
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await fp(datei(2 * M + 77))).fingerprint).toBe(fingerprint);
  });
  it("gleiche Größe, nur hinten (letzter Abschnitt) ein anderes Byte → anderer Fingerabdruck, erster Abschnitt gleich", async () => {
    const a = await fp(datei(3 * M - 5));
    const b = await fp(datei(3 * M - 5, (x) => { x[x.length - 1] ^= 1; }));
    expect(Buffer.from(a.hashes[0]).equals(Buffer.from(b.hashes[0]))).toBe(true);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });
  it("leere Datei hat einen Abschnitt; Abbruch wirft aborted", async () => {
    expect((await fp(new Blob([]))).hashes).toHaveLength(1);
    const ac = new AbortController(); ac.abort();
    await expect(fingerabdruck(datei(10), ac.signal, () => {})).rejects.toMatchObject({ code: "aborted" });
  });
});

// ───── R2: Validierung lokaler Resume-Einträge ─────
const gut: OffenerUpload = {
  trackId: "6a1c2f1e-0000-4000-8000-000000000001", projectId: "p-1", title: "Folge", name: "a.wav", size: 3 * M - 5,
  lastModified: 1700000000000, createdAt: "2026-11-20T10:00:00.000Z", fingerprint: "a".repeat(64), chunkCount: 3,
};
const gespeichert = { v: 2, ...gut };

describe("eintragPruefen", () => {
  it("akzeptiert vollständige v2-Einträge und Alt-Einträge (ohne Fingerabdruck → nicht fortsetzbar)", () => {
    expect(eintragPruefen(gespeichert)).toEqual(gut);
    const { v: _v, fingerprint: _f, chunkCount: _c, ...alt } = gespeichert;
    expect(eintragPruefen(alt)).toEqual({ ...gut, fingerprint: null });
  });
  it.each([
    ["kein Objekt", null], ["Array", []], ["Titel Objekt", { ...gespeichert, title: { bad: true } }],
    ["Titel leer", { ...gespeichert, title: "" }], ["Name Zahl", { ...gespeichert, name: 5 }],
    ["trackId mit /", { ...gespeichert, trackId: "../x" }], ["projectId fehlt", { ...gespeichert, projectId: undefined }],
    ["Größe negativ", { ...gespeichert, size: -1 }], ["Größe Bruch", { ...gespeichert, size: 1.5 }],
    ["Größe Text", { ...gespeichert, size: "10" }], ["Größe unendlich", { ...gespeichert, size: Infinity }],
    ["mtime NaN", { ...gespeichert, lastModified: NaN }], ["Datum kaputt", { ...gespeichert, createdAt: "gestern" }],
    ["chunkCount falsch", { ...gespeichert, chunkCount: 2 }], ["Fingerabdruck kurz", { ...gespeichert, fingerprint: "abc" }],
    ["Fingerabdruck groß", { ...gespeichert, fingerprint: "A".repeat(64) }], ["Version falsch", { ...gespeichert, v: 1 }],
    ["halber v2 ohne v", { ...gespeichert, v: undefined }],
  ])("verwirft %s", (_n, x) => { expect(eintragPruefen(x)).toBeNull(); });
});

describe("offeneLesen/-Schreiben (localStorage)", () => {
  let speicher: Map<string, string>;
  beforeEach(() => {
    speicher = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => speicher.get(k) ?? null, setItem: (k: string, v: string) => void speicher.set(k, v),
      removeItem: (k: string) => void speicher.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("beschädigte Einträge werden gezählt, nicht gerendert; Verwerfen berührt nur das eigene Konto", () => {
    const fremd = JSON.stringify([{ trackId: "x", title: { bad: true } }]);
    speicher.set("podcast-studio:B:uploads", fremd);
    speicher.set("podcast-studio:A:uploads", JSON.stringify([{ trackId: "x", title: { bad: true }, name: "x" }, gespeichert, gespeichert]));
    expect(offeneLesen("A")).toEqual({ liste: [gut], ungueltig: 2 });
    ungueltigeVerwerfen("A");
    expect(offeneLesen("A")).toEqual({ liste: [gut], ungueltig: 0 });
    expect(speicher.get("podcast-studio:B:uploads")).toBe(fremd);
  });
  it("kein Array / kaputtes JSON stürzt nicht ab", () => {
    speicher.set("podcast-studio:A:uploads", "{\"a\":1}");
    expect(offeneLesen("A")).toEqual({ liste: [], ungueltig: 1 });
    speicher.set("podcast-studio:A:uploads", "{kaputt");
    expect(offeneLesen("A")).toEqual({ liste: [], ungueltig: 1 });
    speicher.set("podcast-studio:B:uploads", "fremd-unveraendert");
    ungueltigeVerwerfen("A");
    expect(speicher.has("podcast-studio:A:uploads")).toBe(false);
    expect(speicher.get("podcast-studio:B:uploads")).toBe("fremd-unveraendert");
  });
  it("Merken/Vergessen: Rundreise inkl. Fingerabdruck; voller Speicher meldet false", () => {
    expect(offenMerken("A", gut)).toBe(true);
    expect(offeneLesen("A").liste).toEqual([gut]);
    offenVergessen("A", gut.trackId);
    expect(speicher.has("podcast-studio:A:uploads")).toBe(false);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); }, removeItem() {} });
    expect(offenMerken("A", gut)).toBe(false);
  });
});
