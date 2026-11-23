// Studio eines Projekts: Vorschau links, Zustands-/Geräteblock rechts (Referenz 02). Besitzer AP4.
import {
  ArrowLeft, CircleCheck, Download, Mic, MicOff, RotateCw, Square, TriangleAlert, Video, VideoOff, WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useBlocker } from "react-router";
import { Badge, Button, buttonClass, ErrorState, Spinner } from "../../components";
import { api, type ProjectDetail } from "../../lib/api";
import { formatBytes, formatDateTime, formatDuration, formatResolution } from "../../lib/format";
import { createStudio, initialSnapshot, RAM_PUFFER_MAX_BYTES, type Studio, type StudioPhase, type StudioSnapshot } from "../../lib/recorder";
import { originalFormat } from "../projekte/logik";
import type { StudioVorgabe } from "../start/agenten";
import { StudioRahmen } from "./Rahmen";
import { Reauth } from "./Reauth";
import { Wiederherstellung } from "./Wiederherstellung";

/** HTTPS-Variante der aktuellen Adresse (Mikrofon nur in sicherem Kontext). */
export const HTTPS_ADRESSE = `https://${location.host}${import.meta.env.BASE_URL}`;
const COUNTDOWN_S = 3;
/** V §11: Sprecherpräferenz je Konto. Der alte gemeinsame Schlüssel wird bewusst nicht gelesen (könnte von einem anderen Konto stammen). */
const nameKey = (userId: string) => `podcast-studio:${userId}:sprecher`;

const LEER: StudioSnapshot = initialSnapshot();
const noop = () => () => {};

/** Engine je „Sitzung“; `neu()` erzeugt eine frische (Weitere Aufnahme). */
function useStudio(userId: string): [Studio | null, StudioSnapshot, () => void] {
  const [gen, setGen] = useState(0);
  const [studio, setStudio] = useState<Studio | null>(null);
  useEffect(() => {
    const s = createStudio(api, { userId });
    setStudio(s);
    void s.init();
    return () => s.dispose();
  }, [gen, userId]);
  const snap = useSyncExternalStore(studio?.subscribe ?? noop, studio?.getSnapshot ?? (() => LEER));
  return [studio, snap, () => setGen((g) => g + 1)];
}

const lese = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const schreibe = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* egal */ } };

const SCHUTZ: StudioPhase[] = ["countdown", "aufnahme", "abschluss"];

const ANSAGE: Partial<Record<StudioPhase, string>> = {
  anfrage: "Mikrofonzugriff wird angefragt.", bereit: "Studio bereit.", verweigert: "Kein Zugriff auf das Mikrofon.",
  "kein-geraet": "Kein Mikrofon gefunden.", "geraet-belegt": "Mikrofon ist belegt.", unsicher: "Aufnahme nur über HTTPS möglich.",
  "nicht-unterstuetzt": "Browser wird nicht unterstützt.", aufnahme: "Aufnahme läuft.", abschluss: "Aufnahme beendet, restliche Abschnitte werden gesichert.",
  verarbeitung: "Server verarbeitet die Aufnahme.", fertig: "Aufnahme gesichert.", "fehler-abschluss": "Abschluss fehlgeschlagen.",
};

export function Studioraum({ projekt, userId, vorgabe = {} }: { projekt: ProjectDetail; userId: string; vorgabe?: StudioVorgabe }) {
  const [studio, s, neu] = useStudio(userId);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [titel, setTitel] = useState(() => vorgabe.titel ?? `Aufnahme ${formatDateTime(new Date().toISOString())}`);
  const [name, setName] = useState(() => vorgabe.name ?? lese(nameKey(userId)));
  const [wiederOffen, setWiederOffen] = useState(true);
  const [startFehler, setStartFehler] = useState<string | null>(null);

  // Abschnitte nur im Arbeitsspeicher (F1): Schließen würde sie verlieren → ebenfalls Rückfrage.
  const geschuetzt = SCHUTZ.includes(s.phase) || countdown !== null || s.chunks.nurRam > 0;
  const blocker = useBlocker(geschuetzt);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const text = s.chunks.nurRam > 0
      ? "Noch nicht gesicherte Aufnahmeabschnitte liegen nur im Arbeitsspeicher. Beim Verlassen können sie verloren gehen. Zuerst die Notfalldatei speichern oder auf die Serverbestätigung warten. Trotzdem verlassen?"
      : "Die Aufnahme oder ihre Sicherung läuft noch. Trotzdem das Studio verlassen?";
    if (window.confirm(text)) blocker.proceed();
    else blocker.reset();
  }, [blocker, s.chunks.nurRam]);

  // Schließen/Neuladen während Aufnahme/Abschluss: Rückfrage des Browsers.
  useEffect(() => {
    if (!geschuetzt) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [geschuetzt]);

  // Countdown gehört der Oberfläche; start() erst nach Ablauf (Umsetzung.md §7).
  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      setCountdown(null);
      const n = name.trim() || "Ich";
      schreibe(nameKey(userId), name.trim());
      studio?.start({ projectId: projekt.id, title: titel.trim(), participantName: n }).catch((e) => setStartFehler(String(e?.message ?? e)));
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, name, projekt.id, studio, titel, userId]);

  // PA7: 401 irgendwo im Studio (api meldet `studio:abgemeldet`) → eigene Anmeldung hier, ohne Navigation/Neuladen.
  const [abgemeldet, setAbgemeldet] = useState(false);
  useEffect(() => {
    const h = () => setAbgemeldet(true);
    window.addEventListener("studio:abgemeldet", h);
    return () => window.removeEventListener("studio:abgemeldet", h);
  }, []);
  const anmelden = abgemeldet || s.warnings.anmeldungNoetig || s.error?.code === "unauthenticated" || s.error?.code === "konto_gewechselt";

  useEffect(() => {
    if (countdown === null) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setCountdown(null); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [countdown]);

  const ansage = countdown !== null ? `Aufnahme beginnt in ${countdown}` : ANSAGE[s.phase] ?? "";
  const zeigeWieder = wiederOffen && !geschuetzt && ["bereit", "anfrage", "verweigert", "kein-geraet", "geraet-belegt"].includes(s.phase);

  return (
    <StudioRahmen
      kontext={<>Studio · <span className="studio-kopf__projekt">{projekt.title}</span></>}
      ende={!geschuetzt && (
        <Link to={`/projekte/${projekt.id}`} className={buttonClass("ghost", "sm")}><ArrowLeft size={16} aria-hidden />Zum Projekt</Link>
      )}
    >
      <main className="studio-buehne" data-phase={s.phase}>
        <Vorschau s={s} countdown={countdown} />
        <aside className="studio-seite" aria-label="Aufnahmesteuerung">
          {zeigeWieder && (
            <Wiederherstellung projectId={projekt.id} userId={userId} onSchliessen={() => setWiederOffen(false)} />
          )}
          <Steuerung
            s={s} studio={studio} projekt={projekt} countdown={countdown} startFehler={startFehler}
            titel={titel} setTitel={setTitel} name={name} setName={setName}
            onStart={() => { setStartFehler(null); setCountdown(COUNTDOWN_S); }}
            onAbbrechen={() => setCountdown(null)}
            onNeu={() => { setTitel(`Aufnahme ${formatDateTime(new Date().toISOString())}`); setWiederOffen(true); neu(); }}
          />
          {vorgabe.brief && (
            <details className="studio-block" open>
              <summary style={{ fontWeight: 600, cursor: "pointer" }}>Aufnahmebrief</summary>
              <p className="studio-klein" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{vorgabe.brief}</p>
              <p className="studio-klein u-muted">Von der Startseite (Producer) übernommen · nur in diesem Tab, nicht auf dem Server gespeichert.</p>
            </details>
          )}
        </aside>
      </main>
      <div className="u-sr-only" aria-live="polite" role="status">{ansage}</div>
      {anmelden && <Reauth userId={userId} geschuetzt={geschuetzt} s={s} studio={studio} onFertig={() => setAbgemeldet(false)} />}
    </StudioRahmen>
  );
}

// ---------- Vorschau ----------
/** Echte Live-Vorschau der Kamera: srcObject, stumm, inline (iPhone). Nicht gespiegelt = so, wie aufgenommen wird. */
function LiveVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    void v.play().catch(() => { /* autoplay stumm ist erlaubt; sonst startet es beim nächsten Klick */ });
    return () => { v.srcObject = null; };
  }, [stream]);
  return <video ref={ref} className="studio-vorschau__video" autoPlay muted playsInline aria-label="Live-Vorschau der Kamera" />;
}

function Vorschau({ s, countdown }: { s: StudioSnapshot; countdown: number | null }) {
  const aktiv = !!s.stream && s.levelActive;
  const rec = s.phase === "aufnahme";
  const k = s.kamera;
  const fertigVideo = s.phase === "fertig" && s.track?.kind === "video" ? s.track : null;
  return (
    <section className="studio-vorschau" aria-label="Vorschau">
      {fertigVideo ? (
        // Fertige Aufnahme vom Server (remuxt, spulbar) – nicht die Kameravorschau.
        <video key={fertigVideo.id} className="studio-vorschau__video" controls preload="metadata" playsInline
          src={api.trackFileUrl(fertigVideo.id)} aria-label="Wiedergabe der fertigen Aufnahme" data-testid="studio-ergebnis-video" />
      ) : k.stream ? <LiveVideo stream={k.stream} /> : null}
      {fertigVideo && <div className="studio-vorschau__etikett">Fertige Aufnahme · vom Server</div>}
      {!fertigVideo && k.stream && k.width && k.height && (
        <div className="studio-vorschau__etikett u-mono">{k.width}×{k.height}{k.frameRate ? ` · ${Math.round(k.frameRate)} fps` : ""}</div>
      )}
      {rec && (
        <div className="studio-vorschau__rec">
          <span className="studio-rec-punkt" aria-hidden />
          <span>REC</span>
          <span className="u-mono">{formatDuration(s.elapsedMs)}</span>
        </div>
      )}
      <div className="studio-vorschau__mitte">
        {!k.stream && !fertigVideo && (
          <div className="studio-avatar" style={{ ["--pegel" as string]: aktiv ? s.level.toFixed(3) : "0" }} data-rec={rec || undefined}>
            {s.stream ? <Mic size={40} aria-hidden /> : <MicOff size={40} aria-hidden />}
          </div>
        )}
        {countdown !== null && <div className="studio-countdown" aria-hidden>{countdown}</div>}
      </div>
      {!fertigVideo && <div className="studio-vorschau__leiste">
        <span className="studio-vorschau__symbol" data-an={!!k.stream || undefined}>
          {k.stream ? <Video size={20} aria-hidden /> : <VideoOff size={20} aria-hidden />}
          <span className="u-sr-only">{k.stream ? "Kamera aktiv" : "Kamera aus"}</span>
        </span>
        <span className="studio-vorschau__symbol" data-an={!!s.stream || undefined}>
          {s.stream ? <Mic size={20} aria-hidden /> : <MicOff size={20} aria-hidden />}
          <span className="u-sr-only">{s.stream ? "Mikrofon aktiv" : "Mikrofon aus"}</span>
        </span>
      </div>}
    </section>
  );
}

/** Pegel als Balkenlänge + Zahl (nicht nur Farbe). */
function Pegel({ s }: { s: StudioSnapshot }) {
  const db = Math.round(s.level * 60 - 60);
  const wert = s.levelActive ? `${db <= -60 ? "−∞" : String(db).replace("-", "−")} dB` : "–";
  return (
    <div className="studio-pegel">
      <div className="studio-pegel__kopf"><span>Pegel</span><span className="u-mono">{wert}</span></div>
      <div className="studio-pegel__bahn" role="meter" aria-label="Eingangspegel" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(s.level * 100)} aria-valuetext={wert}>
        <div className="studio-pegel__balken" style={{ width: `${Math.round(s.level * 100)}%` }} data-laut={s.level > 0.9 || undefined} />
      </div>
      {!s.levelActive && s.stream && (
        <p className="studio-klein u-muted">Die Pegelanzeige startet, sobald du einmal in die Seite klickst (Browser-Vorgabe).</p>
      )}
    </div>
  );
}

function Hinweis({ ton = "warn", icon = TriangleAlert, children }: { ton?: "warn" | "info" | "ok"; icon?: typeof TriangleAlert; children: ReactNode }) {
  const Icon = icon;
  return <p className={`studio-hinweis studio-hinweis--${ton}`}><Icon size={16} aria-hidden />{children}</p>;
}

/** Wartende Abschnitte – „lokal gesichert“ nur, soweit die IndexedDB-Transaktion nachweislich abgeschlossen ist. */
function wartetText(c: StudioSnapshot["chunks"]): string {
  const wartend = c.total - c.uploaded;
  if (wartend <= 0) return "Alles auf dem Server gesichert";
  const teile = [`${c.lokal} lokal gesichert`];
  if (c.nurRam > 0) teile.push(`${c.nurRam} nur im Arbeitsspeicher`);
  return `${wartend} ${wartend === 1 ? "Abschnitt wartet" : "Abschnitte warten"} auf den Server (${teile.join(", ")})`;
}

function Warnungen({ s }: { s: StudioSnapshot }) {
  const w = s.warnings;
  const ram = s.chunks.nurRam;
  return (
    <>
      {w.keinPegel && <Hinweis>Seit 5 Sekunden kein Signal – ist das Mikrofon stummgeschaltet oder das falsche gewählt?</Hinweis>}
      {w.anmeldungNoetig && ["aufnahme", "abschluss", "verarbeitung"].includes(s.phase) && (
        <Hinweis icon={WifiOff}>Sitzung abgelaufen{s.phase === "aufnahme" ? ", die Aufnahme läuft weiter" : ""}. Übertragen wird nach erneuter Anmeldung mit demselben Konto. {wartetText(s.chunks)}.</Hinweis>
      )}
      {w.offline && !w.anmeldungNoetig && (s.phase === "aufnahme" || s.phase === "abschluss") && (
        <Hinweis icon={WifiOff}>Keine Verbindung zum Server{s.phase === "aufnahme" ? ", die Aufnahme läuft weiter" : ""}. {wartetText(s.chunks)}.</Hinweis>
      )}
      {w.offline && s.phase === "verarbeitung" && <Hinweis icon={WifiOff}>Verbindung unterbrochen – der Stand wird abgefragt, sobald der Server wieder erreichbar ist.</Hinweis>}
      {w.lokalNichtGesichert && ram > 0 && (
        <Hinweis>
          Die lokale Sicherung im Browser ist fehlgeschlagen. Aufgenommen wird deshalb nicht weiter.{" "}
          {ram === 1 ? "1 Abschnitt liegt" : `${ram} Abschnitte liegen`} nur im Arbeitsspeicher dieses Tabs und {ram === 1 ? "wird" : "werden"} zum Server übertragen, sobald er erreichbar ist.
          Wird der Tab vorher geschlossen oder stürzt er ab, {ram === 1 ? "ist dieser Abschnitt" : "sind diese Abschnitte"} verloren – das kann die App nicht verhindern. Tab offen lassen oder unten eine Notfalldatei speichern.
        </Hinweis>
      )}
      {w.lokalNichtGesichert && ram === 0 && (
        <Hinweis ton="info">Die lokale Sicherung im Browser war gestört; aufgenommen wurde deshalb nicht weiter. Alle betroffenen Abschnitte hat der Server inzwischen bestätigt.</Hinweis>
      )}
      {w.browserSpeicherKnapp && !w.lokalNichtGesichert && <Hinweis>Der Browser-Speicher ist knapp. Bei längerem Netzausfall kann die lokale Sicherung nicht alles aufnehmen.</Hinweis>}
      {w.geraetVerloren && !["bereit", "kein-geraet"].includes(s.phase) && <Hinweis>Das Mikrofon wurde während der Aufnahme getrennt. {s.phase === "fertig" ? "Der Stand bis dahin ist gesichert." : "Der Stand bis dahin wird gesichert."}</Hinweis>}
      {w.kameraVerloren && !["bereit", "kein-geraet"].includes(s.phase) && <Hinweis>Die Kamera wurde während der Aufnahme getrennt; die Aufnahme wurde beendet. {s.phase === "fertig" ? "Der Stand bis dahin ist gesichert." : "Der Stand bis dahin wird gesichert."}</Hinweis>}
      {s.phase === "aufnahme" && s.chunks.ramBytes > RAM_PUFFER_MAX_BYTES / 2 && (
        <Hinweis>{formatBytes(s.chunks.ramBytes)} sind noch nicht vom Server bestätigt. Ab {formatBytes(RAM_PUFFER_MAX_BYTES)} wird die Aufnahme sicherheitshalber beendet.</Hinweis>
      )}
    </>
  );
}

// ---------- Steuerung je Zustand ----------
interface SteuerungProps {
  s: StudioSnapshot; studio: Studio | null; projekt: ProjectDetail; countdown: number | null; startFehler: string | null;
  titel: string; setTitel(v: string): void; name: string; setName(v: string): void;
  onStart(): void; onAbbrechen(): void; onNeu(): void;
}

/** Gründe für einen kontrollierten Stopp während der Aufnahme. */
const FEHLER_TITEL: Record<string, string> = {
  lokal_nicht_gesichert: "Lokale Sicherung fehlgeschlagen",
  puffer_voll: "Zu viel unbestätigt im Arbeitsspeicher",
  kamera_getrennt: "Kamera getrennt",
};

function Block({ titel, text, children, icon }: { titel: string; text?: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="studio-block">
      {icon}
      <h1 className="studio-block__titel">{titel}</h1>
      {text && <div className="studio-block__text">{text}</div>}
      {children}
    </div>
  );
}

function Steuerung(p: SteuerungProps) {
  const { s, studio } = p;
  const zumProjekt = <Link to={`/projekte/${p.projekt.id}`} className={buttonClass("secondary")}>Zum Projekt</Link>;

  if (p.countdown !== null) {
    return (
      <Block titel={`Gleich geht's los … ${p.countdown}`} text="Die Aufnahme beginnt nach dem Countdown.">
        <Button onClick={p.onAbbrechen}>Abbrechen (Esc)</Button>
      </Block>
    );
  }

  switch (s.phase) {
    case "unsicher": {
      const ziel = HTTPS_ADRESSE + `studio/${p.projekt.id}`;
      return (
        <Block titel="Aufnahme nur über HTTPS möglich" text={<>
          <p>Der Browser gibt das Mikrofon nur auf sicheren Adressen frei. Diese Seite ist über eine unverschlüsselte Adresse geöffnet.</p>
          <p className="studio-klein u-muted">Sichere Adresse:</p>
          <p className="studio-adresse u-mono">{ziel}</p>
        </>}>
          <a href={ziel} className={buttonClass("primary")}>Über HTTPS öffnen</a>
        </Block>
      );
    }
    case "nicht-unterstuetzt":
      return (
        <Block titel="Dieser Browser wird noch nicht unterstützt" text={<>
          <p>{s.error?.message}</p>
          <p className="studio-klein u-muted">Automatisch geprüft (mit Schein-Mikrofon): Chrome/Chromium und Firefox am Computer. Safari und iPhone/iPad sind in Stufe 1 nicht freigegeben.</p>
        </>} />
      );
    case "anfrage":
      return (
        <Block titel="Zugriff auf das Mikrofon" text="Bitte erlaube den Zugriff im Dialog deines Browsers.">
          <Spinner label="Warte auf Freigabe …" visible />
        </Block>
      );
    case "verweigert":
      return (
        <Block titel="Kein Zugriff auf Mikrofon" text={<>
          <p>Gib dem Studio Zugriff auf dein Mikrofon, damit du aufnehmen kannst.</p>
          <p className="studio-klein u-muted">So geht's: Schloss- bzw. Einstellungssymbol links in der Adressleiste → Mikrofon → Zulassen. Danach erneut versuchen.</p>
        </>}>
          <Button variant="primary" icon={Mic} onClick={() => void studio?.retryPermission()}>Mikrofon verwenden</Button>
        </Block>
      );
    case "kein-geraet":
      return (
        <Block titel="Kein Mikrofon gefunden" text={<>
          <p>{s.error?.code === "geraet_getrennt" ? "Das Mikrofon wurde getrennt." : "Es ist kein Mikrofon angeschlossen oder freigegeben."}</p>
          <p className="studio-klein u-muted">Schließe ein Mikrofon an oder prüfe die Systemeinstellungen, dann erneut suchen.</p>
        </>}>
          <Button variant="primary" icon={RotateCw} onClick={() => void studio?.retryPermission()}>Erneut suchen</Button>
        </Block>
      );
    case "geraet-belegt":
      return (
        <Block titel="Mikrofon ist belegt" text={<>
          <p>{s.error?.message}</p>
          <p className="studio-klein u-muted">Schließe andere Apps, die das Mikrofon nutzen (z. B. Videokonferenz), und versuche es erneut.</p>
        </>}>
          <Button variant="primary" icon={RotateCw} onClick={() => void studio?.retryPermission()}>Erneut versuchen</Button>
        </Block>
      );
    case "bereit":
    case "countdown":
      return <Warteraum {...p} />;
    case "aufnahme": {
      return (
        <Block titel="Aufnahme läuft" icon={<Badge tone="rec"><span className="studio-rec-punkt" aria-hidden />REC</Badge>}>
          <p className="studio-zeit u-mono" aria-label={`Laufzeit ${formatDuration(s.elapsedMs)}`}>{formatDuration(s.elapsedMs)}</p>
          <Pegel s={s} />
          <p className="studio-status">
            {s.warnings.offline ? <WifiOff size={16} aria-hidden /> : <CircleCheck size={16} aria-hidden />}
            {wartetText(s.chunks)}
            <span className="u-muted u-mono"> · {s.chunks.uploaded}/{s.chunks.total}</span>
          </p>
          {s.selected.camera && (
            <p className="studio-klein u-muted">Video + Ton{s.kamera.width && s.kamera.height ? <> · <span className="u-mono">{s.kamera.width}×{s.kamera.height}</span></> : null}</p>
          )}
          <Warnungen s={s} />
          {s.error && <ErrorState compact title={FEHLER_TITEL[s.error.code] ?? "Upload abgewiesen"} message={s.error.message} />}
          <Button variant="danger" icon={Square} onClick={() => void studio?.stop()}>Aufnahme beenden</Button>
        </Block>
      );
    }
    case "abschluss": {
      const { total, uploaded } = s.chunks;
      return (
        <Block titel="Aufnahme wird gesichert" text="Restliche Abschnitte werden zum Server übertragen. Bitte den Tab nicht schließen.">
          {s.error && FEHLER_TITEL[s.error.code] && <ErrorState compact title={FEHLER_TITEL[s.error.code]} message={s.error.message} />}
          <div className="studio-fortschritt" role="progressbar" aria-label="Gesicherte Abschnitte" aria-valuemin={0} aria-valuemax={total} aria-valuenow={uploaded}>
            <div style={{ width: total ? `${(uploaded / total) * 100}%` : "0%" }} />
          </div>
          <p className="u-mono studio-klein">{uploaded}/{total} Abschnitte auf dem Server · Dauer {formatDuration(s.elapsedMs)}</p>
          <Warnungen s={s} />
          <Notfall s={s} studio={studio} />
        </Block>
      );
    }
    case "verarbeitung":
      return (
        <Block titel="Wird verarbeitet" text="Alle Abschnitte sind auf dem Server. Er fügt die Aufnahme jetzt zusammen und prüft sie.">
          <Spinner label="Server verarbeitet die Aufnahme …" visible />
          <Warnungen s={s} />
          <p className="studio-klein u-muted">Du kannst die Seite verlassen – der Stand erscheint im Projekt.</p>
          {zumProjekt}
        </Block>
      );
    case "fertig": {
      const t = s.track!;
      return (
        <Block titel="Aufnahme gesichert" icon={<CircleCheck className="studio-ok" size={32} aria-hidden />}>
          <dl className="studio-fakten">
            <dt>Art</dt><dd>{t.kind === "video" ? "Video + Ton" : "Nur Ton"}</dd>
            <dt>Dauer</dt><dd className="u-mono">{formatDuration(t.durationMs)}</dd>
            {t.kind === "video" && <><dt>Auflösung</dt><dd className="u-mono">{formatResolution(t.width, t.height) || "unbekannt"}</dd></>}
            <dt>Größe</dt><dd className="u-mono">{formatBytes(t.bytes)}</dd>
            <dt>Format</dt><dd className="u-mono">{originalFormat(t.mimeType)} <span className="u-muted">({t.mimeType})</span></dd>
          </dl>
          {t.kind === "video" && <p className="studio-klein u-muted">Dauer und Auflösung hat der Server mit ffprobe gemessen. MP4 (H.264/AAC) sowie MP3/WAV (nur Ton) erstellst du im Projekt unter „Herunterladen“.</p>}
          <Warnungen s={s} />
          <div className="studio-aktionen">
            <a href={api.trackFileUrl(t.id, { download: true })} download className={buttonClass("primary")}><Download size={18} aria-hidden />Original herunterladen</a>
            {zumProjekt}
            <Button variant="ghost" icon={Mic} onClick={p.onNeu}>Weitere Aufnahme</Button>
          </div>
        </Block>
      );
    }
    case "fehler-abschluss":
      return <FehlerAbschluss {...p} zumProjekt={zumProjekt} />;
  }
}

function Warteraum(p: SteuerungProps) {
  const { s, studio } = p;
  const vorbereitung = s.phase === "countdown";
  const kameraFehlt = s.selected.camera && s.kamera.status !== "an";
  const gesperrt = vorbereitung || s.warnings.serverSpeicherKnapp || !p.titel.trim() || kameraFehlt;
  const geraete = useMemo(() => s.devices.audio, [s.devices.audio]);
  return (
    <Block titel="Bereit zur Aufnahme" text={s.selected.camera ? "Prüfe Kamerabild, Mikrofon und Pegel, dann starte die Aufnahme." : "Prüfe Mikrofon und Pegel, dann starte die Aufnahme."}>
      <div className="studio-feld">
        <label htmlFor="studio-titel">Titel der Aufnahme</label>
        <input id="studio-titel" className="field" value={p.titel} maxLength={120} onChange={(e) => p.setTitel(e.target.value)} disabled={vorbereitung} />
      </div>
      <div className="studio-feld">
        <label htmlFor="studio-name">Name auf der Spur</label>
        <input id="studio-name" className="field" value={p.name} maxLength={120} placeholder="Ich" onChange={(e) => p.setName(e.target.value)} disabled={vorbereitung} />
      </div>
      <div className="studio-feld">
        <label htmlFor="studio-mic">Mikrofon</label>
        <select id="studio-mic" className="studio-select" value={s.selected.audioId ?? ""} disabled={vorbereitung}
          onChange={(e) => void studio?.selectAudio(e.target.value)}>
          {geraete.length === 0 && <option value="">Standardmikrofon</option>}
          {geraete.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Mikrofon ${i + 1}`}</option>)}
        </select>
      </div>
      <Pegel s={s} />
      <KameraWahl s={s} studio={studio} gesperrt={vorbereitung} />
      <label className="studio-schalter">
        <input type="checkbox" checked={s.selected.sprachoptimierung} disabled={vorbereitung}
          onChange={(e) => void studio?.setSprachoptimierung(e.target.checked)} />
        <span>
          <span className="studio-schalter__titel">Sprachoptimierung</span>
          <span className="studio-klein u-muted">Echo- und Rauschunterdrückung, automatische Lautstärke – für laute Räume. Aus = unbearbeiteter Studioklang.</span>
        </span>
      </label>
      <Warnungen s={s} />
      {s.warnings.serverSpeicherKnapp && <ErrorState compact title="Server-Speicher knapp" message="Auf dem Server sind weniger als 10 GB frei. Bitte erst Platz schaffen, dann neu laden." />}
      {s.error?.code === "quota_exceeded" ? <KontingentErreicht details={s.error.details} />
        : s.error && !s.warnings.serverSpeicherKnapp && <ErrorState compact title="Aufnahme nicht möglich" message={s.error.message} />}
      {p.startFehler && <ErrorState compact title="Aufnahme nicht gestartet" message={p.startFehler} />}
      <Button variant="primary" icon={Mic} onClick={p.onStart} disabled={gesperrt}>
        {vorbereitung ? "Wird vorbereitet …" : s.selected.camera ? "Video-Aufnahme starten" : "Aufnahme starten"}
      </Button>
      {kameraFehlt && !vorbereitung && <p className="studio-klein u-muted">Start erst, wenn die Kamera ein Bild liefert – oder „Nur Ton“ wählen.</p>}
      {s.mimeType && <p className="studio-klein u-muted">Format: <span className="u-mono">{s.mimeType}</span> · Abschnitte alle 4 s, vor dem Upload lokal im Browser gesichert. Schlägt das fehl, endet die Aufnahme sofort.</p>}
    </Block>
  );
}

/** R6: Start bei erreichtem Speicherkontingent (402 quota_exceeded) – eigener Zustand mit Verbrauch, kein generischer Fehler. */
function KontingentErreicht({ details = {} }: { details?: Record<string, unknown> }) {
  const zahl = (k: string) => (typeof details[k] === "number" ? (details[k] as number) : null);
  const used = zahl("used"), limit = zahl("limit");
  return (
    <ErrorState compact title="Speicherkontingent erreicht" message={<>
      {used != null && limit != null
        ? <>Belegt <span className="u-mono">{formatBytes(used)}</span> von <span className="u-mono">{formatBytes(limit)}</span>. </>
        : "Der Speicher deines Kontos ist voll. "}
      Neue Aufnahmen sind erst möglich, wenn Platz frei ist oder der Plan erweitert wird. Herunterladen bleibt möglich.
    </>} />
  );
}

/** Modus Nur Ton / Video + Ton, Kamerawahl und tatsächliche Kamerawerte. Freigabe erst auf ausdrücklichen Wunsch. */
function KameraWahl({ s, studio, gesperrt }: { s: StudioSnapshot; studio: Studio | null; gesperrt: boolean }) {
  const k = s.kamera;
  const video = s.selected.camera;
  const kannVideo = !!k.mimeType;
  return (
    <fieldset className="studio-modus">
      <legend className="studio-modus__titel">Aufnahmeart</legend>
      <div className="studio-modus__wahl" role="radiogroup">
        <label className="studio-modus__option" data-aktiv={!video || undefined}>
          <input type="radio" name="studio-modus" checked={!video} disabled={gesperrt} onChange={() => void studio?.setCamera(false)} />
          <Mic size={16} aria-hidden /><span>Nur Ton</span>
        </label>
        <label className="studio-modus__option" data-aktiv={video || undefined}>
          <input type="radio" name="studio-modus" checked={video} disabled={gesperrt || !kannVideo} onChange={() => void studio?.setCamera(true)} />
          <Video size={16} aria-hidden /><span>Video + Ton</span>
        </label>
      </div>
      {!kannVideo && <p className="studio-klein u-muted">Dieser Browser kann kein Video aufnehmen. Aufgenommen wird nur Ton.</p>}
      {k.error && !video && <p className="studio-klein u-muted">{k.error.message}</p>}
      {video && (
        <>
          <div className="studio-feld">
            <label htmlFor="studio-kamera">Kamera</label>
            <select id="studio-kamera" className="studio-select" value={s.selected.videoId ?? ""} disabled={gesperrt || k.status === "anfrage"}
              onChange={(e) => void studio?.selectVideo(e.target.value)}>
              {s.devices.video.length === 0 && <option value="">Standardkamera</option>}
              {s.devices.video.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Kamera ${i + 1}`}</option>)}
            </select>
          </div>
          {k.status === "anfrage" && <Spinner label="Kamera wird geöffnet – bitte Zugriff im Browser erlauben …" visible />}
          {k.status === "an" && (
            <p className="studio-klein u-muted" data-testid="studio-kamera-werte">
              Kamera liefert <span className="u-mono">{formatResolution(k.width, k.height) || "unbekannte Auflösung"}{k.frameRate ? ` · ${Math.round(k.frameRate)} fps` : ""}</span>
              {" "}(gewünscht 1920×1080 · 30 fps; die Kamera entscheidet). Format <span className="u-mono">{s.mimeType}</span>.
            </p>
          )}
          {k.status === "fehler" && k.error && (
            <ErrorState compact title={KAMERA_TITEL[k.error.code] ?? "Kamera nicht verfügbar"} message={<>
              {k.error.message} {k.error.code === "kamera_verweigert"
                ? "Erlauben: Schloss- bzw. Einstellungssymbol in der Adressleiste → Kamera → Zulassen."
                : k.error.code === "kamera_belegt" ? "Schließe andere Apps, die die Kamera nutzen." : ""}
            </>} actions={<>
              <Button size="sm" icon={RotateCw} disabled={gesperrt} onClick={() => void studio?.setCamera(true)}>Kamera erneut versuchen</Button>
              <Button size="sm" variant="ghost" icon={Mic} disabled={gesperrt} onClick={() => void studio?.setCamera(false)}>Ohne Kamera, nur Ton</Button>
            </>} />
          )}
        </>
      )}
    </fieldset>
  );
}

const KAMERA_TITEL: Record<string, string> = {
  kamera_verweigert: "Kein Zugriff auf die Kamera",
  kamera_kein_geraet: "Keine Kamera gefunden",
  kamera_belegt: "Kamera ist belegt",
  kamera_getrennt: "Kamera getrennt",
};

/** F1: nicht bestätigte Abschnitte aus dem Arbeitsspeicher als Datei herunterladen, solange der Tab offen ist. */
function Notfall({ s, studio }: { s: StudioSnapshot; studio: Studio | null }) {
  const [info, setInfo] = useState<string | null>(null);
  if (!studio || s.chunks.nurRam <= 0) return null;
  const speichern = () => {
    const d = studio.notfallDatei();
    if (!d) { setInfo(s.chunks.uploaded >= s.chunks.total && s.chunks.nurRam === 0
      ? "Alle erzeugten Abschnitte sind vom Server bestätigt."
      : "Die Notfalldatei ist gerade nicht verfügbar. Ungesicherte Abschnitte sind weiterhin offen – Tab bitte offen lassen und erneut versuchen."); return; }
    const url = URL.createObjectURL(d.blob);
    const a = document.createElement("a");
    a.href = url;
    const mt = s.mimeType ?? "";
    a.download = `notfall-abschnitte-${d.von}-${d.bis}.${mt.startsWith("video/mp4") ? "mp4" : mt.includes("mp4") ? "m4a" : "webm"}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setInfo((d.vollstaendig
      ? `Download angestoßen: Abschnitte ${d.von}–${d.bis}, also alles ab Beginn.`
      : `Download angestoßen: Abschnitte ${d.von}–${d.bis} mit Dateikopf aus Abschnitt 0; die Abschnitte davor hat der Server bereits bestätigt.`)
      + " Ob die Datei gespeichert wurde, kann die Seite nicht feststellen – bitte im Download-Ordner prüfen. Der Upload läuft weiter.");
  };
  return (
    <div className="studio-aktionen">
      <Button variant="secondary" icon={Download} onClick={speichern}>Notfalldatei speichern</Button>
      {info && <p className="studio-klein" role="status">{info}</p>}
    </div>
  );
}

function FehlerAbschluss(p: SteuerungProps & { zumProjekt: ReactNode }) {
  const { s, studio } = p;
  const [teilFrage, setTeilFrage] = useState(false);
  const e = s.error;
  const fehlend = (e?.details?.missing as number[] | undefined) ?? null;
  if (e?.code === "keine_daten") {
    return (
      <Block titel="Nichts aufgenommen" text={e.message}>
        <Button variant="primary" icon={Mic} onClick={p.onNeu}>Neue Aufnahme</Button>
      </Block>
    );
  }
  const verarbeitung = e?.code === "verarbeitung_fehlgeschlagen";
  return (
    <Block titel="Abschluss fehlgeschlagen">
      <ErrorState compact title={verarbeitung ? "Der Server konnte die Aufnahme nicht verarbeiten" : "Die Aufnahme ist noch nicht vollständig gesichert"}
        message={e?.message} />
      <p className="studio-klein u-muted">
        {verarbeitung ? "Die Rohdaten liegen auf dem Server und bleiben erhalten."
          : s.chunks.nurRam > 0 ? `${s.chunks.nurRam} nicht bestätigte Abschnitte liegen nur im Arbeitsspeicher dieses Tabs – beim Schließen gehen sie verloren.`
          : "Nicht bestätigte Abschnitte bleiben lokal in diesem Browser gespeichert."}
      </p>
      <Notfall s={s} studio={studio} />
      {fehlend && <p className="studio-klein">Fehlende Abschnitte: <span className="u-mono">{fehlend.slice(0, 20).join(", ")}{fehlend.length > 20 ? " …" : ""}</span></p>}
      <div className="studio-aktionen">
        <Button variant="primary" icon={RotateCw} onClick={() => void studio?.retryFinalize()}>Erneut versuchen</Button>
        {verarbeitung && s.track?.hasRaw && (
          <a href={api.trackFileUrl(s.track.id, { raw: true, download: true })} download className={buttonClass("secondary")}><Download size={18} aria-hidden />Rohdatei herunterladen</a>
        )}
        {fehlend && !teilFrage && <Button variant="ghost" onClick={() => setTeilFrage(true)}>Nur lückenlosen Anfang sichern …</Button>}
        {s.chunks.nurRam === 0 && p.zumProjekt /* Verlassen würde Abschnitte im Arbeitsspeicher verwerfen */}
      </div>
      {teilFrage && (
        <div className="studio-frage" role="group" aria-label="Rückfrage">
          <p>Es wird nur der Teil bis zum ersten fehlenden Abschnitt abgeschlossen. Alles danach fehlt in der Datei. Fortfahren?</p>
          <div className="studio-aktionen">
            <Button variant="danger" onClick={() => { setTeilFrage(false); void studio?.retryFinalize({ allowPartial: true }); }}>Ja, nur den Anfang sichern</Button>
            <Button onClick={() => setTeilFrage(false)}>Abbrechen</Button>
          </div>
        </div>
      )}
    </Block>
  );
}
