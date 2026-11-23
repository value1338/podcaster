# Podcast-Studio (podcaster)

Selbst gehostetes Studio für Podcast-Aufnahmen im Browser: Projekte, Mehrspur-Aufnahme, Live-Zuschauen, Schnitt/Render, Export, Transkription und KI-Hilfen. Ein Node-Server (ohne Framework, SQLite über `node:sqlite`) liefert API und React-Oberfläche aus einem Prozess aus.

## Voraussetzungen

- Node.js **>= 24** (siehe `package.json` → `engines`)
- `ffmpeg` und `ffprobe` im `PATH`
- Reverse-Proxy mit HTTPS (z. B. Caddy, nginx, Traefik)
- Alternativ: Docker mit Compose

## Installation (ohne Docker)

```bash
npm ci
npm run build                      # UI nach dist/; bei Unterpfad: VITE_BASE=/podcast/ npm run build
cp .env.example .env               # Werte anpassen
set -a; . ./.env; set +a
NODE_ENV=production node server/index.mjs
```

Für den Dauerbetrieb liegt eine systemd-Vorlage in `deploy/podcaster.service.example`.

## Installation mit Docker

```bash
cp .env.example .env               # STUDIO_ORIGINS, STUDIO_PUBLIC_URL, STUDIO_ADMIN_EMAIL setzen
docker compose up -d --build
```

Der Container läuft als Nutzer `node`, Daten liegen im Volume `podcaster-daten` (`/data`). Der Port wird nur auf `127.0.0.1:8850` veröffentlicht – davor den Reverse-Proxy setzen.

## Erst-Deploy und Admin-Zugang

1. `.env` ausfüllen: `STUDIO_ORIGINS` (exakte Origin, z. B. `https://studio.example.com`), `STUDIO_PUBLIC_URL` (inkl. Unterpfad) und `STUDIO_ADMIN_EMAIL`.
2. Server starten. Bei leerem Datenverzeichnis legt er die Datenbank selbst an.
3. Gibt es noch keinen Admin, erzeugt der Server einen **Einmal-Einrichtungslink** (24 h gültig) in `<STUDIO_DATA_DIR>/admin-einrichtung.txt` (Rechte 0600) und schreibt ihn einmal ins Log. In Docker: `docker compose exec podcaster cat /data/admin-einrichtung.txt`.
4. Link öffnen, Kennwort setzen – danach ist der Link verbraucht und der Admin angemeldet. Es gibt kein Standardkennwort.
5. Abgelaufen? Server neu starten, es entsteht ein neuer Link. Ohne `STUDIO_ADMIN_EMAIL` alternativ per CLI: `node server/cli.mjs owner:create --email … --name … --output <neue Datei>`.

Weitere Nutzer lädt der Admin unter **Verwaltung** per Einladungslink ein.

Hinweis: Eine bestehende Datenbank mit Altdaten wird nie automatisch migriert. Dafür vorher `node server/cli.mjs migrate` ausführen (legt SQLite-Snapshots neben der Datenbank an). Die automatische Initialisierung gilt nur für ein Datenverzeichnis ohne Datenbank.

## KI-Dienste

KI-Dienste werden **nicht** über Umgebungsvariablen konfiguriert, sondern nach dem Login unter **Verwaltung → Einstellungen** eingetragen:

- **LLM:** OpenAI-kompatible Schnittstelle (`POST <Basis-URL>/chat/completions`, Bearer-Schlüssel, Modellname).
- **Spracherkennung:** HTTP-Server mit Protokoll `studio-asr-v1`, Bearer-Token:
  - `GET <URL>/v1/health` → `{ok:true, model, device, timestamps, maxAudioSeconds}`
  - `POST <URL>/v1/transcriptions[?language=de]`, Body WAV mono 16 kHz s16le (`Content-Type: audio/wav`) → `{text, language, model, device, segments:[{start, end, text, words?}]}`, Zeiten in Sekunden.

  Details: `docs/API.md` (Abschnitt ASR) und `server/asr-adapter.mjs`.

Ohne Konfiguration bleiben diese Funktionen deaktiviert (`configuration_required`).

## Betrieb

- **Reverse-Proxy/HTTPS:** Pflicht im Produktivbetrieb (Sitzungscookies sind `Secure`). Bei Unterpfad `STUDIO_BASE_PATH=/podcast` und UI-Build mit `VITE_BASE=/podcast/`. `STUDIO_COOKIE_INSECURE=1` nur für lokale Tests ohne HTTPS, in `NODE_ENV=production` verboten.
- **Datenverzeichnis** (`STUDIO_DATA_DIR`, Docker `/data`): SQLite-Datenbank, Aufnahmen, Exporte, Einrichtungsdatei. Rechte 0700, nur für den Dienstnutzer.
- **Backups:** Das gesamte Datenverzeichnis sichern. Für eine konsistente Datenbank entweder den Dienst kurz stoppen oder eine SQLite-Online-Sicherung verwenden (`sqlite3 studio.sqlite ".backup ziel.sqlite"`); nicht nur `studio.sqlite` ohne `-wal` kopieren.
- **Archivziel (optional):** Ältere Medien können auf einen Mount ausgelagert werden – `STUDIO_ARCHIVE_DRIVER=mount`, `STUDIO_ARCHIVE_PATH`, `STUDIO_ARCHIVE_ID`, optional `STUDIO_ARCHIVE_EXPECTED_FILESYSTEM` (siehe `docs/API.md`).
- **Bind-Adresse:** Standard `127.0.0.1`. `STUDIO_HOST=0.0.0.0` nur im Container bzw. hinter einem Proxy.

## Entwicklung

```bash
npm run dev            # Vite-Dev-Server
npm test               # vitest
npx tsc --noEmit -p .  # Typprüfung
```
