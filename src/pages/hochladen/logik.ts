// Reine Logik für /hochladen (PA8) – ohne React, testbar mit vitest.
import { ApiError, type TrackKind } from "../../lib/api";

/** Abschnittsgröße laut Plattform-Erweiterung §5.6 (Server erlaubt bis 64 MiB). */
export const ABSCHNITT_BYTES = 8 * 1024 * 1024;

/** Dateiendung → Server-MIME-Basis. mp4/webm sind mehrdeutig (Ton oder Video) und werden im Browser geprüft. */
const ENDUNG: Record<string, { mime: string; kind: TrackKind | null }> = {
  mp3: { mime: "audio/mpeg", kind: "audio" },
  wav: { mime: "audio/wav", kind: "audio" },
  m4a: { mime: "audio/mp4", kind: "audio" },
  mp4: { mime: "mp4", kind: null },
  webm: { mime: "webm", kind: null },
};

export const ACCEPT = ".mp3,.wav,.m4a,.mp4,.webm";

export function endung(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Bestimmt MIME-Typ und Spurart. `hatVideo` = Ergebnis der Browserprüfung (null = unbekannt).
 * Liefert null, wenn das Format nicht unterstützt wird (Server-Positivliste `allowed`).
 */
export function medienTyp(name: string, browserTyp: string, hatVideo: boolean | null, allowed: string[]): { mimeType: string; kind: TrackKind } | null {
  const e = ENDUNG[endung(name)];
  if (!e) return null;
  let mimeType = e.mime, kind = e.kind;
  if (!kind) {
    kind = (hatVideo ?? browserTyp.startsWith("video/")) ? "video" : "audio";
    mimeType = `${kind}/${e.mime}`;
  }
  return allowed.includes(mimeType) ? { mimeType, kind } : null;
}

export function abschnittAnzahl(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / ABSCHNITT_BYTES));
}

export function abschnittBereich(i: number, bytes: number): [number, number] {
  return [i * ABSCHNITT_BYTES, Math.min(bytes, (i + 1) * ABSCHNITT_BYTES)];
}

/** Lohnt eine automatische Wiederholung? Netz, Frist, Serverfehler, Drosselung, laufender Vorgänger. */
export function wiederholbar(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.code === "aborted") return false;
  return e.status === 0 || e.status >= 500 || e.status === 429 || e.code === "upload_busy";
}

/** Wartezeiten der automatischen Wiederholungen je Abschnitt; danach stoppt der Upload sichtbar. */
export const WARTEN_MS = [2000, 5000, 15000];

// ───── Inhaltsidentität (R1): SHA-256 je 8-MiB-Abschnitt, Fingerabdruck = SHA-256 über das Manifest ─────
// WebCrypto kennt kein inkrementelles SHA-256; ein Hash je Abschnitt hält höchstens einen Abschnitt im Speicher.

/** WebCrypto verfügbar? Nur in sicherem Kontext (HTTPS/localhost) – wie der Recorder. */
export const pruefungMoeglich = () => typeof crypto !== "undefined" && !!crypto.subtle;

export async function abschnittHash(buf: ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Fingerabdruck einer Datei aus ihren Abschnittshashes; bindet Größe und Abschnittsgröße mit ein. */
export async function manifestHash(size: number, hashes: Uint8Array[]): Promise<string> {
  const kopf = new TextEncoder().encode(`podcast-studio-upload-v2\n${ABSCHNITT_BYTES}\n${size}\n`);
  const all = new Uint8Array(kopf.length + hashes.length * 32);
  all.set(kopf);
  hashes.forEach((h, i) => all.set(h, kopf.length + i * 32));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", all)));
}

export const gleicherHash = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Liest die Datei abschnittweise (je höchstens 8 MiB im Speicher) und berechnet Manifest + Fingerabdruck. */
export async function fingerabdruck(file: Blob, signal: AbortSignal, fortschritt: (done: number, total: number) => void) {
  const total = abschnittAnzahl(file.size), hashes: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    if (signal.aborted) throw new ApiError(0, "aborted", "Abgebrochen.");
    const [a, b] = abschnittBereich(i, file.size);
    hashes.push(await abschnittHash(await file.slice(a, b).arrayBuffer()));
    fortschritt(i + 1, total);
  }
  if (signal.aborted) throw new ApiError(0, "aborted", "Abgebrochen.");
  return { hashes, fingerprint: await manifestHash(file.size, hashes) };
}

// ───── Unterbrochene Uploads (nur Metadaten + Fingerabdruck, die Datei bleibt beim Nutzer) ─────

export interface OffenerUpload {
  trackId: string; projectId: string; title: string;
  name: string; size: number; lastModified: number; createdAt: string;
  /** null = Alt-Eintrag ohne Fingerabdruck: nicht sicher fortsetzbar. */
  fingerprint: string | null; chunkCount: number;
}

const schluessel = (userId: string) => `podcast-studio:${userId}:uploads`;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

/** Vollständige Typ-/Wertprüfung eines gespeicherten Eintrags; alles andere → null. */
export function eintragPruefen(x: unknown): OffenerUpload | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (!(typeof o.trackId === "string" && ID.test(o.trackId) && typeof o.projectId === "string" && ID.test(o.projectId))) return null;
  if (!text(o.title, 500) || !text(o.name, 1000) || !text(o.createdAt, 64) || Number.isNaN(Date.parse(o.createdAt as string))) return null;
  if (!Number.isSafeInteger(o.size) || (o.size as number) < 0 || !Number.isSafeInteger(o.lastModified)) return null;
  const size = o.size as number, chunkCount = abschnittAnzahl(size);
  const basis = {
    trackId: o.trackId, projectId: o.projectId, title: o.title as string, name: o.name as string,
    size, lastModified: o.lastModified as number, createdAt: o.createdAt as string, chunkCount,
  };
  if (o.v === undefined && o.fingerprint === undefined && o.chunkCount === undefined) return { ...basis, fingerprint: null };
  if (o.v !== 2 || o.chunkCount !== chunkCount || typeof o.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(o.fingerprint)) return null;
  return { ...basis, fingerprint: o.fingerprint };
}

/** Gültige Einträge des eigenen Kontos + Zahl verworfener (beschädigter) Einträge. Wirft nie. */
export function offeneLesen(userId: string): { liste: OffenerUpload[]; ungueltig: number } {
  let raw: string | null;
  try { raw = localStorage.getItem(schluessel(userId)); }
  catch { return { liste: [], ungueltig: 0 }; }
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(v)) return { liste: [], ungueltig: 1 };
    const liste: OffenerUpload[] = [];
    for (const x of v) {
      const e = eintragPruefen(x);
      if (e && !liste.some((y) => y.trackId === e.trackId)) liste.push(e);
    }
    return { liste, ungueltig: v.length - liste.length };
  } catch { return { liste: [], ungueltig: 1 }; }
}

/** Schreibt nur den Schlüssel dieses Kontos; ungültige Einträge entfallen dabei. false = nicht gespeichert. */
function offeneSchreiben(userId: string, list: OffenerUpload[]): boolean {
  try {
    if (list.length) localStorage.setItem(schluessel(userId), JSON.stringify(list.map((u) =>
      u.fingerprint ? { v: 2, ...u } : { trackId: u.trackId, projectId: u.projectId, title: u.title, name: u.name, size: u.size, lastModified: u.lastModified, createdAt: u.createdAt })));
    else localStorage.removeItem(schluessel(userId));
    return true;
  } catch { return false; }
}

export function offenMerken(userId: string, u: OffenerUpload): boolean {
  return offeneSchreiben(userId, [u, ...offeneLesen(userId).liste.filter((x) => x.trackId !== u.trackId)].slice(0, 20));
}

export function offenVergessen(userId: string, trackId: string) {
  offeneSchreiben(userId, offeneLesen(userId).liste.filter((x) => x.trackId !== trackId));
}

/** Verwirft beschädigte Einträge dieses Kontos (gültige bleiben). */
export function ungueltigeVerwerfen(userId: string) {
  offeneSchreiben(userId, offeneLesen(userId).liste);
}

export function titelAusDatei(name: string): string {
  return (name.replace(/\.[a-z0-9]+$/i, "").trim() || "Upload").slice(0, 120);
}
