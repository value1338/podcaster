// Projektdetail mit Reitern Aufnahmen/Exporte (Referenz 12/13). Besitzer AP5.
import {
  Archive, ArchiveRestore, AudioLines, Check, ChevronRight, CircleAlert, Download, Ellipsis, FileWarning, Folder, HardDriveDownload,
  Mic, Pencil, RotateCw, Trash2, Upload, Video,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Badge, Button, buttonClass, EmptyState, ErrorState, Menu, PageSpinner, Spinner, type MenuItem } from "../../components";
import { api, ApiError, type Capabilities, type Export, type ExportFormat, type ProjectDetail, type Recording, type Track, type Usage } from "../../lib/api";
import { useSitzung } from "../../lib/sitzung";
import { formatBytes, formatDateTime, formatDuration, formatResolution, plural } from "../../lib/format";
import {
  aufnahmeDauer, aufnahmeZustand, bergungsInput, EXPORT_TEXT, exportFormate, FORMAT_TEXT, laeuftArbeit, letzterExport,
  originalFormat, SPUR_TEXT, SPUR_TON, spurZustand,
} from "./logik";
import { Erstellt } from "./Erstellt";
import { SpurTranskript } from "./SpurTranskript";
import { TitelDialog } from "./TitelDialog";

/** Dienstfähigkeiten, Verbrauch und Rolle für die Spurzeilen (PA8). null = (noch) unbekannt. */
interface Umfeld { cap: Capabilities | null; usage: Usage | null; owner: boolean; neuLaden: () => Promise<void> }

const POLL_MS = 2000;

/** Lädt das Projekt und pollt alle 2 s, solange etwas hochlädt/verarbeitet/exportiert (Umsetzung §5). */
function useProjekt(id: string) {
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try { setData(await api.getProject(id)); setError(null); } catch (e) { setError(e); }
  }, [id]);
  useEffect(() => { setData(null); setError(null); load(); }, [load]);
  const working = data ? laeuftArbeit(data) : false;
  // setTimeout-Kette statt setInterval: keine überlappenden Anfragen; endet, sobald nichts mehr läuft.
  useEffect(() => {
    if (!working) return;
    const t = setTimeout(load, POLL_MS);
    return () => clearTimeout(t);
  }, [data, error, working, load]);
  return { data, setData, error, load, working };
}

/** /projekte/:projektId (Reiter Aufnahmen), …/exporte (tab="exporte") und …/erstellt (tab="erstellt", PA9). */
export function ProjektSeite({ tab }: { tab: "aufnahmen" | "exporte" | "erstellt" }) {
  const { projektId = "" } = useParams();
  const { data, setData, error, load, working } = useProjekt(projektId);
  const [umbenennen, setUmbenennen] = useState(false);
  const [cap, setCap] = useState<Capabilities | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const owner = useSitzung().info?.user?.role === "owner";
  // Fehler hier sind nicht blockierend: ohne Fähigkeiten entscheidet der Server (503 configuration_required wird angezeigt).
  useEffect(() => { api.capabilities().then(setCap, () => setCap(null)); }, [projektId]);
  const ladenUsage = useCallback(() => api.usage().then(setUsage, () => {}), []);
  useEffect(() => { void ladenUsage(); }, [ladenUsage]);
  const neuLaden = useCallback(async () => { await load(); void ladenUsage(); }, [load, ladenUsage]);

  if (!data) {
    if (error instanceof ApiError && error.status === 404) return (
      <div className="page">
        <EmptyState icon={Folder} title="Projekt nicht gefunden" text="Das Projekt existiert nicht (mehr) oder der Link ist falsch."
          action={<Link to="/projekte" className={buttonClass("secondary")}>Zu den Projekten</Link>} />
      </div>
    );
    return (
      <div className="page">
        {error ? <ErrorState title="Projekt konnte nicht geladen werden" error={error} onRetry={load} /> : <PageSpinner label="Projekt wird geladen …" />}
      </div>
    );
  }

  const exportCount = data.recordings.reduce((n, r) => n + r.tracks.reduce((m, t) => m + t.exports.length, 0), 0);

  return (
    <div className="page projekte-detail">
      <div className="page__head">
        <nav className="projekte-brotkrumen" aria-label="Brotkrumen">
          <Link to="/projekte">Projekte</Link>
          <ChevronRight size={18} aria-hidden />
          <h1 aria-current="page">{data.title}</h1>
        </nav>
        <Menu label="Projektaktionen" trigger={<Ellipsis size={18} aria-hidden />}
          items={[{ label: "Umbenennen", icon: Pencil, onSelect: () => setUmbenennen(true) }]} />
        <Link to={`/hochladen?projekt=${data.id}`} className={buttonClass("secondary")}><Upload size={18} aria-hidden />Hochladen</Link>
        <Link to={`/studio/${data.id}`} className={buttonClass("primary")}><Mic size={18} aria-hidden />Aufnehmen</Link>
      </div>

      <nav className="projekte-reiter" aria-label="Projektbereiche">
        <Link to={`/projekte/${data.id}`} aria-current={tab === "aufnahmen" ? "page" : undefined}>Aufnahmen</Link>
        <Link to={`/projekte/${data.id}/erstellt`} aria-current={tab === "erstellt" ? "page" : undefined}>Erstellt für Dich</Link>
        <span aria-disabled="true" title="Kommt in einer späteren Stufe">Bearbeitungen <Badge tone="spaeter">Später</Badge></span>
        <Link to={`/projekte/${data.id}/exporte`} aria-current={tab === "exporte" ? "page" : undefined}>
          Exporte{exportCount ? <span className="projekte-reiter__zahl">{exportCount}</span> : null}
        </Link>
      </nav>

      <p className="u-sr-only" aria-live="polite">{working ? "Verarbeitung läuft, Ansicht aktualisiert sich automatisch." : ""}</p>
      {error ? <ErrorState compact title="Aktualisierung fehlgeschlagen" error={error} onRetry={load} /> : null}

      {tab === "aufnahmen" ? <Aufnahmen projekt={data} umfeld={{ cap, usage, owner, neuLaden }} />
        : tab === "erstellt" ? <Erstellt projekt={data} llm={cap?.llm} />
        : <Exporte projekt={data} reload={load} />}

      {umbenennen && (
        <TitelDialog heading="Projekt umbenennen" submitLabel="Speichern" initial={data.title} onClose={() => setUmbenennen(false)}
          onSave={async (title) => { const p = await api.renameProject(data.id, title); setData({ ...data, ...p }); setUmbenennen(false); }} />
      )}
    </div>
  );
}

// ───────────────────────── Reiter Aufnahmen ─────────────────────────

function Aufnahmen({ projekt, umfeld }: { projekt: ProjectDetail; umfeld: Umfeld }) {
  const [params, setParams] = useSearchParams();
  const recs = projekt.recordings;
  const [loeschen, setLoeschen] = useState<string | null>(null);
  const [loeschFehler, setLoeschFehler] = useState<string | null>(null);
  if (!recs.length) return (
    <EmptyState icon={Mic} title="Noch keine Aufnahme" text="Nimm im Studio auf – die Spur erscheint hier, sobald der Upload beginnt."
      action={<Link to={`/studio/${projekt.id}`} className={buttonClass("primary")}><Mic size={18} aria-hidden />Aufnehmen</Link>} />
  );
  const rec = recs.find((r) => r.id === params.get("aufnahme")) ?? recs[0];

  return (
    <div className="projekte-aufnahmen">
      {recs.length > 1 && (
        <section aria-labelledby="projekte-auswahl-titel" className="projekte-auswahl">
          <h2 id="projekte-auswahl-titel" className="u-sr-only">Aufnahmen ({recs.length})</h2>
          <ul>
            {recs.map((r) => {
              const z = aufnahmeZustand(r);
              return (
                <li key={r.id}>
                  <button type="button" className="projekte-auswahl__eintrag" aria-current={r.id === rec.id || undefined}
                    onClick={() => setParams((p) => { p.set("aufnahme", r.id); return p; }, { replace: true })}>
                    <span className="projekte-auswahl__titel">{r.title}</span>
                    <span className="projekte-auswahl__meta">
                      <span>{formatDateTime(r.createdAt)}</span>
                      <span className="u-mono">{formatDuration(aufnahmeDauer(r))}</span>
                      {z && z !== "bereit" && <Badge tone={SPUR_TON[z]}>{SPUR_TEXT[z]}</Badge>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <Player rec={rec} />
      <div className="projekte-aufnahme-kopf">
        <div>
          <h2>{rec.title}</h2>
          <p className="u-muted">Aufgenommen am {formatDateTime(rec.createdAt)}</p>
        </div>
        <Button size="sm" variant="ghost" icon={Trash2} disabled={loeschen === rec.id} onClick={async () => {
          if (!confirm(`„${rec.title}“ endgültig löschen? Spuren, Exporte und Transkript werden entfernt.`)) return;
          setLoeschen(rec.id); setLoeschFehler(null);
          try { await api.deleteRecording(rec.id); setParams((p) => { p.delete("aufnahme"); return p; }, { replace: true }); await umfeld.neuLaden(); }
          catch (e) { setLoeschFehler(e instanceof ApiError ? e.message : "Löschen fehlgeschlagen."); }
          finally { setLoeschen(null); }
        }}>Aufnahme löschen</Button>
      </div>
      {loeschFehler && <p role="alert" className="projekte-loeschfehler">{loeschFehler}</p>}

      <section aria-labelledby="projekte-spuren-titel">
        <h2 id="projekte-spuren-titel" className="projekte-abschnitt">Spuren</h2>
        <ul className="projekte-spuren">
          {rec.tracks.map((t) => <SpurZeile key={t.id} track={t} projektId={projekt.id} umfeld={umfeld} />)}
        </ul>
      </section>
    </div>
  );
}

/** Player direkt auf die Range-Datei des Servers (kein Blob). */
function Player({ rec }: { rec: Recording }) {
  const t = rec.tracks.find((x) => x.kind === "video" && abspielbar(x)) ?? rec.tracks.find(abspielbar);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => setFehler(null), [t?.id]);

  if (!t) {
    const z = aufnahmeZustand(rec);
    return (
      <div className="projekte-player projekte-player--leer">
        {z === "fehlgeschlagen" ? <CircleAlert size={28} aria-hidden />
          : z === "unvollstaendig" ? <FileWarning size={28} aria-hidden />
          : <Spinner size={28} label="Noch nicht abspielbar" />}
        <p>{z === "fehlgeschlagen" ? "Keine abspielbare Datei – siehe Spuren." : z === "unvollstaendig" ? "Aufnahme unvollständig – siehe Spuren." : "Abspielbar, sobald die Verarbeitung fertig ist."}</p>
      </div>
    );
  }
  const src = api.trackFileUrl(t.id);
  const onError = () => setFehler("Die Datei konnte nicht geladen werden. Server erreichbar? Download unten versuchen.");
  return (
    <div className="projekte-player">
      {t.kind === "video"
        ? <video key={t.id} controls preload="metadata" playsInline src={src} onError={onError} aria-label={`Wiedergabe: ${rec.title}`} />
        : (
          <div className="projekte-player__audio">
            <AudioLines size={48} aria-hidden className="projekte-player__icon" />
            <audio key={t.id} controls preload="metadata" src={src} onError={onError} aria-label={`Wiedergabe: ${rec.title}`} />
          </div>
        )}
      {t.durationMs != null && <span className="projekte-player__dauer u-mono">{formatDuration(t.durationMs)}</span>}
      {fehler && <p className="projekte-player__fehler" role="alert">{fehler}</p>}
    </div>
  );
}

/** Lokal vorhanden und fertig – ausgelagerte Spuren liefert der Server nicht (409 not_local). */
const abspielbar = (t: Track) => t.status === "ready" && t.local !== false;

function StatusZeile({ track }: { track: Track }) {
  const z = spurZustand(track);
  const icon: Record<typeof z, ReactNode> = {
    hochladen: <Upload size={16} aria-hidden />,
    unvollstaendig: <FileWarning size={16} aria-hidden />,
    verarbeitung: <Spinner size={16} label="Wird verarbeitet" />,
    bereit: <Check size={16} aria-hidden />,
    fehlgeschlagen: <CircleAlert size={16} aria-hidden />,
  };
  const detail =
    z === "hochladen" || z === "unvollstaendig"
      ? `${plural(track.receivedChunks, "Abschnitt", "Abschnitte")} empfangen${track.lastChunkAt ? `, zuletzt ${formatDateTime(track.lastChunkAt)}` : ""}`
      : null;
  return (
    <span className={`projekte-status projekte-status--${z}`}>
      {icon[z]}<span>{SPUR_TEXT[z]}</span>{detail && <span className="projekte-status__detail">· {detail}</span>}
    </span>
  );
}

function SpurZeile({ track: t, projektId, umfeld }: { track: Track; projektId: string; umfeld: Umfeld }) {
  const reload = umfeld.neuLaden;
  const archivBereit = umfeld.cap?.archive.state === "ready";
  const hochgeladen = t.source === "upload";
  const [hinweis, setHinweis] = useState<string | null>(null);
  const z = spurZustand(t);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<unknown>(null);
  const [bestaetigen, setBestaetigen] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setFehler(null);
    try { await fn(); await reload(); } catch (e) { setFehler(e); } finally { setBusy(false); setBestaetigen(false); }
  };
  const finalize = () => run(() => api.finalizeTrack(t.id, bergungsInput(t)));
  const exportieren = (f: ExportFormat) => run(() => api.createExport(t.id, f));
  const auftrag = (fn: () => Promise<unknown>, text: string) => run(async () => { await fn(); setHinweis(text); });
  // Archivieren/Auslagern nur, wenn der Dienst wirklich bereit ist (PA5); sonst gar nicht anbieten.
  const verwaltung: MenuItem[] = umfeld.owner && archivBereit && t.status === "ready" && t.local !== false ? [
    ...(t.archive?.status === "none" || t.archive?.status === "failed" || !t.archive
      ? [{ label: "Archivieren", hint: "Geprüfte Kopie ins Archiv", icon: Archive, disabled: busy,
          onSelect: () => auftrag(() => api.admin.archiveTrack(t.id), "Archivierung eingereiht.") }] : []),
    ...(t.archive?.status === "verified"
      ? [{ label: "Auslagern", hint: "Lokale Kopie nach erneuter Prüfung entfernen", icon: HardDriveDownload, disabled: busy,
          onSelect: () => auftrag(() => api.admin.evictTrack(t.id), "Auslagern eingereiht.") }] : []),
  ] : [];
  const Icon = t.kind === "video" ? Video : Mic;
  return (
    <li className="projekte-spur">
      <div className="projekte-spur__zeile">
        <span className="projekte-kachel projekte-kachel--klein" aria-hidden><Icon size={20} /></span>
        <div className="projekte-spur__name">
          <span className="projekte-spur__titel">{t.participantName}</span>
          <StatusZeile track={t} />
        </div>
        <span className="projekte-spur__mess u-mono">{formatDuration(t.durationMs)}</span>
        <span className="projekte-spur__mess projekte-spur__format">
          {[formatResolution(t.width, t.height), originalFormat(t.mimeType), t.bytes ? formatBytes(t.bytes) : ""].filter(Boolean).join(" · ")}
        </span>
        <div className="projekte-spur__aktionen">
          {z === "bereit" && t.local === false
            ? <Button icon={ArchiveRestore} disabled={busy || !archivBereit} title={archivBereit ? undefined : "Archiv ist nicht eingerichtet"}
                onClick={() => auftrag(() => api.restoreTrack(t.id), "Zurückholen eingereiht – danach wieder abspielbar.")}>Zurückholen</Button>
            : z === "bereit"
            ? <DownloadMenu track={t} onExport={exportieren} busy={busy} />
            : <Button icon={Download} disabled title="Erst nach der Verarbeitung">Herunterladen</Button>}
          {verwaltung.length > 0 && <Menu label="Spurverwaltung" items={verwaltung} trigger={<Ellipsis size={18} aria-hidden />} />}
        </div>
      </div>

      {(t.local === false || (t.archive && t.archive.status !== "none")) && (
        <p className="projekte-spur__archiv">
          {t.local === false && <Badge tone="warn">Im Archiv</Badge>}
          {t.archive?.status === "verified" && <span>Archivkopie geprüft{t.archive.verifiedAt ? ` am ${formatDateTime(t.archive.verifiedAt)}` : ""}</span>}
          {(t.archive?.status === "queued" || t.archive?.status === "copying") && <span>Archivierung läuft</span>}
          {t.archive?.status === "failed" && <span>Archivierung fehlgeschlagen{t.archive.error ? `: ${t.archive.error}` : ""}</span>}
          {t.local === false && !archivBereit && <span>Zurückholen derzeit nicht möglich: Archiv nicht eingerichtet.</span>}
        </p>
      )}

      {z === "bereit" && t.local !== false && (
        <SpurTranskript track={t} projektId={projektId} asr={umfeld.cap?.asr ?? null} usage={umfeld.usage} reload={reload} />
      )}

      {z === "fehlgeschlagen" && (
        <ErrorState compact title="Verarbeitung fehlgeschlagen"
          message={<>{t.error ?? "Der Server konnte die Aufnahme nicht abschließen."} Die Rohdaten bleiben erhalten.</>}
          actions={<>
            <Button size="sm" icon={RotateCw} onClick={finalize} disabled={busy}>Erneut verarbeiten</Button>
            {t.hasRaw && (
              <a className={buttonClass("secondary", "sm")} href={api.trackFileUrl(t.id, { raw: true, download: true })} download>
                <Download size={16} aria-hidden />Rohdatei herunterladen
              </a>
            )}
          </>} />
      )}

      {hochgeladen && z === "unvollstaendig" && (
        <div className="projekte-bergung" role="group" aria-label="Unterbrochener Upload">
          <p>Der Upload ist unterbrochen. Er lässt sich unter „Hochladen“ mit derselben Datei an der letzten bestätigten Stelle fortsetzen.</p>
          <Link className={buttonClass("secondary", "sm")} to={`/hochladen?projekt=${projektId}`}><Upload size={16} aria-hidden />Zum Hochladen</Link>
        </div>
      )}

      {!hochgeladen && z === "unvollstaendig" && (
        <div className="projekte-bergung" role="group" aria-label="Unvollständige Spur bergen">
          <p>
            Seit über zwei Minuten kam kein Abschnitt mehr an. Am vollständigsten wird die Aufnahme, wenn du die App im Browser öffnest,
            in dem aufgenommen wurde – dort wird die Wiederherstellung angeboten.
          </p>
          {!bestaetigen ? (
            <Button size="sm" onClick={() => setBestaetigen(true)} disabled={busy || t.receivedChunks < 1}>Trotzdem abschließen</Button>
          ) : (
            <div className="projekte-bergung__frage" role="alert">
              <p>
                Gesichert wird nur, was der Server schon hat: {plural(t.receivedChunks, "Abschnitt", "Abschnitte")} (≈ {formatDuration(bergungsInput(t).durationMs)}).
                Abschnitte, die noch im Aufnahme-Browser liegen, können danach nicht mehr ergänzt werden.
              </p>
              <Button size="sm" variant="danger" onClick={finalize} disabled={busy}>Ja, jetzt abschließen</Button>
              <Button size="sm" variant="ghost" onClick={() => setBestaetigen(false)} disabled={busy}>Abbrechen</Button>
            </div>
          )}
        </div>
      )}

      {hinweis && <p className="projekte-transkript__hinweis" role="status">{hinweis}</p>}
      {fehler ? <ErrorState compact title="Aktion fehlgeschlagen" error={fehler} /> : null}
    </li>
  );
}

function DownloadMenu({ track: t, onExport, busy }: { track: Track; onExport: (f: ExportFormat) => void; busy: boolean }) {
  const items: MenuItem[] = [{
    label: `Original (${originalFormat(t.mimeType)})`,
    hint: t.bytes ? `Sofort · ${formatBytes(t.bytes)}` : "Sofort",
    icon: Download,
    href: api.trackFileUrl(t.id, { download: true }),
    download: true,
  }];
  for (const f of exportFormate(t)) {
    const e = letzterExport(t, f);
    const zusatz = (t.kind === "video" && f !== "mp4" ? " · nur Ton" : "") + (f === "wav" ? " (aus komprimierter Aufnahme)" : "");
    const label = FORMAT_TEXT[f] + zusatz;
    if (!e) items.push({ label, hint: "Export erstellen", icon: AudioLines, onSelect: () => onExport(f), disabled: busy });
    else if (e.status === "ready") items.push({ label, hint: `Bereit${e.bytes ? ` · ${formatBytes(e.bytes)}` : ""}`, icon: Download, href: api.exportFileUrl(e.id), download: true, end: <Badge tone="ok">Bereit</Badge> });
    else if (e.status === "failed") items.push({ label, hint: `Fehlgeschlagen – erneut versuchen`, icon: RotateCw, onSelect: () => onExport(f), disabled: busy, end: <Badge tone="error">Fehler</Badge> });
    else items.push({ label, hint: "Wird vorbereitet …", icon: AudioLines, disabled: true, end: <Spinner size={16} label="Wird vorbereitet" /> });
  }
  return (
    <Menu label="Herunterladen" items={items} triggerClassName={buttonClass("secondary")}
      trigger={<><Download size={18} aria-hidden />Herunterladen</>} />
  );
}

// ───────────────────────── Reiter Exporte ─────────────────────────

function Exporte({ projekt, reload }: { projekt: ProjectDetail; reload: () => Promise<void> }) {
  const rows = projekt.recordings.flatMap((r) => r.tracks.flatMap((t) => t.exports.map((e) => ({ r, t, e }))))
    .sort((a, b) => b.e.createdAt.localeCompare(a.e.createdAt));
  if (!rows.length) return (
    <EmptyState icon={Download} title="Noch keine Exporte"
      text="MP3 und WAV (bei Video auch MP4) entstehen auf Wunsch aus einer fertigen Spur: im Reiter Aufnahmen über „Herunterladen“."
      action={<Link to={`/projekte/${projekt.id}`} className={buttonClass("secondary")}>Zu den Aufnahmen</Link>} />
  );
  return (
    <ul className="projekte-spuren" aria-label="Exporte">
      {rows.map(({ r, t, e }) => <ExportZeile key={e.id} rec={r} track={t} exp={e} reload={reload} />)}
    </ul>
  );
}

function ExportZeile({ rec, track, exp: e, reload }: { rec: Recording; track: Track; exp: Export; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<unknown>(null);
  const erneut = async () => {
    setBusy(true); setFehler(null);
    try { await api.createExport(track.id, e.format); await reload(); } catch (err) { setFehler(err); } finally { setBusy(false); }
  };
  // Ein älterer fehlgeschlagener Export, der inzwischen ersetzt wurde, braucht kein „Erneut“ mehr.
  const ersetzt = e.status === "failed" && letzterExport(track, e.format)?.id !== e.id;
  return (
    <li className="projekte-spur">
      <div className="projekte-spur__zeile">
        <span className="projekte-kachel projekte-kachel--klein projekte-kachel--format" aria-hidden>{e.format.toUpperCase()}</span>
        <div className="projekte-spur__name">
          <span className="projekte-spur__titel">{rec.title} · {track.participantName}</span>
          <span className={`projekte-status projekte-status--export-${e.status}`}>
            {e.status === "ready" ? <Check size={16} aria-hidden /> : e.status === "failed" ? <CircleAlert size={16} aria-hidden /> : <Spinner size={16} label="Wird vorbereitet" />}
            <span>{EXPORT_TEXT[e.status]}</span>
            <span className="projekte-status__detail">· {FORMAT_TEXT[e.format]}{e.format === "wav" ? " aus komprimierter Aufnahme" : ""}</span>
          </span>
        </div>
        <span className="projekte-spur__mess">{formatDateTime(e.finishedAt ?? e.createdAt)}</span>
        <span className="projekte-spur__mess u-mono">{formatBytes(e.bytes)}</span>
        <div className="projekte-spur__aktionen">
          {e.status === "ready" && (
            <a className={buttonClass("secondary")} href={api.exportFileUrl(e.id)} download><Download size={18} aria-hidden />Herunterladen</a>
          )}
          {e.status === "failed" && !ersetzt && <Button icon={RotateCw} onClick={erneut} disabled={busy}>Erneut</Button>}
          {ersetzt && <span className="u-muted">Ersetzt</span>}
        </div>
      </div>
      {e.status === "failed" && e.error && <p className="projekte-spur__fehlertext">{e.error}</p>}
      {fehler ? <ErrorState compact title="Export konnte nicht gestartet werden" error={fehler} /> : null}
    </li>
  );
}
