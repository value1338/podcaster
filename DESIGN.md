# Podcast-Studio – Gestaltung

Besitzer: AP0. Verbindliche Werte in `src/styles/tokens.css`; Änderungen nur über AP0 (bzw. Hauptagent). Referenz: Riverside-Screenshots `../Recherche/Riverside/2026-11-20/` (01 Startseite, 02 Warteraum, 09 Projekte, 12 Projekt-Detail, 13 Download-Menü). Struktur und dunkle Anmutung übernommen; Name, Logo, Figuren, Illustrationen und Texte von Riverside **nicht**.

## Aufbau

- **Zwei Ebenen**: Außenfläche `--c-bg` (Seitenleiste), Inhaltstafel `--c-panel` mit `--r-lg`-Radius und feiner Linie `--c-line` (`Shell`).
- **Seitenleiste** `--sidebar-w` 224 px: Marke oben, Gruppen *(ohne Titel)* / Erstellen / Generieren / Veröffentlichen, Einträge `--nav-item-h` mit Linien-Icon (lucide, 20 px, Strich 1,75), aktiver Eintrag als hellere Pille `--c-surface-2`, Gruppentitel `--fs-sm` `--c-text-dim`. Nicht implementierte Einträge tragen rechts ein Badge **TBD** (Bild & Video, AI Twins, Voice Clones) oder **Später**. Unten Nutzerkürzel.
- **Kopfzeile** `--topbar-h`: mittiges Suchfeld (navigiert zu `/projekte?q=`), sonst nichts – nur was funktioniert.
- **Seiteninhalt**: Klasse `.page` (Innenabstand, max. `--content-max`) + `.page__head` (Titel links, Aktionen rechts, z. B. „+ Neu“ als `primary`).
- **Studio** (`/studio/*`) läuft **ohne** Shell: Vorschau links groß, Zustands-/Geräteblock rechts (Referenz 02), eigener Rahmen in AP4.
- **Projektdetail** (Referenz 12): Breadcrumb, Reiterzeile (Aufnahmen · Erstellt für Dich [Später] · Bearbeitungen [Später] · Exporte), großer Player, darunter „Spuren“ als Zeilen (Icon · Name · Status · Dauer · Auflösung · Herunterladen · ⋯).

## Responsiv

- < 900 px: Seitenleiste wird Schublade (Menü-Knopf links in der Kopfzeile, Esc/Hintergrund schließt), Inhaltstafel randlos.
- Studio muss bei 390 px (iPhone) bedienbar sein.

## Tokens (Kurzreferenz)

| Gruppe | Tokens |
|---|---|
| Flächen | `--c-bg` #0e0e0e · `--c-panel` #161616 · `--c-surface` #1e1e1e · `--c-surface-2` #262626 · `--c-surface-3` · `--c-line` · `--c-line-strong` |
| Text | `--c-text` · `--c-text-muted` · `--c-text-dim` · `--c-text-on-accent` |
| Signal | `--c-accent` #7c4dff (Primäraktion) · `--c-rec` #ef4444 (nur Aufnahme/Gefahr) · `--c-ok` · `--c-warn` · `--c-error`, je mit `-soft` für Hintergründe · `--c-focus` |
| Schrift | `--font-sans` Inter Variable (lokal gebündelt) · `--font-mono` · `--fs-xs…2xl` · `--fw-*` |
| Raster | `--s-1…12` (4-px-Raster) · `--r-sm/md/lg/pill` · `--control-h` 36 · `--control-h-sm` 28 |
| Bewegung | `--ease`, `--dur-fast` 120 ms, `--dur` 200 ms (bei `prefers-reduced-motion` 0) |
| Ebenen | `--z-drawer` · `--z-menu` · `--shadow-pop` |

## Komponenten (`src/components/index.ts`)

`Shell` · `Button`/`buttonClass` · `Badge` · `Spinner`/`PageSpinner` · `EmptyState` · `ErrorState` · `Menu` – Signaturen in `../Pruefungen/AP0.md`.

## Regeln

- Primärfarbe nur für die eine Hauptaktion je Ansicht. Rot nur für Aufnahme und Gefahr.
- Statuswerte (Spur/Export) immer als Text + Badge/Icon, nie nur über Farbe. Pegel zusätzlich als Zahl/Balkenlänge.
- Messwerte (Dauer, Größe, Auflösung) monospaced: `.u-mono`. Formatierung über `src/lib/format.ts`.
- Barrierefreiheit: alle Aktionen per Tastatur, sichtbarer Fokus (`--c-focus`), Statuswechsel per `aria-live`, Icon-Buttons mit `aria-label`.
- Keine Schein-Bedienelemente: Was nicht funktioniert, ist deaktiviert mit Badge „Später“ oder fehlt.
