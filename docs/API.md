# Podcast-Studio – HTTP-API v1

Maßgeblich im Code. Quelle: `Planung/Umsetzung.md` §5 (Stand 2026-11-20). Besitzer nach AP0: AP1 (Projekte/Spuren) und AP2 (Exporte).

## Änderungsprotokoll

Jede Vertragsänderung hier oben eintragen: Datum · Paket · was · warum. Abhängige Pakete (AP3/AP5/AP7) informiert der Hauptagent.

| Datum | Paket | Änderung | Grund |
|---|---|---|---|
| 2026-11-23 | KI-Dienste | LLM/ASR-Anbindung nicht mehr über Umgebung, sondern `PUT /api/admin/settings` (nur owner): `llmBaseUrl`, `llmApiKey`, `llmReasoningEffort`, `llmTimeoutMs`, `asrUrl`, `asrToken`, `asrTimeoutMs`. Secrets write-only (`llmApiKeySet`/`asrTokenSet`), `''` = unverändert, `null` = entfernen. Wirkt ohne Neustart. `missing` meldet jetzt `llm.baseUrl`/`llm.apiKey`/`asr.url`/`asr.token`. Altbestand: `node server/cli.mjs settings:import-env`. Siehe §KI-Dienste unten. | Veröffentlichung ohne private Standardendpunkte. |
| 2026-11-23 | Deploy | Erststart: fehlt `studio.sqlite`, initialisiert der Server die DB selbst (Bestands-DBs weiter nur per `cli.mjs migrate`). Ohne eingerichteten owner + `STUDIO_ADMIN_EMAIL` → Einmal-Setup-Link (24 h) in `<DATA_DIR>/admin-einrichtung.txt` (0600) und einmal im Log; idempotent (gültiger Link bleibt). `setupRequired` = kein owner mit Kennwort (Login bis dahin 503). `STUDIO_HOST` frei wählbar, Standard 127.0.0.1. | Deploybar für Dritte (README, Dockerfile, compose, systemd-Vorlage). |
| 2026-11-20 | RA3 | Optionales STUDIO_LLM_REASONING_EFFORT; validierte Werte none/low/medium/high, ungesetzt kein zusätzliches Feld. | Explizite Betreibersteuerung ohne Modell-/Preisänderung. |
| 2026-11-20 | PA5 | Mount-Archiv, additive Snapshots, Restore/Evict, Owner-/Mitgliedmatrix und reale Archivzustände; Details unten. | Prüfsummenschutz und fehlende Unraid-Konfiguration offenlegen. |
| 2026-11-20 | PA0 | Additive v2-Typen/Client, X-Studio, same-origin, Abmeldeereignis; Schema/CLI isoliert vorbereitet. Neue HTTP-Routen erst PA1–PA5. | Plattformfundament, kein Deploy. |
| 2026-11-20 | F1/F2 Integration | Clientmethoden `health`, `createRecording`, `getTrack`, `finalizeTrack` akzeptieren optional `AbortSignal`; vorhandenes `putChunk` ebenfalls. Fristablauf meldet `ApiError` mit `code=timeout` und wird als wiederholbarer Verbindungsfehler behandelt. | Echte Request-Abbrüche bei hängendem Abschluss/Recovery; keine Änderung des HTTP-Serververtrags. |
| 2026-11-20 | Integration F3 | Projektantworten enthalten zusätzlich `recordingTitles: string[]`. Die Projektsuche berücksichtigt diese Titel ohne weitere Detailabfragen. | Scope fordert Suche nach Projekt- und Aufnahmetiteln; bisher wurden nur Projekttitel gefunden. |
| 2026-11-20 | AP1/AP2 | Implementierung ohne Änderung der Erfolgsantworten. Gleichzeitige Uploads derselben Spur bzw. Abschluss während Upload → 409 `upload_busy` (wiederholen). `chunkCount` 1–100000, `durationMs` 0–604800000, `allowPartial` boolean. Typ und MIME-Basistyp müssen zusammenpassen. | Grenzen und konkurrierende Schreibzugriffe explizit; Client lädt seriell. |
| 2026-11-20 | AP0 | Erstfassung aus Umsetzung.md §5. Präzisiert (nicht widersprüchlich): Erfolgsantworten von `POST /projects` = 201 `Project`; `PATCH` = 200 `Project`; `POST …/recordings` = 201; `finalize` = 202 bzw. 200 jeweils mit `Track`; Fehler 405 `method_not_allowed`. | Antwortkörper waren in §5 teils offen; Client (`src/lib/api.ts`) braucht feste Typen. AP1 darf abweichen, muss es dann hier eintragen. |

## Grundsätze

- Alle Pfade relativ zur Basis (`VITE_BASE`, z. B. `/podcast/` → `/podcast/api/...`). Der Server akzeptiert Pfade mit und ohne `STUDIO_BASE_PATH`-Präfix.
- JSON UTF-8, `cache-control: no-store`. Zeiten ISO 8601 UTC.
- Fehler **immer**: `{ "error": { "code": "…", "message": "deutscher Klartext", …zusatz } }` mit passendem HTTP-Status. Zusatzfelder (z. B. `missing`) liegen im selben Objekt; der Client stellt sie als `ApiError.details` bereit.
- IDs erzeugt der Server (`crypto.randomUUID()`). **Kein Dateiname oder Pfadteil stammt je vom Client.**
- Statusabfrage per Polling alle 2 s, nur solange etwas `uploading`/`processing`/`queued` ist. Kein Löschen in v1.

## Typen

Identisch in `src/lib/api.ts` (dort maßgeblich für TypeScript).

```ts
type TrackStatus  = 'uploading' | 'processing' | 'ready' | 'failed';
type ExportStatus = 'queued' | 'processing' | 'ready' | 'failed';
type ExportFormat = 'mp3' | 'wav' | 'mp4';            // 'mp4' nur für Videospuren

interface Project   { id: string; title: string; createdAt: string; recordingCount: number; lastRecordingAt: string|null }
interface ProjectDetail extends Project { recordings: Recording[] }   // neueste Aufnahme zuerst
interface Recording { id: string; projectId: string; title: string; createdAt: string; tracks: Track[] }
interface Track {
  id: string; recordingId: string; participantName: string; kind: 'audio'|'video'; source: 'studio';
  mimeType: string; status: TrackStatus; error: string|null;
  receivedChunks: number;          // lückenlos ab 0 empfangen
  bytes: number|null; durationMs: number|null; width: number|null; height: number|null;
  sha256: string|null; startedAtMs: number|null;   // Client-Uhr, für spätere Mehrspur-Synchronisation
  lastChunkAt: string|null; hasRaw: boolean; exports: Export[];
}
interface Export { id: string; trackId: string; format: ExportFormat; status: ExportStatus; error: string|null; bytes: number|null; createdAt: string; finishedAt: string|null }
interface Health { ok: boolean; version: string; freeBytes: number; ffmpeg: boolean }
```

## Endpunkte

| Methode & Pfad | Antwort | Besonderheiten |
|---|---|---|
| `GET /api/health` | 200 `Health` | Studio blockiert Start bei `freeBytes < 10 GB` (`MIN_FREE_BYTES`) |
| `GET /api/projects` | 200 `Project[]` | |
| `POST /api/projects` `{title}` | 201 `Project` | Titel 1–120 Zeichen, getrimmt; sonst 400 |
| `GET /api/projects/:id` | 200 `ProjectDetail` | 404 `not_found` |
| `PATCH /api/projects/:id` `{title}` | 200 `Project` | |
| `POST /api/projects/:id/recordings` `{title, kind, mimeType, participantName, startedAtMs}` | 201 `{recording, track}` | Legt Aufnahme + eine Spur an. `mimeType`-Basistyp gegen Positivliste `audio/webm`, `video/webm`, `audio/mp4`, `video/mp4`, sonst 415 |
| `PUT /api/tracks/:id/chunks/:index` Roh-Body | 200 `{receivedChunks}` | **Idempotent** (gleicher Index überschreibt atomar: temp-Datei + `rename`). `index` 0…99999. Max. 64 MB je Abschnitt → 413. Nur bei Status `uploading`, sonst 409. Body wird gestreamt, nie im RAM gepuffert. |
| `GET /api/tracks/:id` | 200 `Track` | Wiederaufsetzen: Client lädt ab `receivedChunks` nach |
| `POST /api/tracks/:id/finalize` `{chunkCount, durationMs, allowPartial?}` | 202 `Track` (Status `processing`) | Fehlt ein Abschnitt < `chunkCount`: 409 `chunks_missing` mit `{missing:[…]}`. `allowPartial:true` finalisiert den lückenlosen Anfang (Bergung). Erneuter Aufruf bei `processing`/`ready` ist folgenlos (200 `Track`). Bei `failed`: neuer Versuch. |
| `GET /api/tracks/:id/file` | Datei `original.<ext>` | `Range` (206). `?download=1` → `Content-Disposition: attachment`, Name serverseitig bereinigt `<Projekt> – <Aufnahme>.<ext>`. `?raw=1` liefert `roh.<ext>` (nur bei `failed`). |
| `POST /api/tracks/:id/exports` `{format}` | 202 `Export` | Vorhandener `ready`/laufender Export gleichen Formats wird zurückgegeben statt doppelt erzeugt. Nur bei Spur `ready` (sonst 409). |
| `GET /api/exports/:id` | 200 `Export` | |
| `GET /api/exports/:id/file` | Datei, `attachment`, Range | 409 solange nicht `ready` |

## Verarbeitung (Server, AP1/AP2)

- Finalisierung: Abschnitte 0…n-1 der Reihe nach → `roh.<ext>` → `ffmpeg -i roh -c copy` → `original.<ext>` (WebM: Dauer/Cues; MP4: `-movflags +faststart`) → `ffprobe` (Dauer, Auflösung) → SHA-256 → `ready` → erst dann `abschnitte/` löschen. Reparatur fehlgeschlagen: `failed`, `roh.<ext>` + Abschnitte bleiben, gekürzter ffmpeg-Fehlertext.
- Exporte: `mp3` = libmp3lame 192k; `wav` = pcm_s16le 48 kHz; `mp4` = libx264 `-preset veryfast -crf 20` + aac 192k, `+faststart`. Temp-Datei, bei Erfolg `rename`.
- Eine In-Prozess-Warteschlange, ein ffmpeg gleichzeitig, Zeitlimit 4 × Mediendauer (mind. 5 min), `spawn` mit Argument-Array. Beim Start `processing`-Spuren und `queued`/`processing`-Exporte neu einreihen.
- Dateiendungen: `audio/webm`, `video/webm` → `.webm`; `audio/mp4` → `.m4a`; `video/mp4` → `.mp4`.

## Client (`src/lib/api.ts`)

```ts
import { api, ApiClient, ApiError } from "../lib/api";
await api.listProjects();                       // Project[]
await api.createProject("Folge 1");             // Project
await api.getProject(id);                       // ProjectDetail
await api.renameProject(id, "Neu");             // Project
await api.createRecording(projectId, {title, kind, mimeType, participantName, startedAtMs}); // {recording, track}
await api.putChunk(trackId, index, blob, signal?); // {receivedChunks}
await api.getTrack(trackId);                    // Track
await api.finalizeTrack(trackId, {chunkCount, durationMs, allowPartial?}); // Track
api.trackFileUrl(trackId, {download?, raw?});   // string – für <audio src> oder <a href download>
await api.createExport(trackId, "mp3");         // Export
await api.getExport(exportId);                  // Export
api.exportFileUrl(exportId);                    // string
await api.health();                             // Health
```

Fehler: jede Methode wirft `ApiError { status, code, message, details, isNetwork }`. Netzwerkfehler → `status 0`, `code "network"`; Abbruch per `AbortSignal` → `code "aborted"`.

## Entwicklungs-Stub (`server/stub.mjs`, nur bis AP7)

In-Memory, keine Platte, **keine Mediendateien** (`…/file` → 501 `stub_no_media`). `finalize` → nach `STUB_DELAY_MS` (Standard 2000) `ready` mit `durationMs` aus der Anfrage; Exporte `queued` → `processing` → `ready`. `STUB_FREE_BYTES` steuert `freeBytes`.

```bash
STUDIO_PORT=8862 npm run stub                    # Stub auf 127.0.0.1:8862
PORT=5192 API=http://127.0.0.1:8862 npm run dev  # Vite-Dev mit /api-Proxy dorthin
```

## Echter Server (AP1/AP2)

Start: `node server/index.mjs` aus App/, vorhandene Umgebungsvariablen wie oben. `STUDIO_HOST` darf nur `127.0.0.1` sein. Kein neuer npm-Befehl angelegt (Konfiguration gehört AP0/Hauptagent). API und dist werden im selben Prozess ausgeliefert; ohne dist liefern Seitenaufrufe 404.

Serverprüfungen isoliert und seriell: `npx vitest run test/server --maxWorkers=1` (eine Testsuite verwendet exklusiv Port 8861). Keine parallelen Testläufe auf demselben Port. Streamingprüfung schreibt temporär gut 2 GiB (Chunks + Rohdatei), entfernt ausschließlich ihr eigenes Tempverzeichnis.


# Plattform HTTP v2 – Vertrag, noch keine aktiven Routen

PA0 implementiert ausschließlich Client und Datenbankwerkzeuge. Die nachstehenden Routen folgen in PA1–PA5.

## 3. Datenbank (Schema-Version 1, `PRAGMA user_version = 1`)

Bestehende Tabellen `projects`, `recordings`, `tracks`, `exports` behalten exakt die Form `(id TEXT PRIMARY KEY, data TEXT NOT NULL)` – dadurch läuft der v1-Servercode unverändert auf einer migrierten Datenbank (Rollback, Erweiterung §7). Zugehörigkeit steht **im JSON**:

- Neues JSON-Feld `ownerId: string` in allen vier Tabellen (bei Anlage geschrieben, von Projekt geerbt). Zeilen **ohne** `ownerId` sind „unzugeordnet“: über HTTP für niemanden sichtbar, nur über die CLI zuweisbar.
- `tracks.data` zusätzlich: `source`, `uploadBytes` (Summe empfangener Abschnitte, solange `uploading`), `archive` (§5), `local` (fehlend = `true`).

```sql
CREATE INDEX IF NOT EXISTS projects_owner    ON projects  (json_extract(data,'$.ownerId'));
CREATE INDEX IF NOT EXISTS recordings_owner  ON recordings(json_extract(data,'$.ownerId'));
CREATE INDEX IF NOT EXISTS recordings_proj   ON recordings(json_extract(data,'$.projectId'));
CREATE INDEX IF NOT EXISTS tracks_owner      ON tracks    (json_extract(data,'$.ownerId'));
CREATE INDEX IF NOT EXISTS tracks_rec        ON tracks    (json_extract(data,'$.recordingId'));
CREATE INDEX IF NOT EXISTS exports_owner     ON exports   (json_extract(data,'$.ownerId'));
CREATE INDEX IF NOT EXISTS exports_track     ON exports   (json_extract(data,'$.trackId'));

CREATE TABLE plans(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  asr_seconds_month INTEGER, llm_tokens_month INTEGER, llm_cost_micro_month INTEGER,
  storage_bytes INTEGER, active_jobs INTEGER,          -- NULL = unbegrenzt
  updated_at TEXT NOT NULL);
CREATE TABLE users(
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('owner','member')),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  password_hash TEXT,                                   -- NULL bis Einrichtung
  status TEXT NOT NULL CHECK(status IN('active','disabled')),
  created_at TEXT NOT NULL, last_login_at TEXT);
CREATE UNIQUE INDEX users_one_owner ON users(role) WHERE role='owner';
CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT);
CREATE TABLE tokens(                                    -- Einladung, Ersteinrichtung, Kennwort-Rücksetzung
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN('invite','setup','reset')),
  user_id TEXT REFERENCES users(id),                    -- setup/reset
  email TEXT, plan_id TEXT REFERENCES plans(id),        -- invite
  created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE usage(                                     -- Reservierung und Verbuchung, eine Zeile je Auftrag+Zähler+Konto
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,           -- Konto-ID oder '*' (Plattform gesamt)
  meter TEXT NOT NULL CHECK(meter IN('asr_seconds','llm_tokens','llm_cost_micro')),
  period TEXT NOT NULL,                                 -- 'YYYY-MM' (UTC) zum Zeitpunkt der Reservierung
  job_id TEXT NOT NULL, reserved INTEGER NOT NULL, used INTEGER,
  status TEXT NOT NULL CHECK(status IN('reserved','committed','released')),
  note TEXT, created_at TEXT NOT NULL, settled_at TEXT,
  UNIQUE(job_id, meter, user_id));
CREATE INDEX usage_sum ON usage(user_id, meter, period, status);
CREATE TABLE jobs(
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('asr','llm','archive','restore','evict')),
  subject_type TEXT NOT NULL CHECK(subject_type IN('track','project')), subject_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('queued','running','succeeded','failed','canceled')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
  error_code TEXT, error_message TEXT,
  input TEXT NOT NULL,                                  -- JSON, unveränderlich
  state TEXT,                                           -- JSON, Fortschritt (z. B. fertige ASR-Fenster)
  result TEXT,                                          -- JSON, z. B. {transcriptId} / {generationId}
  idem_key TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  UNIQUE(owner_id, idem_key));
CREATE INDEX jobs_work ON jobs(status, kind, next_attempt_at);
CREATE INDEX jobs_subject ON jobs(subject_type, subject_id, kind);
CREATE TABLE transcripts(
  id TEXT PRIMARY KEY, track_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, job_id TEXT NOT NULL,
  language TEXT, model TEXT NOT NULL, device TEXT NOT NULL, timestamps TEXT NOT NULL CHECK(timestamps IN('word','segment','none')),
  duration_ms INTEGER NOT NULL,
  segments TEXT NOT NULL,                               -- JSON, aktueller (bearbeitbarer) Stand
  machine TEXT NOT NULL,                                -- JSON, unveränderte Maschinenfassung
  edited INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE generations(
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT NOT NULL, track_id TEXT, job_id TEXT NOT NULL,
  task TEXT NOT NULL, content TEXT NOT NULL, data TEXT,  -- data: JSON (z. B. Kapitel)
  provider TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cost_micro INTEGER, usage_estimated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL);
CREATE INDEX generations_project ON generations(project_id, created_at);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, subject TEXT, detail TEXT);
```

Verbindung: `PRAGMA journal_mode=WAL; synchronous=FULL; foreign_keys=ON; busy_timeout=5000` (Server **und** CLI greifen zu).

`db.mjs` neu (v1-Funktionen bleiben): `get(table,id)` per Primärschlüssel statt Vollscan; `where(table, feld, wert)` mit festem Feld-Whitelist `ownerId|projectId|recordingId|trackId` über die Indizes; `tx(fn)` = `BEGIN IMMEDIATE … COMMIT/ROLLBACK`.

**Startwerte der Pläne (vorläufig, in der Verwaltung änderbar, keine Verkaufspreise):**

| id | ASR/Monat | LLM-Token/Monat | LLM-Kosten/Monat | Speicher | aktive Aufträge |
|---|---|---|---|---|---|
| `intern` (nur Eigentümer) | ∞ | ∞ | ∞ | ∞ | 4 |
| `free` | 60 min | 200 000 | – | 10 GB | 1 |
| `pro` | 600 min | 3 000 000 | – | 200 GB | 3 |

Zusätzlich Plattform-Deckel (Konto `*`): `settings['llm.globalCostMicroMonth']` und `settings['llm.globalTokensMonth']` (Start: 5 000 000 Token, Kosten-Deckel `null`, bis Preise gepflegt sind).

## 4. Kontingent-Vertrag (`server/quota.mjs`)

```ts
type Meter = 'asr_seconds' | 'llm_tokens' | 'llm_cost_micro';
// Alle drei laufen synchron in EINER BEGIN-IMMEDIATE-Transaktion, ohne await dazwischen.
reserve(userId: string, jobId: string, wants: { meter: Meter; amount: number }[]): void   // wirft problem(402,'quota_exceeded',…)
commit (jobId: string, actual: { meter: Meter; used: number }[], note?: string): void
release(jobId: string, note: string): void
usageOf(userId: string, period?: string): Usage
storageUsed(userId: string): number        // Σ bytes(tracks ready, lokal ODER archiviert) + Σ uploadBytes(uploading) + Σ bytes(exports ready)
activeJobs(userId: string): number         // jobs.status IN ('queued','running')
```

Regeln (jede ist ein Abnahmepunkt):
1. **Belegt** = Σ `used` (committed) + Σ `reserved` (reserved) der Periode. `reserve` prüft je Zähler `belegt + amount ≤ limit` für das Konto **und** für `*`; eine Überschreitung → nichts wird geschrieben.
2. `reserve` ist je `(jobId, meter, user)` idempotent: vorhandene Zeile `reserved`/`committed` → kein zweiter Eintrag; vorhandene Zeile `released` (Wiederholung eines gescheiterten Auftrags) → Prüfung erneut, Zeile zurück auf `reserved`.
3. `commit` wirkt nur auf `reserved` → zweiter Aufruf ist folgenlos. `used` darf `reserved` überschreiten (tatsächlicher Verbrauch gilt), wird dann im `note` vermerkt.
4. `release` wirkt nur auf `reserved`.
5. Auftrag anlegen = `reserve` + `INSERT jobs` in **derselben** Transaktion. Auftrag endet = Statuswechsel + `commit`/`release` + Ergebniszeile (`transcripts`/`generations`) in **derselben** Transaktion.
6. Periode ist die der Reservierung, auch wenn der Auftrag über den Monatswechsel läuft.
7. Speicher ist kein Periodenzähler, sondern wird beim Anlegen geprüft (§5.3). Laufende Studioaufnahmen werden **nie** wegen Kontingent abgewiesen.

Fehlerkörper (`meter` hier zusätzlich `'storage_bytes'`): `402 {error:{code:'quota_exceeded', message, meter, limit, used, reserved, requested, resetsAt, scope:'account'|'platform'}}`.

## 5. HTTP-Vertrag v2 (Ergänzungen)

Grundsätze wie v1. Zusätzliche Kopfzeile `Idempotency-Key` (1–64 Zeichen `[A-Za-z0-9_-]`) bei allen auftragserzeugenden POSTs: gleiches Konto + gleicher Schlüssel → **derselbe** Auftrag wird zurückgegeben (200 statt 202), keine zweite Reservierung.

### 5.1 Sitzung und Konto

| Methode & Pfad | Anfrage | Antwort | Fehler |
|---|---|---|---|
| `GET /api/session` | – | 200 `SessionInfo` | – |
| `POST /api/auth/login` | `{email, password}` | 200 `{user: Me}` + Cookie | 401 `invalid_credentials` · 429 `rate_limited` · 503 `setup_required` (noch kein Eigentümer) |
| `POST /api/auth/logout` | – | 204, Cookie gelöscht | – |
| `GET /api/auth/token/:token` | – | 200 `TokenInfo` | 404 `token_invalid` (unbekannt, benutzt, abgelaufen – nicht unterscheidbar) |
| `POST /api/auth/token/:token` | `{password, displayName?, email?}` | 200 `{user: Me}` + Cookie; Token verbraucht | 404 `token_invalid` · 400 `invalid_input` · 409 `email_taken` |
| `POST /api/account/password` | `{currentPassword, newPassword}` | 204 | 401 `invalid_credentials` · 400 |
| `GET /api/account/usage` | – | 200 `Usage` | – |
| `GET /api/capabilities` | – | 200 `Capabilities` | – |

`invite`: legt das Konto an (`email` aus dem Token, sonst aus dem Körper; `displayName` Pflicht 1–120). `setup`/`reset`: setzt nur das Kennwort. Es gibt **keinen** Endpunkt, der ohne gültiges Token ein Konto anlegt.

### 5.2 Verwaltung (nur `role='owner'`, sonst 404 `not_found`)

| Methode & Pfad | Anfrage | Antwort |
|---|---|---|
| `GET /api/admin/users` | – | `AdminUser[]` (mit `usage`) |
| `PATCH /api/admin/users/:id` | `{planId?, status?, displayName?}` | `AdminUser` · 409 `owner_protected` (Eigentümer nicht sperr-/herabstufbar) |
| `POST /api/admin/users/:id/reset-link` | – | 201 `InviteLink` (Kennwort-Rücksetzung, 60 min, löscht Sitzungen erst beim Einlösen) |
| `GET /api/admin/invites` | – | `Invite[]` (ohne Token) |
| `POST /api/admin/invites` | `{email?, planId, expiresInHours?}` (1–336, Standard 168) | 201 `InviteLink` – der Link wird **nur hier einmal** gezeigt |
| `DELETE /api/admin/invites/:id` | – | 204 (nur unbenutzte) |
| `GET /api/admin/plans` · `PUT /api/admin/plans/:id` | `Plan` ohne `id` | `Plan[]` / `Plan` (ganze nicht-negative Zahlen oder `null`) |
| `GET /api/admin/settings` · `PUT /api/admin/settings` | `SettingsPatch` (Secrets `llmApiKey`/`asrToken`: string setzen, `''` unverändert, `null` entfernen) | `Settings` (Secrets nur als `llmApiKeySet`/`asrTokenSet`) |
| `GET /api/admin/usage?period=YYYY-MM` | – | `AdminUsage` |
| `GET /api/admin/archive` | – | `ArchiveStatus` (frischer Preflight) |
| `POST /api/admin/tracks/:id/archive` · `…/evict` | – | 202 `Job` |

Kein Mailversand: Links werden vom Eigentümer kopiert und selbst weitergegeben.

### 5.3 Projekte, Aufnahmen, Hochladen

- Listen liefern nur Zeilen mit `ownerId = Sitzungskonto`. `POST /api/projects` setzt `ownerId`.
- `POST /api/projects/:id/recordings` zusätzlich `{source?: 'studio'|'upload', declaredBytes?: number}`.
  - `source:'studio'` (Standard): 402 `quota_exceeded` (`meter:'storage_bytes'`), wenn `storageUsed ≥ limit`. Danach werden Abschnitte dieser Spur **nie** wegen Kontingent abgelehnt; die Spur kann das Limit überschreiten (`Usage.storageBytes.used > limit` → blockiert neue Aufnahmen/Uploads/Exporte, nicht Downloads).
  - `source:'upload'`: `declaredBytes` Pflicht (1 … 50 GiB); 402, wenn `storageUsed + declaredBytes > limit`. Abschnitts-PUT → 413 `too_large`, sobald `uploadBytes` > `declaredBytes`. `participantName` Pflicht wie bisher, `startedAtMs: null` erlaubt.
- `POST /api/tracks/:id/exports`: 402 bei Speicher über Limit.
- Auslieferung `GET /api/tracks/:id/file`: `local === false` → 409 `not_local` `{archive:'verified'}`.

### 5.4 Aufträge

| Methode & Pfad | Antwort | Besonderheiten |
|---|---|---|
| `GET /api/jobs/:id` | `Job` | 404 für fremde |
| `GET /api/jobs?active=1&projectId=…` | `Job[]` | nur eigene, neueste zuerst, höchstens 100 |
| `POST /api/jobs/:id/retry` | 202 `Job` | nur `failed`; **gleiche** Auftrags-ID, neue Reservierung nach §4 Regel 2; 402 möglich |
| `POST /api/jobs/:id/cancel` | 200 `Job` | `queued` → sofort `canceled` + `release`; `running` → Abbruch angefordert, Ergebnis wird verworfen, `release` |

Polling wie v1 (2 s), solange `queued`/`running`.

### 5.5 Transkription

| Methode & Pfad | Anfrage | Antwort | Fehler |
|---|---|---|---|
| `POST /api/tracks/:id/transcription` | `{language?: string\|null, replaceEdited?: boolean}` | 202 `Job` (`kind:'asr'`); läuft schon einer für die Spur → 200 dieser Auftrag | 409 `not_ready` · 409 `not_local` · 409 `transcript_edited` (bearbeitetes Transkript vorhanden, `replaceEdited` fehlt) · 402 · 503 `configuration_required` · 409 `jobs_limit` |
| `GET /api/tracks/:id/transcript` | – | 200 `Transcript` | 404 `no_transcript` |
| `PATCH /api/tracks/:id/transcript` | `{revision, segments: {id, text}[]}` | 200 `Transcript` (`revision+1`, `edited:true`) | 409 `revision_conflict` `{revision}` · 400 (unbekannte `id`, Text > 2000 Zeichen) |
| `POST /api/tracks/:id/transcript/reset` | `{revision}` | 200 `Transcript` (Maschinenfassung, `edited:false`) | 409 `revision_conflict` |
| `GET /api/tracks/:id/transcript/file?format=txt\|srt\|vtt` | – | Datei, `attachment`, Name `<Projekt> – <Aufnahme>.<format>` | 404 `no_transcript` · 400 `invalid_format` |

- `language`: BCP-47-Kurzcode (`de`, `en`, …) oder `null` = automatische Erkennung durch das Modell.
- Reserviert werden `ceil(track.durationMs/1000)` `asr_seconds`; verbucht dieselbe Zahl bei Erfolg. Fehlschlag/Abbruch → `release`. Neue Transkription einer bereits transkribierten Spur ist ein **neuer** Auftrag und wird neu berechnet (Oberfläche sagt das vor dem Klick).
- Ein neues Ergebnis ersetzt das vorhandene Transkript erst bei Erfolg (in der Abschluss-Transaktion). Scheitert der Auftrag, bleibt das alte unverändert.
- Bearbeitung: nur Text je Segment; Zeiten, Reihenfolge und Anzahl sind in v2 fest. Leerer Text ist erlaubt (Segment wird in Exporten übersprungen).
- Dateiformate (reine Funktionen in `server/transcripts.mjs`, Unit-Tests):
  - **TXT**: Absätze je Segment, davor `[hh:mm:ss]`; Kopfzeile `Sprecher: <participantName>`.
  - **SRT/VTT**: ein Eintrag je Segment; Segmente > 7 s oder > 84 Zeichen werden an Wortgrenzen geteilt, wenn `timestamps==='word'`, sonst proportional zur Zeichenzahl. Bei `timestamps==='none'` → 409 `no_timestamps` für SRT/VTT (TXT bleibt möglich).
- **Sprechertrennung (Diarisierung) gibt es nicht.** `speaker` ist immer `null`; als Sprecher gilt der Teilnehmername der Spur. Mehrere Personen an einem Mikrofon werden nicht unterschieden – die Oberfläche sagt das im Transkript-Kopf.

### 5.6 Text-KI

| Methode & Pfad | Anfrage | Antwort | Fehler |
|---|---|---|---|
| `POST /api/llm/estimate` | `GenerationInput` ohne `consent` | 200 `LlmEstimate` | wie unten, ohne Reservierung |
| `POST /api/projects/:id/generations` | `GenerationInput` | 202 `Job` (`kind:'llm'`) | 400 `consent_required` · 409 `no_transcript` · 413 `input_too_large` · 402 · 503 `configuration_required` · 409 `jobs_limit` |
| `GET /api/projects/:id/generations` | – | `Generation[]` neueste zuerst | – |
| `GET /api/generations/:id` | – | `Generation` | 404 |
| `GET /api/generations/:id/file` | – | `content` als `text/markdown`, `attachment` | 404 |

- `consent` muss exakt `{provider, model, dataScope}` aus der aktuellen `Capabilities.llm` bzw. dem `LlmEstimate` enthalten; Abweichung (z. B. Modell inzwischen umgestellt) → 400 `consent_required` mit den aktuellen Werten. Zeitpunkt und Inhalt der Einwilligung stehen in `jobs.input`.
- Der Server sendet **ausschließlich**: Systemanweisung der Aufgabe, Projekt- und Aufnahmetitel, Teilnehmername, Transkripttext mit Segment-Zeitmarken (`transcript_text`) bzw. den Aufnahmebrief (`brief_text`). Nie Audio, Video, E-Mail, Konto-IDs, andere Projekte.
- Es gibt keinen automatischen Aufruf (kein „nach Transkription Shownotes erzeugen“).
- Reservierung: `llm_tokens = ceil(Zeichen/2.5) + maxOutputTokens`; `llm_cost_micro` aus `settings['llm.prices']` (fehlen Preise → 0, und ein gesetzter Kosten-Deckel führt zu 503 `configuration_required`). Verbuchung: gemeldete `input+output`-Token; meldet der Anbieter keine Nutzung → reservierter Wert, `usage_estimated=1`.
- Kein automatischer zweiter Anbieteraufruf, sobald eine Anfrage vollständig abgeschickt wurde und unklar endet (Zeitüberschreitung, Verbindungsabbruch nach dem Senden): Auftrag `failed` `llm_unclear`, `release` mit `note='nach_versand_unklar'` (für den Eigentümer in `AdminUsage.unclear` sichtbar). Wiederholung nur durch den Nutzer.

Aufgaben (`task`), alle Antworten deutsch, sofern das Transkript deutsch ist, sonst in dessen Sprache:

| task | Quelle | Ergebnis `content` (Markdown) | `data` | maxOutputTokens |
|---|---|---|---|---|
| `shownotes` | Transkript | Zusammenfassung, Themenliste, genannte Links/Namen nur wenn im Text | – | 1500 |
| `chapters` | Transkript | Kapitelliste `hh:mm:ss Titel` | `{chapters:[{startMs,title}]}` – jeder `startMs` muss exakt ein Segmentbeginn sein, sonst wird das Ergebnis verworfen (`llm_bad_response`) | 800 |
| `titles` | Transkript | 10 Titelvorschläge | `{titles:string[]}` | 500 |
| `social` | Transkript | je ein Entwurf LinkedIn, Instagram, Kurzpost | – | 1500 |
| `marketer_plan` | Transkript | Veröffentlichungsplan: Kernbotschaft, Zielgruppe, 3 Zitate **mit Zeitmarke**, Newsletter-Absatz | – | 2500 |
| `producer_outline` | Aufnahmebrief (1–4000 Zeichen) | Gliederung, Einstieg, Fragenliste, Zeitplan | – | 2000 |

### 5.7 Archiv

| Methode & Pfad | Antwort | Fehler |
|---|---|---|
| `POST /api/tracks/:id/restore` | 202 `Job` (`kind:'restore'`) – eigene Spur aus dem Archiv zurückholen | 409 `already_local` · 503 `archive_unavailable` |

Archivieren und Auslagern stößt nur die Plattform an (`settings['archive.mode']`, Verwaltung §5.2). Ablauf und Schutzregeln: §7.3.

### 5.8 Fehlercodes (neu)

`unauthenticated` 401 · `invalid_credentials` 401 · `csrf` 403 · `rate_limited` 429 · `setup_required` 503 · `token_invalid` 404 · `email_taken` 409 · `owner_protected` 409 · `quota_exceeded` 402 · `jobs_limit` 409 · `configuration_required` 503 `{service:'asr'|'llm'|'archive', missing:string[]}` (Namen fehlender Einstellungen, nie Werte) · `not_local` 409 · `already_local` 409 · `no_transcript` 404/409 · `transcript_edited` 409 · `revision_conflict` 409 · `no_timestamps` 409 · `consent_required` 400 · `input_too_large` 413 · `archive_unavailable` 503.
Auftragsfehler (`Job.errorCode`): `asr_unavailable`, `asr_gpu_required`, `asr_timeout`, `asr_rejected`, `asr_bad_response`, `llm_unavailable`, `llm_rejected`, `llm_bad_response`, `llm_unclear`, `archive_unavailable`, `archive_conflict`, `archive_checksum`, `archive_space`, `interrupted`, `internal`.

## 6. TypeScript-Typen (`src/lib/api.ts`, PA0 übernimmt wörtlich)

```ts
export type Role = "owner" | "member";
export interface Me { id: string; email: string; displayName: string; role: Role; plan: { id: string; name: string } }
export interface SessionInfo { user: Me | null; setupRequired: boolean }
export interface TokenInfo { kind: "invite" | "setup" | "reset"; email: string | null; expiresAt: string }

export interface MeterState { used: number; reserved: number; limit: number | null }   // limit null = unbegrenzt
export interface Usage {
  period: string;                 // "2026-11"
  resetsAt: string;               // ISO, erster des Folgemonats 00:00 UTC
  asrSeconds: MeterState; llmTokens: MeterState;
  storageBytes: MeterState;       // reserved immer 0
  activeJobs: MeterState;         // reserved immer 0
}

export type ServiceState = "ready" | "configuration_required" | "unavailable";
export interface Capabilities {
  asr: { state: ServiceState; model: string | null; device: "cuda" | "cpu" | "unknown" | null;
         timestamps: "word" | "segment" | "none" | null; diarization: false; missing: string[] };
  llm: { state: ServiceState; provider: "openai" | null; model: string | null;
         dataScopes: LlmDataScope[]; missing: string[] };
  archive: { state: ServiceState; mode: "off" | "manual" | "auto"; missing: string[] };
  upload: { maxBytes: number; mimeTypes: string[] };
}

export type TrackSource = "studio" | "upload";
export type ArchiveState = "none" | "queued" | "copying" | "verified" | "failed";
export interface TrackArchive { status: ArchiveState; verifiedAt: string | null; error: string | null }
export interface TrackTranscription {
  status: "none" | "queued" | "running" | "ready" | "failed";
  jobId: string | null;           // laufender oder letzter Auftrag
  edited: boolean; updatedAt: string | null;
}
// Track (v1) erhält additiv:
//   source: TrackSource; local: boolean; archive: TrackArchive; transcription: TrackTranscription;
export interface CreateRecordingInput {            // ersetzt v1-Fassung
  title: string; kind: TrackKind; mimeType: string; participantName: string;
  startedAtMs: number | null; source?: TrackSource; declaredBytes?: number;
}

export type JobKind = "asr" | "llm" | "archive" | "restore" | "evict";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export interface Job {
  id: string; kind: JobKind; status: JobStatus;
  subject: { type: "track" | "project"; id: string };
  progress: { done: number; total: number } | null;   // ASR: Fenster; Archiv: Bytes
  attempts: number; nextAttemptAt: string | null;      // gesetzt, solange auf Wiederholung gewartet wird
  errorCode: string | null; errorMessage: string | null;
  result: { transcriptId?: string; generationId?: string } | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}

export interface TranscriptWord { startMs: number; endMs: number; text: string }
export interface TranscriptSegment {
  id: string;                      // stabil innerhalb eines Transkripts ("s0001" …)
  startMs: number; endMs: number; text: string;
  speaker: null;                   // keine Diarisierung
  words: TranscriptWord[] | null;  // null, wenn der Dienst keine Wortzeiten liefert ODER das Segment bearbeitet wurde
  edited: boolean;
}
export interface Transcript {
  id: string; trackId: string; language: string | null; model: string; device: "cuda" | "cpu" | "unknown";
  timestamps: "word" | "segment" | "none"; durationMs: number;
  edited: boolean; revision: number; segments: TranscriptSegment[];
  createdAt: string; updatedAt: string;
}
export type TranscriptFormat = "txt" | "srt" | "vtt";

export type LlmTask = "shownotes" | "chapters" | "titles" | "social" | "marketer_plan" | "producer_outline";
export type LlmDataScope = "transcript_text" | "brief_text";
export interface LlmConsent { provider: "openai"; model: string; dataScope: LlmDataScope }
export interface GenerationInput { task: LlmTask; trackId?: string; brief?: string; consent: LlmConsent }
export interface LlmEstimate {
  provider: "openai"; model: string; dataScope: LlmDataScope;
  inputChars: number; reserveTokens: number; maxOutputTokens: number;
  remainingTokens: number | null;  // null = unbegrenzt
  allowed: boolean;                // false = würde quota_exceeded liefern
}
export interface Generation {
  id: string; projectId: string; trackId: string | null; task: LlmTask;
  content: string; data: { chapters?: { startMs: number; title: string }[]; titles?: string[] } | null;
  provider: "openai"; model: string;
  inputTokens: number | null; outputTokens: number | null; usageEstimated: boolean;
  createdAt: string;
}

// Verwaltung
export interface Plan { id: string; name: string; asrSecondsMonth: number | null; llmTokensMonth: number | null;
  llmCostMicroMonth: number | null; storageBytes: number | null; activeJobs: number | null }
export interface AdminUser { id: string; email: string; displayName: string; role: Role; planId: string;
  status: "active" | "disabled" | "pending" /* pending = abgeleitet: active ohne Kennwort */; createdAt: string; lastLoginAt: string | null; usage: Usage }
export interface Invite { id: string; email: string | null; planId: string; createdAt: string; expiresAt: string; usedAt: string | null }
export interface InviteLink { id: string; url: string; expiresAt: string }   // url nur in dieser Antwort
export interface Settings {
  llmModel: string;                                   // ^[A-Za-z0-9._:-]{1,64}$
  llmPrices: { inputMicroPerMTok: number; outputMicroPerMTok: number } | null;   // Mikro-USD je 1 Mio. Token
  llmGlobalTokensMonth: number | null; llmGlobalCostMicroMonth: number | null;
  asrRequireGpu: boolean; asrWindowSeconds: number;   // 60–1200
  archiveMode: "off" | "manual" | "auto"; archiveEvictAfterDays: number | null;  // null = nie auslagern
}
export interface AdminUsage { period: string;
  platform: { llmTokens: MeterState; llmCostMicro: MeterState; asrSeconds: MeterState };
  users: { userId: string; email: string; usage: Usage; llmCostMicro: number }[];
  unclear: { jobId: string; userId: string; at: string; reservedTokens: number }[] }
export interface ArchiveStatus { state: ServiceState; driver: "mount" | "ssh" | null; archiveId: string | null;
  freeBytes: number | null; checkedAt: string; error: string | null;
  counts: Record<ArchiveState, number>; evicted: number }
```

Client-Methoden (Namen fest, damit UI und Tests parallel entstehen können):

```ts
api.session(); api.login(email, password); api.logout();
api.tokenInfo(token); api.redeemToken(token, { password, displayName?, email? });
api.changePassword(currentPassword, newPassword); api.usage(); api.capabilities();
api.getJob(id, signal?); api.listJobs({ active?, projectId? }); api.retryJob(id); api.cancelJob(id);
api.startTranscription(trackId, { language?, replaceEdited? }, idemKey);
api.getTranscript(trackId); api.saveTranscript(trackId, { revision, segments });
api.resetTranscript(trackId, revision); api.transcriptFileUrl(trackId, format);
api.estimateGeneration(projectId, input); api.createGeneration(projectId, input, idemKey);
api.listGenerations(projectId); api.getGeneration(id); api.generationFileUrl(id);
api.restoreTrack(trackId);
api.admin.users(); api.admin.updateUser(id, patch); api.admin.resetLink(id);
api.admin.invites(); api.admin.createInvite(input); api.admin.revokeInvite(id);
api.admin.plans(); api.admin.savePlan(plan); api.admin.settings(); api.admin.saveSettings(patch);
api.admin.usage(period?); api.admin.archive(); api.admin.archiveTrack(id); api.admin.evictTrack(id);
```

`ApiClient.request` setzt `X-Studio: 1` und `credentials: "same-origin"`. 401 `unauthenticated` löst genau ein Ereignis `studio:abgemeldet` auf `window` aus (kein automatisches Navigieren – das Studio darf eine laufende Aufnahme nicht verlassen).


## PA0-Präzisierungen
- `Track.local/archive/transcription` sind optional, solange v1-Antworten keine Felder liefern; fehlendes local bedeutet true.
- `estimateGeneration(projectId,input)` sendet projectId zusätzlich im Körper an `/llm/estimate` (Projektkontext für brief_text).
- Bestehende optionalen AbortSignal-/Timeout-Verträge bleiben erhalten.
- 401 unauthenticated: ein Ereignis pro Fehlerfolge, erfolgreiche Anfrage setzt die Erkennung zurück. Kein Navigieren.
- X-Studio ist nur ein Header, kein Sicherheitsnachweis. STUDIO_ORIGINS und Proxyvertrauen/X-Forwarded-For müssen PA1 unabhängig prüfen; Loopback allein begründet kein Vertrauen.
- v1-Kompatibilität ist nur Daten-/Funktionskompatibilität. Mehrkundenrollback muss fail closed bleiben; v1 besitzt keine Zugriffssperre.

### PA1-Präzisierungen (2026-11-20)
- Maßgeblicher Entwicklungsserver verlangt Schema 1 und explizite `STUDIO_ORIGINS` auch außerhalb Produktion. Er migriert niemals beim Start. Keine Auth-Ausnahme bei leerer Kontentabelle.
- Herkunft wird exakt gegen `STUDIO_ORIGINS` geprüft. Fehlender Origin wird auch mit `Sec-Fetch-Site: same-origin` abgewiesen. `X-Forwarded-For` und andere Proxyheader werden nicht zur Vertrauensentscheidung verwendet; Rate-Limits nutzen die Socketadresse. Vor öffentlichem Mehrinstanzbetrieb ist ein gesonderter Proxy-/Rate-Limit-Vertrag nötig.
- Kennwortwechsel beendet bewusst auch die aktuelle Sitzung; anschließend neu anmelden. Setup/Reset verbrauchen auch übrige offene Tokens desselben Kontos. Sperren beendet alle Sitzungen.
- `owner:create --email EMAIL --name NAME --output DATEI` und `owner:link --output DATEI` schreiben den Einmal-Link ausschließlich in eine neu angelegte Datei (0600, exklusiv). Standardausgabe enthält keinen Link. `STUDIO_DATA_DIR` muss gezielt gewählt werden. Kein produktiver Bootstrap im PA1-Paket.
- `legacy:claim --owner ID` ist standardmäßig Dry-Run; nur `--confirm` weist unzugeordnete Zeilen transaktional zu. Elternbeziehungen dürfen nicht zu einem anderen Konto führen. Wiederholung weist nichts doppelt zu; Medien werden nicht verändert.
- Konto-/Einladungsrouten aus §5.1/5.2 sind implementiert, ausgenommen Verbrauch/Capabilities sowie Plan-/Einstellungs-/Auftragsverwaltung (PA2–PA5). `AdminUser.usage` wird erst in PA2 ergänzt; bis dahin fehlt dieses Feld ausdrücklich, statt erfundene Verbrauchswerte zu liefern.
- Unauthentifiziertes Health liefert ausschließlich `{ok,version}`. API-Fremdpfade bekommen keinen SPA-Fallback. Alle ID-/Dateirouten verlangen eine Sitzung und prüfen Eigentum; Bestand ohne Owner bleibt unsichtbar.
- Integrationstests auf festem Port 8871 mit `--no-file-parallelism` ausführen. Der ausdrücklich große Streamingtest ist nur mit `STUDIO_TEST_GIB=1` aktiv und wurde in PA1 nicht ausgeführt.

### PA2 – implementierter Serverstand (2026-11-20)

Implementiert: `GET /api/account/usage`, `GET /api/capabilities`, `GET /api/admin/plans`, `PUT /api/admin/plans/:id`, `GET/PUT /api/admin/settings`, `GET /api/admin/usage?period=YYYY-MM`, eigene `GET /api/jobs[?active=1&projectId=…]`, `GET /api/jobs/:id`, `POST /api/jobs/:id/retry|cancel`. AdminUser enthält jetzt reale `usage`. Verwaltungsänderungen an Plänen/Einstellungen werden auditiert. Unbekannte Einstellungsfelder (insbesondere Endpunkte/Secrets) sind 400. Pläne werden vollständig ohne `id` gesendet; nur vorhandene Pläne sind änderbar. `null` bedeutet unbegrenzt. Senken von Limits verändert weder vorhandenen Verbrauch noch laufende Aufnahmen.

Intern: `quota(db)` liefert reserve/commit/release/usageOf/storageUsed/activeJobs sowie checkStorage/checkActive/meterState. Alle Abrechnungsmutationen verwenden BEGIN IMMEDIATE bzw. die bereits aktive äußere Transaktion. `ctx.work.create({ownerId,kind,subjectType,subjectId,input,wants,idemKey})` liefert `{job,reused}`; auftragserzeugende PA3–5-Routen antworten damit 202 bzw. bei `reused` 200. `finish(id,status,result,actual,save,error,note)` speichert synchrones Ergebnis, Abschlussstatus und Settlement atomar. Handler erhalten `{signal,state,ctx}` und liefern `{result,actual,save}`; `save(db)` muss synchron sein. `state({sent:true})` ist vor LLM-Versand synchron zu persistieren. ffmpeg weiterhin ausschließlich über `ctx.jobs`, nicht direkt im persistenten Arbeiter starten.

Der Arbeiter startet getrennte Bahnen (ASR 1, LLM 2, Archiv/Restore/Evict zusammen 1), verarbeitet FIFO, pollt nach 5 s und setzt persistierte Zustände beim Neustart fort. Automatische Wiederholungen brauchen explizites `error.retryable`; LLM nach `sent:true` wird niemals automatisch wiederholt. Abbruch laufender Aufträge markiert `cancelRequested`, signalisiert Abort und verwirft Ergebnisse beim Abschluss. Reservierungen bleiben bis zum tatsächlichen Handlerabschluss bestehen. Fehlende Handler erzeugen keine Scheinergebnisse.

Speicherprüfung nur bei neuer Aufnahme/Upload und Export; Studioabschnitte werden nach erfolgreicher Anlage nie nach Kontoquota gesperrt. uploadBytes zählen tatsächlich angenommene Bytes inklusive nicht zusammenhängender Abschnitte; Überschreiben desselben Index korrigiert die Summe statt doppelt zu zählen. Uploads verlangen declaredBytes (1–50 GiB); Überschreitung wird vor atomarer Übernahme mit 413 abgewiesen. MP3/WAV nur source=upload. Ein ausgelagertes Original liefert 409 not_local; vorhandene Downloads bleiben unabhängig vom Kontingent.

**Paketgrenze:** PA2 liefert keine Diensttreiber und keine ASR-/LLM-/Archiv-Ergebnisse. Capabilities bleiben configuration_required; auftragserzeugende Dienstpfade liefern nach Auth/Besitzprüfung 503 configuration_required. Die endgültigen Dienstprüfungen und auftragserzeugenden HTTP-Routen ersetzt PA3–5. Auch `/api/admin/archive` liefert bis PA5 503 statt eines erfundenen Preflight. Die generische persistente Auftragserzeugung und Idempotenz sind intern geprüft; deren 202/200-HTTP-Integration ist erst mit PA3–5 prüfbar. Keine api.ts-Änderung für PA2 erforderlich.

## Backend-Reviewaddendum 2026-11-20
Maßgebliche Entscheidung: ../Planung/Plattform-Reviewentscheidungen.md (F5 ersetzt V §5.6).
- Login: normalisierte E-Mail (gehasht als Map-Schlüssel), maximal fünf Versuche/15 Minuten vor Hashprüfung; Erfolg löscht den Zähler. Bekannte/unbekannte Konten identisch. Kein Socket-/XFF-Sammellimit. Maximal zwei gleichzeitige Login-/Token-Hashes, sonst 429 mit retryAfterS=1; Token-POST zusätzlich fünf Versuche pro Token/15 Minuten. Nur Tailnet; kein öffentlicher Lastschutz.
- Uploadanlagen prüfen Speicher innerhalb BEGIN IMMEDIATE. Offene Uploads reservieren max(declaredBytes,uploadBytes,rawBytes); Studio bleibt ohne harte laufende Quota. processing/failed zählen max(uploadBytes,rawBytes).
- Work-Handler dürfen {status:'failed',errorCode,actual} zurückgeben oder Fehler mit actual werfen: reale Nutzung wird auch bei Validierungsfehler verbucht, save wird nur bei Erfolg ausgeführt.
- Unklare gesendete LLM-Aufträge: reservierte Werte für Konto UND Plattform committed, note=nach_versand_unklar, state.usageEstimated=true; Jobansicht usageEstimated/unclear. Kein automatischer Neuversand; Fehler llm_unclear, Recovery interrupted.
- Retry bereits verbuchter failed/interrupted LLM: 409 new_job_required mit newJobRequired:true. Neuer Auftrag UND neuer Idempotenzschlüssel erforderlich. Unbezahlte Fehler dürfen dieselbe ID erneut reservieren.
- Shutdown bewahrt laufenden Zustand und Reservierung; Recovery reiht ASR/Archivfamilie/ungesendete LLM erneut ein. Nutzerabbruch bleibt canceled, result=null; möglicher bezahlter LLM-Verbrauch wird dennoch verbucht.

### KI-Dienste in der Verwaltung (2026-11-23, ersetzt Umgebungsvariablen)

LLM und ASR werden ausschließlich vom owner unter Verwaltung → Einstellungen gepflegt
(settings-Schlüssel `llm.baseUrl`, `llm.apiKey`, `llm.reasoningEffort`, `llm.timeoutMs`,
`asr.url`, `asr.token`, `asr.timeoutMs`). Kein Standardendpunkt im Code. URLs: http(s),
ohne Benutzerinfo/Query/Fragment; http ist erlaubt (LAN/Docker), die UI warnt bei Schlüssel
an Nicht-Loopback. Timeouts: LLM 1000–120000 ms, ASR 1000–3600000 ms (Standard je 120000).
Secrets sind write-only, stehen nie in Antworten, Audit oder Fehlermeldungen. Änderungen
bauen die Adapter sofort neu; laufende ASR-Aufträge behalten ihren Adapter. Fehlt etwas,
melden Capabilities `configuration_required` mit `missing` (z. B. `llm.apiKey`).
Bestehende Instanzen: `node server/cli.mjs settings:import-env` übernimmt gesetzte
`STUDIO_LLM_BASE_URL`, `OPENAI_API_KEY`, `STUDIO_LLM_REASONING_EFFORT`, `STUDIO_LLM_TIMEOUT_MS`,
`STUDIO_ASR_URL`, `STUDIO_ASR_TOKEN`, `STUDIO_ASR_TIMEOUT_MS` einmalig (vorhandene DB-Werte
bleiben) und gibt nur `{imported,kept,invalid}` als Variablennamen aus; wirksam ab Neustart
oder nächstem Speichern. Der frühere Standard `https://api.openai.com/v1` wird nicht mehr
angenommen. Die folgenden Abschnitte zu `STUDIO_ASR_*`/`STUDIO_LLM_*` sind historisch.

### PA3 implementiert – ASR-Konfiguration und Grenzen (2026-11-20)

`STUDIO_ASR_DRIVER=studio-asr-v1`, `STUDIO_ASR_URL=http[s]://host[:port][/prefix]`
(ohne Benutzerinfo, Query oder Fragment), `STUDIO_ASR_TOKEN` (eigener serverseitiger
Bearerzugang). Fehlt eine Angabe oder ist der Treiber unbekannt, bleiben Capabilities
und Auftragserzeugung `configuration_required`; POST erzeugt weder Job noch Reservierung.
`STUDIO_ASR_TIMEOUT_MS`: positive ganze Millisekunden, Standard 120000, je HTTP-Anfrage
inklusive Antwortlesen. Abbruch und Timeout verwenden AbortSignal. Keine Redirects.
Keine Konfiguration wurde hier im Betrieb eingerichtet. `fake` ist ausschließlich für
Tests und bei production verboten. Kein Rezepti-Zugriff, kein stiller CPU-Ersatz.

Sollprotokoll des HTTP-Treibers (noch kein bestätigter Unraid-Dienst):

- GET `<URL>/v1/health`, Bearer-Auth; Antwort `{ok:true,model,device,timestamps,maxAudioSeconds}`.
  `device`: cuda/cpu/unknown; `timestamps`: word/segment/none; maximale Sekunden positiv oder null.
- POST `<URL>/v1/transcriptions[?language=de]`, Bearer-Auth, `Content-Type: audio/wav`,
  `X-Request-Id: <Job-ID>-<Fensterindex>` (ab 0); gestreamtes WAV mono/16kHz/s16le.
  Antwort `{text,language,model,device,segments:[{start,end,text,words?:[{start,end,word}]}]}`;
  Zeiten in Sekunden relativ zum Fenster. Optional `timestamps` wie Health;
  alternativ `words` auf oberster Ebene. Wort-/Segmentzeiten müssen monoton, endlich
  und im jeweiligen Fenster liegen. Keine Zeiten: `timestamps:none`, Text je Fenster;
  SRT/VTT liefern 409 `no_timestamps`. JSON-Antworten maximal 8 MiB.
- 429/5xx/Netzfehler: wiederholbar; 400/413 und andere 4xx: asr_rejected;
  ungültige Ergebnisse: asr_bad_response. Wartezeiten: 30s/2m/5m/15m/30m/60m,
  danach failed/release. Timeout: asr_timeout. Keine zusätzlichen Kostenversprechen.

`settings.asrRequireGpu` lehnt gemeldetes cpu mit `asr_gpu_required` wiederholbar ab;
unknown bleibt laut Vertrag erlaubt und wird als unknown gespeichert. cuda ist eine
Dienstangabe, kein vom Server unabhängig gemessener GPU-Nachweis. Zeiten werden
strukturell geprüft; ihre akustische Genauigkeit ist erst mit T10 zu beurteilen.
Keine Diarisierung, speaker bleibt null.

Fenstergrenzen und abgeschlossene Antworten stehen in jobs.state; nach Prozessabbruch
werden Grenzen übernommen und nur fehlende Fenster angefragt. Medienaufbereitung läuft
über die vorhandene ffmpeg-Warteschlange, Arbeitsdateien separat unter arbeit/asr/Job-ID.
Das eigene Arbeitsverzeichnis wird nach jedem Versuch entfernt; Originalmedien bleiben
unverändert. Bei hartem Prozessabbruch verbleibende Arbeitsdateien werden beim Fortsetzen
neu erzeugt und anschließend entfernt. silencedetect-Auswertung verwendet die letzten
256 KiB Diagnoseausgabe; bei extrem vielen Stilleereignissen können frühere Schnitte
auf harte Fenstergrenzen zurückfallen.

Transkript-Ersetzung/Revision und Verbrauchsabschluss sind atomar. Bearbeitungen während
eines laufenden Jobs werden ohne vorheriges replaceEdited nicht überschrieben. Track-
JSON wird dafür nicht geschrieben; Transkriptstatus wird beim Lesen frisch abgeleitet.
Neue Transkription zählt erneut, Idempotency-Key liefert 200 denselben Job statt 202.
Downloads unterstützen GET/HEAD/Range; fremde Spuren antworten identisch zu unbekannten
mit 404. TXT/SRT/VTT werden aus dem aktuellen Bearbeitungsstand erzeugt. Wortzeiten
bearbeiteter Segmente werden verworfen; dann sind Unterteilungen proportional und
keine gemessenen Wortzeiten.

N4: SQLite-Abschlussfehler wegen locked/busy behalten das fertige Settlement im Prozess
und die Reservierung. Der nächste 5s-Scheduler-Tick wiederholt nur dessen Transaktion,
keinen Handler/Anbieter. node:sqlite bleibt synchron: ein Lock kann weiterhin bis 5s
pro Schreibversuch alle API-Anfragen blockieren. Der frühere doppelte Abschlussversuch
konnte rund 10s blockieren; eine asynchrone DB-Architektur ist hier nicht eingeführt.
Bei Prozessverlust greift das persistente Fenster-Recovery; das In-Memory-Settlement
selbst ist nicht crashpersistent.

### PA4 implementiert – Text-KI (2026-11-20)

Routen §5.6 sind implementiert: estimate benötigt zusätzlich projectId im Body;
Generierung nur ausdrücklich per POST mit exakt `{provider,model,dataScope}` als
consent. Quelle und Modell/Preise werden bei Anlage eingefroren, Einwilligung und
Zeitpunkt stehen in jobs.input. Keine automatische Generierung. Idempotency-Key:
202 neu, 200 dieselbe ID; Wiederverwendung für andere Ressource/Jobart → 409
idempotency_conflict. Eigene Generationen lesen/listen; Datei nur content als
Markdown-Attachment, GET/HEAD/einfacher Byte-Range. Fremde/unbekannte IDs → 404.

Konfiguration: STUDIO_LLM_DRIVER=openai, OPENAI_API_KEY ausschließlich Dienstumgebung,
STUDIO_LLM_BASE_URL optional (Standard https://api.openai.com/v1). HTTPS erforderlich,
HTTP nur Loopback für Testanbieter. Keine Redirects/Benutzerinfo/Query/Fragmente.
STUDIO_LLM_TIMEOUT_MS 1–120000, Standard 120000; Frist umfasst Fetch UND Bodylesen.
STUDIO_LLM_REASONING_EFFORT optional: exakt `none`, `low`, `medium` oder `high`.
Ungesetzt wird kein `reasoning_effort` gesendet; der bisherige Body bleibt erhalten.
Gesetzt wird der Wert unverändert als Chat-Completions-Feld `reasoning_effort` gesendet.
Andere Werte (auch leer, andere Großschreibung oder Leerzeichen) werfen bei
Adaptererzeugung `Ungültiges STUDIO_LLM_REASONING_EFFORT`, ohne Wertausgabe.
Die Prüfung validiert die Konfiguration, nicht jede Modell-/Anbieterkombination.
Modellspezifische Unterstützung ist vor Aktivierung zu prüfen; am 2026-11-20
führen die offiziellen Modellkarten für [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
und [Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra.md) alle vier
Werte auf (jeweils Anbieterstandard medium). Kein App-Default und kein automatischer
Modellfallback. Modell, Preise, Consent und Abrechnung bleiben unverändert.
Laut [Chat-Referenz](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
umfasst max_completion_tokens sichtbare Ausgabe und Reasoning-Tokens.
Das von Fable im Bestandscheck vermutete Abschneiden bei 500–2500 Tokens ist
keine Messung; Qualität, reale Usage und Kosten bleiben Gegenstand von L9.

Antwort maximal 1 MiB. Abort beendet auch das Warten der Lane; keine SDK-Retries.
Fake nur bei NODE_ENV=test, sonst Startfehler. Modell (`llm.model`) und Preise
(`llm.prices`) müssen ausdrücklich gepflegt sein; fehlen sie, 503 configuration_required.
Capabilities ready bedeutet vollständig konfiguriert, keinen bestätigten API-Zugang.

HTTP: POST /chat/completions; Bearer, system/user messages, max_completion_tokens,
response_format json_object, store:false, stream:false. Keine Tools, Dateien,
Nutzerkennungen oder Konto-E-Mail; nur Projekt-/Aufnahmetitel, Teilnehmername und
aktuelle Transkriptsegmente (bei none ohne Zeiten) bzw. Brief. Benutzereigener Text
wird nicht inhaltlich von darin enthaltenen Namen/E-Mails bereinigt. Brief 1–4000
Zeichen. Gesamtprompt höchstens 100000 Zeichen UND 100000 UTF-8-Bytes.
JSON-Ergebnis `{content:string,data:null}`; chapters und titles stattdessen gemäß
Vertrag. Kapitel streng monoton und nur vorhandene Segmentbeginne, Markdown wird
aus validierten Kapiteln aufgebaut. Ohne echte Zeitbasis chapters → 409 no_timestamps.
Titel genau zehn nichtleere Strings, Markdown aus validierten Titeln. Andere Aufgaben
haben Markdown-Inhalt; dessen sachliche Qualität wird nicht automatisch bewiesen.

Bewusste strengere Regeln gegenüber dem ursprünglichen Entwurf:
- Preise immer erforderlich, keine kostenfreien Null-Schätzungen bei fehlender Preispflege.
- Reservierte Eingabetoken = max(ceil(inputChars/2.5), UTF8Bytes+1024), dazu
  vertragliche Ausgabetoken. Die Byteobergrenze mit Framingpuffer ist konservativer
  als der deutsche Durchschnittswert und umfasst Systemprompt/JSON/Metadaten.
- Kosten = ceil((Eingabetoken*inputMicroPerMTok+Ausgabetoken*outputMicroPerMTok)/1e6),
  Mikro-USD. Reservierung beider Zähler atomar gegen Konto und Plattform.
  Providerusage wird auch bei fachlich ungültigem JSON verbucht; fehlt valide usage,
  reservierte Token UND Kosten, usageEstimated=true. Kein Cache-/Batchrabatt eingerechnet.
- Bereits vor fetch dispatch steht sent=true persistent. Jeder Transport-/HTTPfehler,
  Timeout, Abbruch, unlesbarer/zu großer Body ist möglicherweise bezahlt: llm_unclear,
  konservatives Settlement gegen Konto UND Plattform, keine automatische Wiederholung.
  Auch DNS/connect/429/5xx gelten hier nicht als bewiesen ungesendet. Die alte §7.2-
  Retryannahme ist damit absichtlich enger umgesetzt. Crash-Recovery: interrupted.
  Nur ein sicher vor Versand gescheiterter, unverbrauchter Auftrag ist unter derselben
  ID wiederholbar; sonst 409 new_job_required, neuer Job/Key braucht neue Quote.

Offizielle Quellen am 2026-11-20 geprüft:
[Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra.md),
[Preise Standard](https://developers.openai.com/api/docs/pricing.md),
[Chat API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
[JSON](https://developers.openai.com/api/docs/guides/structured-outputs).
Kandidat gpt-6.1-terra: Chat Completions und Textausgabe unterstützt. Standard bis
272K Eingabe: 1 USD Input / 5 USD Output je Million, also inputMicroPerMTok=1000000,
outputMicroPerMTok=5000000. Die günstigere 0.50/2.50-Tabelle gehört Batch an.
Keine automatische Eintragung, kein echter API-Aufruf, keine bestätigte Kontofreischaltung.
Kein regionaler/Fast-/Longcontextbetrieb zugesichert; bei anderem Endpoint/Modell müssen
Preise passend gepflegt werden. L9 und unabhängiger Review bleiben offen.

PA4 Reviewnacharbeit R1/R2/R3/R6/R8: jedes aufgeschobene Settlement wird isoliert
nachgeholt. Ein fachlich/technisch fehlgeschlagenes save wird ohne save als failed
abgeschlossen; bekannte bezahlte LLM-Nutzung bleibt erhalten. Lock → Aufschub mit
identischen Argumenten, kein neuer Handleraufruf. Requeue-Schreibfehler werden separat
vorgemerkt, Reservierung bleibt erhalten. state()-Locks sind retryable, aber nach
sent gilt weiterhin niemals Neuversand. Beide Aufschübe sind RAM-Zustand; beim Crash
greift das bestehende persistente Recovery (LLM sent konservativ). SQLite ist weiterhin
synchron: pro fehlgeschlagenem Schreibversuch bis zum busy_timeout blockiert; keine
Behauptung einer nichtblockierenden DB. Keine unmittelbare Wiederholung bei vorgemerkt
fehlgeschlagenem Requeue, erst nächster Tick. Unbekannte/numerische interne Fehlercodes
werden internal; canceled hat errorCode/errorMessage=null. Bei unklarem bezahltem
Abbruch bleiben usageEstimated/unclear und AdminUsage.unclear erhalten. Die fachlichen
Codes transcript_edited/revision_conflict bleiben bewusst erkennbar.
Capabilities-ASR-Health: maximal 1 Sekunde, parallele Anfragen teilen eine Abfrage,
Erfolg/Fehler fünf Sekunden gecacht. ready ist eine Dienstangabe, keine GPU-Bestätigung.

## PA5 – Archiv (2026-11-20)

Mount-Treiber: `STUDIO_ARCHIVE_DRIVER=mount`, `STUDIO_ARCHIVE_PATH`,
`STUDIO_ARCHIVE_ID`. Wurzel und `.podcast-studio-archiv.json` werden ausschließlich
vom Betreiber eingerichtet, nie von der App. Fehlend → `configuration_required`;
vorhanden, aber Mount/Kennung nicht nachgewiesen → `archive_unavailable`.
Kein SSH-Adminzugang, kein Fake aus der Dienstumgebung. Fake-Wrapper nur in Tests.

| Route | Eigentümer | Mitglied | ohne/abgelaufene Sitzung |
|---|---|---|---|
| GET `/api/admin/archive` | echter Preflight, Counts, freier Speicher | 404 | 401 |
| POST `/api/admin/tracks/:id/archive` | auch Mitgliederspur, 202 Job | 404 | 401 |
| POST `/api/admin/tracks/:id/evict` | auch Mitgliederspur, nur verified + Evict-Einstellung | 404 | 401 |
| POST `/api/tracks/:id/restore` | eigene Spur | eigene Spur | 401 |
| GET/HEAD `/api/tracks/:id/file` | eigene Spur | eigene Spur | 401 |
| GET/HEAD `/api/exports/:id/file` | eigener Export | eigener Export | 401 |

Fremde/unbekannte Ressourcen: identisches 404, auch HEAD/Range. Ownerrolle erweitert
keinen privaten Datei-/Restorezugriff. Ungültige Methode auf einer zugänglichen
Archivroute: 405. POST verlangt unverändert CSRF/Origin. Datei im Archiv: 409
`not_local`; nach Restore wieder GET/HEAD/Range (206, ungültiger Bereich 416).
Restore lokal: 409 `already_local`. Explizite Adminaktionen sind auch bei mode=off
möglich; mode=auto aktiviert ausschließlich automatisches Kopieren. Start off,
`archiveEvictAfterDays=null`, kein automatisches Auslagern.
Aktiver gleicher Archivjob: 200 statt Duplikat; Idempotency-Key ist optional,
Jobs werden unter dem Besitzer der Spur geführt (Owner-Anstoß im input/Audit).

Originale werden nie ersetzt. Erster Snapshot `manifest.json`/`transkript.json`,
weitere Manifeststände `manifest-<jobId>.json`, Transkriptstände
`transkript-<revision>-<sha256>.json`. Alle sind additiv; keine Bereinigung alter
Snapshots. Tempdateien: exakter Zielname + `.teil-<jobId>`; exklusives Schreiben,
fsync, frisch vom Ziel gelesener Hash, Hardlink-Commit ohne Überschreiben.
Restore benutzt ebenfalls exklusiven Hardlink nach lokalem Hashcheck und fsync.
Auslagern entfernt nur das Original und DB-zugeordnete Exportdateien, keine Rohdaten,
Abschnitte oder Ordner. Exporte werden anschließend als neu zu erzeugen markiert.
Audit hält geprüfte Löschabsicht und Abschluss fest. Keine Sicherung ist beteiligt.

Mountprüfung dev≠Eltern-dev lehnt Bindmounts desselben Geräts bewusst ab und beweist
weder Unraid-Herkunft noch Netzwerk-/ACL-Sicherheit. Symlinks in Pfadkomponenten
werden abgelehnt, Dateizugriffe verwenden O_NOFOLLOW. Das ist kein Schutz gegen
einen privilegierten lokalen Angreifer, der zwischen Prüfung und Zugriff Verzeichnisse
oder Mounts austauscht; dafür wären OS-Isolation/dirfd-basierte Operationen nötig.
Ziel und lokale Medienwurzeln dürfen nur vom Betreiber/Appdienst verwaltet werden.
A10 bleibt bis privatem Share, eingeschränktem Zugang und echter Mountausfallprüfung offen.
PA5-Idempotenzschlüssel dürfen nicht für eine andere Spur/Aktion wiederverwendet
werden (409 `idempotency_conflict`); ein passendes abgeschlossenes Ergebnis wird
mit 200 zurückgegeben, bevor `already_local` geprüft wird.


### PA10-Härtung (2026-11-20)
Kennwortwechsel: fünf Versuche je Konto/15 Minuten vor dem Hash; beide Hashoperationen teilen die maximal zwei Auth-Hashplätze (429 bei Belegung). Erfolg setzt das Kontolimit zurück und entwertet weiterhin alle Sitzungen/ausstehenden Kontotokens.
Nur autorisierter, eigener Transkript-PATCH akzeptiert bis 4 MiB UTF-8-JSON mit vollständiger Segmentliste; sonst 16 KiB. Übergröße: 413 too_large, Revision unverändert. Typprüfung und maximal 2000 Zeichen je Segment bleiben bestehen.
ASR-Idempotenz verlangt dieselbe Art und Spur; sonst 409 idempotency_conflict ohne weitere Reservierung. Medien-/Exportverarbeitungsfehler enthalten öffentlich ausschließlich media_invalid. Nullbytes in Pfaden und ungültiger Admin-Kontostatus liefern 400.

### RA4d Archiv-Mount
`STUDIO_ARCHIVE_EXPECTED_FILESYSTEM` ist optional (Realdienst: `cifs`). Bei jedem Zugriff prüft preflight den letzten exakten Mountpunkt in `/proc/self/mountinfo`; unlesbare/ungültige Angaben scheitern geschlossen. CIFS verlangt immer das VFS-Mountflag `nosymfollow`, unabhängig von dieser Option. Nicht-CIFS behält Geräte-/Markerprüfungen. Server muss zusätzlich sharelokal `follow symlinks = No` und `wide links = No` erzwingen; das Clientflag allein erkennt serverseitiges Folgen nicht. CIFS privat hinter root-0700-Stage mounten, öffentlich ausschließlich atomarer Bind mit Flag. Kein Live-Zuschalten durch diese Dokumentation.

## PEL F0 – Fundament (2026-11-20)

Vertrag: `../../Planung/Planer-Editor-Live-Vertraege.md` §§1–9. `user_version=1`
bleibt erhalten; zusätzlich ist `schema_ext.pel=1` erforderlich. Nur explizites
`cli migrate` erweitert das Schema mit Online-Snapshots; `cli status` meldet
`ext.pel`. Keine automatische Migration beim Serverstart.

Clienttypen und sämtliche Methoden aus §7 sind additiv vorhanden. EDL-Typen
werden aus dem reinen `server/edl.d.mts` importiert/reexportiert; dessen Funktionen
sind bis B-E ausdrücklich `configuration_required`, keine Validierung oder Zeitrechnung.
`plannerIcsUrl(id?,from?,to?)` nimmt für den Zeitraumdownload zusätzlich from/to an.
`renderCreate(id,format,revision)`, `liveCreate(publicTitle)`, `liveStart(id,mimeType)`
packen ihre Argumente in die vertraglichen JSON-Körper. `trackPeaks` nutzt denselben
Requestweg mit binärer Antwort (202 → null). Bestehende Requestaufrufe unverändert.

Alle neuen Serverpfade sind Gerüste: nach Authentifizierung 503
`configuration_required`, Service planner/editor/live. Ausschließlich `/api/watch/…`
wird nach dem CSRF-Guard vor jeder Auswertung von `ps_sitzung` an Live übergeben;
der Stub liefert kontounabhängig 503 ohne Daten. Keine anderen Auth-Ausnahmen.
PUT `/api/edits/:id/edl` liest nach Auth/CSRF höchstens 256 KiB; alle anderen
JSON-Grenzen bleiben bestehen. Im F0-Gerüst bedeutet auch korrektes JSON nur 503.

Lebenszyklus: `ctx.live=createLive(ctx)` vor HTTP; `recoverRenders(ctx)` und
`ctx.live.recover()` beim Start, `await ctx.live.close()` zuerst beim Schließen.
Die Haken sind bis B-E/B-L inaktiv. Neue Jobs unterstützen `has` und `cancel`;
`onQueue` läuft einmal synchron vor Aufnahme eines akzeptierten Auftrags,
Duplikate/geschlossene Queue führen es nicht aus. Schließen verwirft Wartende und
wartet auf das Ende des laufenden Kindes. Drosselung nutzt nice 10 und ffmpeg
threads 3 nur bei aktivem Live-Modul. nav bleibt `spaeter`.
