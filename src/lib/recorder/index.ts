// Öffentliche Schnittstelle der Aufnahme-Engine (Umsetzung.md §7). Besitzer: AP3.
export type { KameraStand, PendingRecording, Studio, StudioPhase, StudioSnapshot } from "./types";
export { createStudio, initialSnapshot, TIMESLICE_MS } from "./studio";
export { listPending, resumePending, discardPending, ungesicherteAufnahmen } from "./pending";
export { RAM_PUFFER_MAX_BYTES, SAFARI_FREIGEGEBEN } from "./format";
