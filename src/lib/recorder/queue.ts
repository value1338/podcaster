// Geordnete Upload-Warteschlange: strikt nach Index, Wiederholung mit wachsender Pause, unbegrenzt bis close().
import { backoffMs, brauchtAnmeldung, istWiederholbar } from "./format";

export interface QueueState {
  /** Bestätigte Abschnitte. */
  uploaded: number;
  /** Wartende Abschnitte (inkl. des gerade gesendeten). */
  pending: number;
  /** Letzter Versuch scheiterte wiederholbar (Netz/Server) – es wird weiter versucht. */
  offline: boolean;
  /** PA7: letzter Versuch scheiterte an fehlender Sitzung (401) – Abschnitte bleiben, Senden wartet auf Anmeldung. */
  anmeldungNoetig: boolean;
  /** Endgültig abgewiesen (z. B. 409/404) – keine weiteren Versuche, lokale Abschnitte bleiben. */
  fatal: unknown | null;
}

export interface QueueOptions {
  upload(index: number, blob: Blob, signal: AbortSignal): Promise<void>;
  /** Nach Server-Bestätigung (z. B. lokalen Abschnitt löschen). Fehler hier werden ignoriert. */
  onUploaded?(index: number): Promise<void> | void;
  onChange?(s: QueueState): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** Zeitlimit je Abschnitt; hängende Verbindungen werden abgebrochen und wiederholt. */
  timeoutMs?: number;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

export class UploadQueue {
  private items: { index: number; blob: Blob }[] = [];
  private running = false;
  private closed = false;
  private attempt = 0;
  private wakeCtl = new AbortController();
  private closeCtl = new AbortController();
  private waiters: { res: () => void; rej: (e: unknown) => void }[] = [];
  state: QueueState = { uploaded: 0, pending: 0, offline: false, anmeldungNoetig: false, fatal: null };

  constructor(private o: QueueOptions) {}

  // ponytail: wartende Blobs liegen im Arbeitsspeicher (Audio ≈ 115 MB/h Offline-Zeit); bei Video lieber aus IndexedDB nachladen.
  push(index: number, blob: Blob) {
    if (this.closed) return;
    this.items.push({ index, blob });
    this.items.sort((a, b) => a.index - b.index);
    this.emit({ pending: this.items.length });
    void this.run();
  }

  /** Noch nicht bestätigte Abschnitte (Arbeitsspeicher), nach Index sortiert – für die Notfalldatei (F1). */
  offene(): { index: number; blob: Blob }[] {
    return this.items.slice();
  }

  /** Sofort erneut versuchen (z. B. bei `online`-Ereignis). */
  wake() {
    this.wakeCtl.abort();
    this.wakeCtl = new AbortController();
  }

  /** Nach endgültigem Fehler neu anlaufen lassen (z. B. „Erneut versuchen“). */
  resume() {
    if (this.closed) return;
    this.emit({ fatal: null });
    void this.run();
  }

  /** Erfüllt, sobald alles bestätigt ist; abgelehnt bei endgültigem Fehler. */
  drained(): Promise<void> {
    if (this.state.fatal) return Promise.reject(this.state.fatal);
    if (!this.items.length && !this.running) return Promise.resolve();
    return new Promise((res, rej) => this.waiters.push({ res, rej }));
  }

  close() {
    this.closed = true;
    this.closeCtl.abort();
    this.wake();
  }

  private emit(p: Partial<QueueState>) {
    this.state = { ...this.state, ...p };
    this.o.onChange?.(this.state);
  }

  private settle(err?: unknown) {
    const w = this.waiters.splice(0);
    for (const x of w) (err ? x.rej(err) : x.res());
  }

  private async run() {
    if (this.running || this.state.fatal) return;
    this.running = true;
    const sleep = this.o.sleep ?? defaultSleep;
    try {
      while (this.items.length && !this.closed) {
        const head = this.items[0];
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 60_000);
        const stopOnClose = () => ctl.abort();
        this.closeCtl.signal.addEventListener("abort", stopOnClose, { once: true });
        try {
          await this.o.upload(head.index, head.blob, ctl.signal);
          this.items.shift();
          this.attempt = 0;
          this.emit({ uploaded: this.state.uploaded + 1, pending: this.items.length, offline: false, anmeldungNoetig: false });
          try { await this.o.onUploaded?.(head.index); } catch { /* lokaler Rest wird bei Wiederherstellung bereinigt */ }
        } catch (e) {
          if (this.closed) break;
          if (!istWiederholbar(e)) {
            this.emit({ fatal: e });
            this.settle(e);
            return;
          }
          const anmelden = brauchtAnmeldung(e);
          this.emit({ offline: !anmelden, anmeldungNoetig: anmelden });
          await sleep(backoffMs(this.attempt++), this.wakeCtl.signal);
        } finally {
          clearTimeout(timer);
          this.closeCtl.signal.removeEventListener("abort", stopOnClose);
        }
      }
    } finally {
      this.running = false;
    }
    if (!this.items.length) this.settle();
  }
}
