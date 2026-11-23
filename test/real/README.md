# RA5 – getrennte HTTP-Abnahme

Root: das App-Verzeichnis. Node 24 mit node:sqlite,
ffmpeg und ffprobe im PATH. Keine Installation, keine Env-/Schlüsseldateien lesen.
`--server` muss auf eine vollständige Serverdistribution mit benachbarten
`db.mjs`, `migrate.mjs`, `accounts.mjs` zeigen. Existenz und Medienwerkzeuge
werden vor Import/Bootstrap geprüft. Neue DB per mkdtemp neben App; Migration
und synthetischer Owner ausschließlich dort, anschließend Token setzen und
normales Login. Kein Zugriff auf Live-Konten oder Sitzungen. Loopback-Port 0.

```sh
cd podcaster
node test/real/abnahme.mjs --server server/index.mjs --audio /pfad/probe.wav \
  --out test/real/mein-neuer-lauf --stufen asr,llm,archiv \
  --testbudget 200000 --kostendeckel 1000000
```

Alle Beträge Mikro-USD. Testbudget maximal 200000 (0,20 USD), Plattformdeckel
maximal 1000000 (1 USD). Kleinere positive Ganzzahlen erlaubt. `--out` muss
neu sein; bestehende Ordner werden nicht überschrieben. Stufen: `asr`, `llm`,
`archiv`, `archiv-ausfall`; Archiv und Ausfall gegenseitig ausgeschlossen.
LLM benötigt ein Transkript, führt daher auch ASR durch. Jede Ausführung lädt
frisches Audio hoch; Ausfall ist eine separate Probe vor dem Archivieren.

Dienstkonfiguration ausschließlich geerbte Prozessumgebung:
`STUDIO_ASR_DRIVER/URL/TOKEN`, `STUDIO_LLM_DRIVER`, `STUDIO_LLM_BASE_URL`,
`STUDIO_LLM_REASONING_EFFORT`, `OPENAI_API_KEY`,
`STUDIO_ARCHIVE_DRIVER/PATH/ID` sowie Adapter-Timeouts.
Für LLM zusätzlich **explizit** `RA5_LLM_MODEL`,
`RA5_INPUT_MICRO_PER_MTOK`, `RA5_OUTPUT_MICRO_PER_MTOK` (positive sichere
Ganzzahlen, Mikro-USD pro Million Tokens). Preise müssen vom Betreiber anhand
aktueller Primärquellen bestätigt werden; keine eingebauten Modell-/Preisannahmen.
Modellzugang wird per HTTPS-GET geprüft. Kein Probe-Completion, kein Fallback.
Fehlende Konfiguration blockiert mit Exit 1; keine Secrets in CLI-Argumenten.

Vor jedem Completion-Intent kostenloses Estimate; konservative Reservierung
anhand reserveTokens/maxOutputTokens und expliziter Preise. Bereits verbuchte
Plattformkosten plus neue Reservierung dürfen Testbudget nicht überschreiten.
Zusätzlich eigener Plattformdeckel und 402-Probe mit Deckel 1 vor den sechs
Aufgaben. Genau ein neuer POST pro Intent, keine Retryroute, kein Blind-Retry.
Ein fehlgeschlagener Job stoppt sofort (damit strenger als zwei unclear).
Konservative Schätzbuchungen zählen mit. Ein Plattformdeckel ist **kein** harter
Anbieterdeckel; kein Providerlimit wird eingerichtet oder behauptet.

Archiv: Ziel muss bereits eingerichtet sein. Werkzeug schreibt keine Marker,
mountet nichts und verändert keine Freigaben. Vor Archivauftrag wird der frisch
synthetisch erzeugte UUID-Spurpfad auf Nichtvorhandensein geprüft und als
Cleanup-Intent aufgezeichnet. Nach Serverstopp werden nur dessen erfasste,
reguläre Original-/Metadatentestdateien einzeln gehasht und entfernt, danach
leere UUID-Verzeichnisse mit rmdir. Kein rekursives Archivlöschen, keine fremden
Originale, Versionen, Backups oder Marker. Bei unbekannten Objekten oder
Cleanupfehler verbleibt das Ledger und der Lauf endet fehlerhaft. Ein extern
noch nicht wieder erreichbares Archiv kann nicht zuverlässig bereinigt werden;
das muss anhand des Ledgers vor dem nächsten Lauf geschehen. SIGINT/SIGTERM
führen ins finally; SIGKILL/Stromausfall können technisch kein Cleanup garantieren.

## Reproduzierbarer Trockenlauf

```sh
ffmpeg -v error -f lavfi -i sine=frequency=440:duration=3 /tmp/ra5-probe.wav
node test/real/dryrun.mjs --server server/index.mjs --audio /tmp/ra5-probe.wav \
  --out test/real/lauf-neu --stufen asr,llm,archiv
node test/real/dryrun.mjs --server server/index.mjs --audio /tmp/ra5-probe.wav \
  --out test/real/ausfall-neu --stufen archiv-ausfall
node --test test/real/guard.test.mjs
rm /tmp/ra5-probe.wav
```

Dryrun setzt ausschließlich synthetische Prozesswerte, startet einen lokalen
OpenAI-kompatiblen HTTP-Provider auf dynamischem Port und injiziert beim
Serverbootstrap eine private Archiv-Fixture im eigenen Tempdatenordner.
Diese Fixture ist kein Mount-/SMB-Test, meldet keinen echten freien Speicher
und prüft weder fsync noch Netzwerkunterbrechungen. Der Testprovider liefert
zehn Titel und gültige Kapitelstarts; Anzahl der Completionaufrufe wird geprüft.
Modellprüfung wird mit `--ohne-modellpruefung` übersprungen und als Test
markiert; dieser Schalter erfordert NODE_ENV=test und RA5_FIXTURE=1.
Fake-ASR meldet cuda/segment, aber benutzt keine GPU, liefert keine Wörter und
keinen inhaltlich verlässlichen Text. Drei Sekunden Sinuston sind keine Hörprobe.

Evidence: Fähigkeiten, öffentliche Workjobs mit Zeiten/Fortschritt, Usage vor,
nach Einreichung und nach Stufen, ASR-Zeit/Echtzeitfaktor, Token/Kosten und
nachgerechnete Kosten, Hash des HTTP-Originals gegen Spurhash, Archivstatus,
Subtitle-Hashes und bis zu fünf zufällige Segmente samt WAV-Schnipseln.
Bei weniger Segmenten gibt es weniger Schnipsel. Textauszüge maximal 200
Zeichen je Stichprobe, keine vollständigen Transkripte. SRT/VTT werden über
HTTP abgerufen und gehasht, nicht als Volltext abgelegt. Reservierungs-Snapshot
kann bei sehr schnellem Abschluss bereits Settlement zeigen.
Keine GPU-/VRAM-Messung, keine unabhängige SMB-/Unraid-Prüfsumme, keine
Dashboardabrechnung oder Nutzerhörprüfung; diese bleiben RA6/RA7.

Alle Evidence-Dateien einschließlich WAV werden nach bekannten Prozess-Secrets
geprüft, ohne Treffer auszugeben. Bei Treffer werden eigene Belege entfernt und
Exit 1 gesetzt. Das ist kein allgemeiner Geheimnisklassifikator; fremde Logs und
Live-Datenbanken werden nicht gescannt. Cleanup erfolgt auch bei Fehlern.
Exit 0 = gewählte Stufen erfolgreich; Exit 1 = Vorbedingung, Stufe, Budget,
Unterbrechung, Secretprüfung oder Cleanup gescheitert. Fehlerdetails nur als
feste Codes in result.json; keine fremden Fehlertexte oder Providerantworten.
