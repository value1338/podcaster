// Statisch typgeprüfte Anbindung der fertigen Aufnahme-Engine – an das angemeldete Konto gebunden (PA7, V §11).
import { api as standardApi, type ApiClient, type Track } from "../../lib/api";
import { listPending, resumePending, discardPending } from "../../lib/recorder";

/** Vertragsfelder aus Umsetzung §7 (Engine darf mehr liefern). */
export interface PendingRecording { trackId: string; projectId: string; title: string; startedAtMs: number; localChunks: number }

export interface Wiederherstellung {
  listPending(): Promise<PendingRecording[]>;
  resumePending(trackId: string, api: ApiClient, onProgress: (done: number, total: number) => void): Promise<Track>;
  discardPending(trackId: string): Promise<void>;
}

export const wiederherstellungVorhanden = true;

/** null = niemand angemeldet → keine lokalen Aufnahmen zeigen (auch keine fremden). */
export async function ladeWiederherstellung(client: ApiClient = standardApi): Promise<Wiederherstellung | null> {
  const userId = (await client.session()).user?.id;
  if (!userId) return null;
  return {
    listPending: () => listPending(userId, client),
    resumePending: (trackId, a, onProgress) => resumePending(trackId, userId, a, onProgress),
    discardPending: (trackId) => discardPending(trackId, userId, client),
  };
}
