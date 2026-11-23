// Öffentliche Typen der Aufnahme-Engine – Vertrag Umsetzung.md §7 (plus kompatible Ergänzungen, im AP3-Bericht genannt).
import type { ApiClient, Track } from "../api";

export type StudioPhase =
  | "unsicher" | "nicht-unterstuetzt" | "anfrage" | "verweigert" | "kein-geraet" | "geraet-belegt"
  | "bereit" | "countdown" | "aufnahme" | "abschluss" | "verarbeitung" | "fertig" | "fehler-abschluss";

/** Kamera (AP9). Getrennt vom Mikrofon: ein Kamerafehler lässt die Audioaufnahme unberührt. */
export interface KameraStand {
  /** Unterstütztes Videoformat dieses Browsers; null = keine Videoaufnahme möglich. */
  mimeType: string | null;
  status: "aus" | "anfrage" | "an" | "fehler";
  /** Nur Kamera-Spur – für die Live-Vorschau (srcObject, stumm). */
  stream: MediaStream | null;
  /** Tatsächliche Werte laut track.getSettings(), keine Wunschwerte. */
  width: number | null;
  height: number | null;
  frameRate: number | null;
  label: string | null;
  error: { code: string; message: string } | null;
}

export interface StudioSnapshot {
  phase: StudioPhase;
  warnings: {
    keinPegel: boolean;
    /** Upload/Server derzeit nicht erreichbar – Aufnahme läuft lokal weiter. */
    offline: boolean;
    geraetVerloren: boolean;
    browserSpeicherKnapp: boolean;
    /** Ergänzung: Server meldet < 10 GB frei → Start gesperrt. */
    serverSpeicherKnapp: boolean;
    /** Ergänzung: Abschnitt konnte nicht lokal (IndexedDB) gesichert werden – nur im Arbeitsspeicher. */
    lokalNichtGesichert: boolean;
    /** Ergänzung AP9: Kamera während der Aufnahme verloren → Aufnahme kontrolliert beendet. */
    kameraVerloren: boolean;
    /** PA7 (V §11 „anmeldung-noetig“): Sitzung fehlt/anderes Konto – Aufnahme läuft lokal weiter, Senden wartet auf Anmeldung. */
    anmeldungNoetig: boolean;
  };
  devices: { audio: MediaDeviceInfo[]; video: MediaDeviceInfo[] };
  /** camera = Modus „Video + Ton“ gewählt. */
  selected: { audioId: string | null; videoId: string | null; camera: boolean; sprachoptimierung: boolean };
  /** Mikrofon-Stream. */
  stream: MediaStream | null;
  kamera: KameraStand;
  /** 0..1, geglättet (RMS). */
  level: number;
  /** Ergänzung: false, solange der Browser die Pegelmessung (AudioContext) noch nicht freigibt. */
  levelActive: boolean;
  elapsedMs: number;
  /**
   * Ergänzung F1 (vom Server noch nicht bestätigte Abschnitte):
   * lokal = IndexedDB-Transaktion nachweislich abgeschlossen; nurRam = lokale Sicherung fehlgeschlagen, nur im Arbeitsspeicher.
   * total − uploaded − lokal − nurRam = gerade in Sicherung.
   */
  chunks: { total: number; uploaded: number; lokal: number; nurRam: number; /** AP9: Bytes unbestätigter Abschnitte im Arbeitsspeicher. */ ramBytes: number };
  /** Aufnahmeformat des gewählten Modus (Audio bzw. Video). */
  mimeType: string | null;
  track: Track | null;
  error: { code: string; message: string; details?: Record<string, unknown> } | null;
}

export interface Studio {
  subscribe(fn: (s: StudioSnapshot) => void): () => void;
  getSnapshot(): StudioSnapshot;
  init(): Promise<void>;
  retryPermission(): Promise<void>;
  selectAudio(id: string): Promise<void>;
  selectVideo(id: string): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  setSprachoptimierung(on: boolean): Promise<void>;
  start(opts: { projectId: string; title: string; participantName: string }): Promise<void>;
  stop(): Promise<void>;
  /** Ergänzung: allowPartial = ausdrücklich nur den lückenlosen Anfang abschließen (Bergung). */
  retryFinalize(opts?: { allowPartial?: boolean }): Promise<void>;
  /**
   * Ergänzung F1: noch nicht vom Server bestätigte Abschnitte aus dem Arbeitsspeicher als eine Datei
   * (bei Bedarf mit Dateikopf aus Abschnitt 0). null = nichts offen. vollstaendig = beginnt bei Abschnitt 0.
   */
  notfallDatei(): { blob: Blob; von: number; bis: number; vollstaendig: boolean } | null;
  dispose(): void;
}

export interface PendingRecording {
  trackId: string;
  projectId: string;
  title: string;
  startedAtMs: number;
  /** Abschnitte, die nur lokal liegen (noch nicht vom Server bestätigt). */
  localChunks: number;
  /** Ergänzung: insgesamt erzeugte Abschnitte dieser Aufnahme. */
  chunkCount: number;
  /** Ergänzung F1: Abschnitte, die bei der Aufnahme nicht lokal gesichert werden konnten (können fehlen). */
  nichtLokal: number;
}

export type { ApiClient, Track };
