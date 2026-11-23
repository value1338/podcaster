import type {Edl} from "../../server/edl.mjs";
export type {Edl,EdlClip} from "../../server/edl.mjs";
// Typen und Client für den HTTP-Vertrag v1 (maßgeblich: App/docs/API.md). Besitzer: AP0.
// Alle URLs relativ zur App-Basis (VITE_BASE), damit /podcast/ funktioniert.

export type TrackStatus = "uploading" | "processing" | "ready" | "failed";
export type ExportStatus = "queued" | "processing" | "ready" | "failed";
export type ExportFormat = "mp3" | "wav" | "mp4"; // mp4 nur für Videospuren
export type TrackKind = "audio" | "video";

export interface Project {
  id: string;
  title: string;
  createdAt: string;
  recordingCount: number;
  lastRecordingAt: string | null;
}

export interface Export {
  id: string;
  trackId: string;
  format: ExportFormat;
  status: ExportStatus;
  error: string | null;
  bytes: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Track {
  id: string;
  recordingId: string;
  participantName: string;
  kind: TrackKind;
  source: TrackSource;
  local?: boolean;
  archive?: TrackArchive;
  transcription?: TrackTranscription;
  mimeType: string;
  status: TrackStatus;
  error: string | null;
  receivedChunks: number;
  bytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  startedAtMs: number | null;
  lastChunkAt: string | null;
  hasRaw: boolean;
  exports: Export[];
}

export interface Recording {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  tracks: Track[];
}

export interface ProjectDetail extends Project {
  recordings: Recording[];
}

export interface Health {
  ok: boolean;
  version: string;
  freeBytes: number;
  ffmpeg: boolean;
}

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
  usageEstimated?: boolean; unclear?: boolean;
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
  // KI-Dienste (nur owner). URLs http(s) ohne Benutzerinfo/Query/Fragment; "" = nicht eingerichtet.
  llmBaseUrl: string; llmReasoningEffort: "none" | "low" | "medium" | "high" | null; llmTimeoutMs: number;  // 1000–120000
  asrUrl: string; asrTimeoutMs: number;               // 1000–3600000
  llmApiKeySet: boolean; asrTokenSet: boolean;        // Secrets sind write-only: nur „gesetzt ja/nein“
}
/** Secrets: string = setzen, "" oder weglassen = unverändert, null = entfernen. */
export type SettingsPatch = Partial<Omit<Settings, "llmApiKeySet" | "asrTokenSet">> & { llmApiKey?: string | null; asrToken?: string | null };
export interface AdminUsage { period: string;
  platform: { llmTokens: MeterState; llmCostMicro: MeterState; asrSeconds: MeterState };
  users: { userId: string; email: string; usage: Usage; llmCostMicro: number }[];
  unclear: { jobId: string; userId: string; at: string; reservedTokens: number }[] }
export interface ArchiveStatus { state: ServiceState; driver: "mount" | "ssh" | null; archiveId: string | null;
  freeBytes: number | null; checkedAt: string; error: string | null;
  counts: Record<ArchiveState, number>; evicted: number }

export interface FinalizeInput {
  chunkCount: number;
  durationMs: number;
  allowPartial?: boolean;
}

/** Positivliste der Basistypen (Umsetzung.md §6.2), ohne codecs-Parameter. */
export const ALLOWED_BASE_MIME = ["audio/webm", "video/webm", "audio/mp4", "video/mp4"] as const;
/** Mindestens freier Speicher auf dem Server, sonst blockiert das Studio den Start. */
export const MIN_FREE_BYTES = 10 * 1024 ** 3;

/**
 * Einheitlicher Fehler aller API-Aufrufe.
 * status 0 = Netzwerkfehler / Server nicht erreichbar (code "network"), "aborted" bei AbortSignal,
 * "timeout" bei Ablauf einer Frist (z. B. AbortSignal.timeout). Alle drei gelten als wiederholbar.
 * details = restliche Felder des Fehlerobjekts, z. B. { missing: number[] } bei chunks_missing.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isNetwork() { return this.status === 0; }
}

export const API_BASE = `${import.meta.env.BASE_URL}api`;

type Query = Record<string, string | number | boolean | undefined>;

export class ApiClient {
  private loggedOut = false;
  constructor(readonly base: string = API_BASE) {}

  url(path: string, query?: Query): string {
    const q = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== false);
    const qs = q.length ? "?" + new URLSearchParams(q.map(([k, v]) => [k, v === true ? "1" : String(v)])) : "";
    return this.base + path + qs;
  }

  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, headers: Record<string, string> = {}, binary = false): Promise<T> {
    const init: RequestInit = { method, signal, credentials: "same-origin", headers: { ...headers, accept: "application/json", "X-Studio": "1" } };
    if (body instanceof Blob) {
      init.body = body;
      (init.headers as Record<string, string>)["content-type"] = "application/octet-stream";
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    let res: Response;
    let text: string;
    try {
      res = await fetch(this.url(path), init);
      if(binary && res.ok)return (res.status===202?null:await res.arrayBuffer()) as T;
      text = await res.text(); // Frist/Abbruch gilt auch für den Antwortkörper
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === "TimeoutError" || (name === "AbortError" && (signal?.reason as Error)?.name === "TimeoutError")) {
        throw new ApiError(0, "timeout", "Der Server hat nicht rechtzeitig geantwortet.");
      }
      if (name === "AbortError") throw new ApiError(0, "aborted", "Anfrage abgebrochen.");
      throw new ApiError(0, "network", "Server nicht erreichbar. Bitte Verbindung prüfen.");
    }
    let data: unknown = undefined;
    if (text) {
      try { data = JSON.parse(text); } catch { /* kein JSON */ }
    }
    if (!res.ok) {
      const err = (data as { error?: Record<string, unknown> } | undefined)?.error;
      if (err && typeof err.code === "string") {
        const { code, message, ...details } = err;
        if (res.status === 401 && code === 'unauthenticated' && !this.loggedOut) {
          this.loggedOut = true;
          if (typeof window !== 'undefined') window.dispatchEvent(new Event('studio:abgemeldet'));
        }
        throw new ApiError(res.status, code, String(message ?? code), details);
      }
      throw new ApiError(res.status, `http_${res.status}`, `Unerwartete Serverantwort (${res.status}).`);
    }
    if (res.ok) this.loggedOut = false;
    return data as T;
  }



  plannerList(from:string,to:string){return this.request<PlannerEvent[]>('GET',this.queryPath('/planner/events',{from,to}));}
  plannerCreate(input:PlannerInput){return this.request<PlannerEvent>('POST','/planner/events',input);}
  plannerUpdate(id:string,input:Partial<PlannerInput>&{revision:number}){return this.request<PlannerEvent>('PATCH',`/planner/events/${enc(id)}`,input);}
  plannerDelete(id:string){return this.request<void>('DELETE',`/planner/events/${enc(id)}`);}
  plannerIcsUrl(id?:string,from?:string,to?:string){return this.url(id?`/planner/events/${enc(id)}/ics`:'/planner/events.ics',{from,to});}
  editsList(projectId:string){return this.request<Edit[]>('GET',`/projects/${enc(projectId)}/edits`);}
  editCreate(projectId:string,input:{title:string;kind:'audio'|'video'}){return this.request<EditDetail>('POST',`/projects/${enc(projectId)}/edits`,input);}
  editGet(id:string){return this.request<EditDetail>('GET',`/edits/${enc(id)}`);}
  editRename(id:string,title:string){return this.request<Edit>('PATCH',`/edits/${enc(id)}`,{title});}
  editSave(id:string,baseRevision:number,edl:Edl){return this.request<Edit>('PUT',`/edits/${enc(id)}/edl`,{baseRevision,edl});}
  editRevisions(id:string){return this.request<EditRevision[]>('GET',`/edits/${enc(id)}/revisions`);}
  editRevision(id:string,n:number){return this.request<{revision:number;edl:Edl}>('GET',`/edits/${enc(id)}/revisions/${n}`);}
  editDelete(id:string){return this.request<void>('DELETE',`/edits/${enc(id)}`);}
  trackPeaks(id:string){return this.request<ArrayBuffer|null>('GET',`/tracks/${enc(id)}/peaks`,undefined,undefined,{},true);}
  renderCreate(id:string,format:ExportFormat,revision:number){return this.request<Render>('POST',`/edits/${enc(id)}/renders`,{format,revision});}
  rendersList(id:string){return this.request<Render[]>('GET',`/edits/${enc(id)}/renders`);}
  renderGet(id:string){return this.request<Render>('GET',`/renders/${enc(id)}`);}
  renderCancel(id:string){return this.request<Render>('POST',`/renders/${enc(id)}/cancel`);}
  renderDelete(id:string){return this.request<void>('DELETE',`/renders/${enc(id)}`);}
  renderFileUrl(id:string,download=false){return this.url(`/renders/${enc(id)}/file`,{download});}
  liveList(){return this.request<Live[]>('GET','/live');}
  liveCreate(publicTitle:string){return this.request<{live:Live;link:LiveLink}>('POST','/live',{publicTitle});}
  liveGet(id:string){return this.request<Live>('GET',`/live/${enc(id)}`);}
  liveStart(id:string,mimeType:string){return this.request<{epoch:number}>('POST',`/live/${enc(id)}/start`,{mimeType});}
  liveIngest(id:string,epoch:number,seq:number,blob:Blob){return this.request<void>('PUT',`/live/${enc(id)}/ingest/${epoch}/${seq}`,blob);}
  liveStop(id:string){return this.request<Live>('POST',`/live/${enc(id)}/stop`);}
  liveNewLink(id:string){return this.request<LiveLink>('POST',`/live/${enc(id)}/link`);}
  liveRevokeLink(id:string){return this.request<void>('DELETE',`/live/${enc(id)}/link`);}
  watchEnter(token:string){return this.request<void>('POST','/watch/enter',{token});}
  watchState(){return this.request<WatchState>('GET','/watch/state');}
  watchLeave(){return this.request<void>('POST','/watch/leave');}
  watchHlsUrl(epoch:number,datei:string){return this.url(`/watch/hls/${epoch}/${enc(datei)}`);}

  session(signal?: AbortSignal) { return this.request<SessionInfo>('GET','/session',undefined,signal); }
  login(email: string, password: string) { return this.request<{user:Me}>('POST','/auth/login',{email,password}); }
  logout() { return this.request<void>('POST','/auth/logout'); }
  tokenInfo(token: string) { return this.request<TokenInfo>('GET',`/auth/token/${enc(token)}`); }
  redeemToken(token: string, input: {password:string; displayName?:string; email?:string}) { return this.request<{user:Me}>('POST',`/auth/token/${enc(token)}`,input); }
  changePassword(currentPassword:string,newPassword:string) { return this.request<void>('POST','/account/password',{currentPassword,newPassword}); }
  usage() { return this.request<Usage>('GET','/account/usage'); }
  capabilities() { return this.request<Capabilities>('GET','/capabilities'); }
  getJob(id:string,signal?:AbortSignal) { return this.request<Job>('GET',`/jobs/${enc(id)}`,undefined,signal); }
  listJobs(query: {active?:boolean; projectId?:string} = {}) { return this.request<Job[]>('GET',this.queryPath('/jobs',query)); }
  retryJob(id:string) { return this.request<Job>('POST',`/jobs/${enc(id)}/retry`); }
  cancelJob(id:string) { return this.request<Job>('POST',`/jobs/${enc(id)}/cancel`); }
  startTranscription(id:string,input:{language?:string|null;replaceEdited?:boolean},idemKey:string) { return this.request<Job>('POST',`/tracks/${enc(id)}/transcription`,input,undefined,{'Idempotency-Key':idemKey}); }
  getTranscript(id:string) { return this.request<Transcript>('GET',`/tracks/${enc(id)}/transcript`); }
  saveTranscript(id:string,input:{revision:number;segments:{id:string;text:string}[]}) { return this.request<Transcript>('PATCH',`/tracks/${enc(id)}/transcript`,input); }
  resetTranscript(id:string,revision:number) { return this.request<Transcript>('POST',`/tracks/${enc(id)}/transcript/reset`,{revision}); }
  transcriptFileUrl(id:string,format:TranscriptFormat) { return this.url(`/tracks/${enc(id)}/transcript/file`,{format}); }
  estimateGeneration(projectId:string,input:Omit<GenerationInput,'consent'>) { return this.request<LlmEstimate>('POST','/llm/estimate',{...input,projectId}); }
  createGeneration(id:string,input:GenerationInput,idemKey:string) { return this.request<Job>('POST',`/projects/${enc(id)}/generations`,input,undefined,{'Idempotency-Key':idemKey}); }
  listGenerations(id:string) { return this.request<Generation[]>('GET',`/projects/${enc(id)}/generations`); }
  getGeneration(id:string) { return this.request<Generation>('GET',`/generations/${enc(id)}`); }
  generationFileUrl(id:string) { return this.url(`/generations/${enc(id)}/file`); }
  restoreTrack(id:string) { return this.request<Job>('POST',`/tracks/${enc(id)}/restore`); }
  private queryPath(path:string,query:Query) { return this.url(path,query).slice(this.base.length); }
  readonly admin = {
    users: () => this.request<AdminUser[]>('GET','/admin/users'),
    updateUser: (id:string,patch:{planId?:string;status?:'active'|'disabled';displayName?:string}) => this.request<AdminUser>('PATCH',`/admin/users/${enc(id)}`,patch),
    resetLink: (id:string) => this.request<InviteLink>('POST',`/admin/users/${enc(id)}/reset-link`),
    invites: () => this.request<Invite[]>('GET','/admin/invites'),
    createInvite: (input:{email?:string;planId:string;expiresInHours?:number}) => this.request<InviteLink>('POST','/admin/invites',input),
    revokeInvite: (id:string) => this.request<void>('DELETE',`/admin/invites/${enc(id)}`),
    plans: () => this.request<Plan[]>('GET','/admin/plans'),
    savePlan: ({id,...plan}:Plan) => this.request<Plan>('PUT',`/admin/plans/${enc(id)}`,plan),
    settings: () => this.request<Settings>('GET','/admin/settings'),
    saveSettings: (patch:SettingsPatch) => this.request<Settings>('PUT','/admin/settings',patch),
    usage: (period?:string) => this.request<AdminUsage>('GET',this.queryPath('/admin/usage',{period})),
    archive: () => this.request<ArchiveStatus>('GET','/admin/archive'),
    archiveTrack: (id:string) => this.request<Job>('POST',`/admin/tracks/${enc(id)}/archive`),
    evictTrack: (id:string) => this.request<Job>('POST',`/admin/tracks/${enc(id)}/evict`),
  };

  // Optionales `signal` (rückwärtskompatibel): Abbruch bzw. Frist, z. B. AbortSignal.timeout(ms).
  health(signal?: AbortSignal) { return this.request<Health>("GET", "/health", undefined, signal); }

  listProjects() { return this.request<Project[]>("GET", "/projects"); }
  createProject(title: string) { return this.request<Project>("POST", "/projects", { title }); }
  getProject(id: string) { return this.request<ProjectDetail>("GET", `/projects/${enc(id)}`); }
  renameProject(id: string, title: string) { return this.request<Project>("PATCH", `/projects/${enc(id)}`, { title }); }
  deleteRecording(id: string) { return this.request<void>("DELETE", `/recordings/${enc(id)}`); }

  createRecording(projectId: string, input: CreateRecordingInput, signal?: AbortSignal) {
    return this.request<{ recording: Recording; track: Track }>("POST", `/projects/${enc(projectId)}/recordings`, input, signal);
  }

  putChunk(trackId: string, index: number, blob: Blob, signal?: AbortSignal) {
    return this.request<{ receivedChunks: number }>("PUT", `/tracks/${enc(trackId)}/chunks/${index}`, blob, signal);
  }
  getTrack(id: string, signal?: AbortSignal) { return this.request<Track>("GET", `/tracks/${enc(id)}`, undefined, signal); }
  finalizeTrack(id: string, input: FinalizeInput, signal?: AbortSignal) {
    return this.request<Track>("POST", `/tracks/${enc(id)}/finalize`, input, signal);
  }

  /** Für <audio>/<video> (Range) bzw. als Download-Link (download: true). raw: Rohdatei bei failed. */
  trackFileUrl(id: string, opts: { download?: boolean; raw?: boolean } = {}) {
    return this.url(`/tracks/${enc(id)}/file`, { download: opts.download, raw: opts.raw });
  }

  createExport(trackId: string, format: ExportFormat) {
    return this.request<Export>("POST", `/tracks/${enc(trackId)}/exports`, { format });
  }
  getExport(id: string) { return this.request<Export>("GET", `/exports/${enc(id)}`); }
  exportFileUrl(id: string) { return this.url(`/exports/${enc(id)}/file`); }
}

const enc = encodeURIComponent;

/** Gemeinsame Instanz für die Oberfläche. */
export const api = new ApiClient();

export type PlannerStatus = 'planned'|'confirmed'|'done'|'canceled';
export interface PlannerEvent { id: string; projectId: string|null; projectTitle: string|null; title: string; notes: string;
  status: PlannerStatus; startsAt: string; endsAt: string; timeZone: string; revision: number; createdAt: string; updatedAt: string }
export interface PlannerInput { title: string; projectId?: string|null; notes?: string; status?: PlannerStatus;
  startsAt: string; endsAt: string; timeZone?: string }   // Standard 'Europe/Berlin'



export interface Edit { id: string; projectId: string; title: string; kind: 'audio'|'video'; revision: number;
  durationMs: number; createdAt: string; updatedAt: string }
export interface EditDetail extends Edit { edl: Edl; sources: EditSource[] }
export interface EditSource { trackId: string; recordingTitle: string; participantName: string; kind: TrackKind;
  durationMs: number; width: number|null; height: number|null; local: boolean }
export interface EditRevision { revision: number; durationMs: number; clipCount: number; createdAt: string }
export type RenderStatus = 'queued'|'processing'|'ready'|'failed'|'canceled';
export interface Render { id: string; editId: string; revision: number; format: 'mp4'|'mp3'|'wav'; status: RenderStatus;
  progress: number|null; bytes: number|null; durationMs: number|null; error: string|null; createdAt: string; finishedAt: string|null }

export type LiveStatus = 'created'|'live'|'interrupted'|'ended';
export interface Live { id: string; publicTitle: string; status: LiveStatus; endReason: string|null; epoch: number;
  linkActive: boolean; viewers: number; maxViewers: number; startedAt: string|null; endedAt: string|null; createdAt: string;
  health: { lastChunkAgeMs: number|null; speed: number|null } | null }
export interface LiveLink { url: string }      // nur in dieser Antwort; danach nicht mehr abrufbar

export interface WatchState { status: LiveStatus; publicTitle: string; epoch: number; startedAt: string|null }
