/**
 * Tracks and versions, client side. Audio is encrypted here in 1 MiB chunks
 * with a fresh per-file key (wrapped by the project key) before upload, and
 * decrypted here for playback. The server stores and returns ciphertext only.
 */
import {
  chunkCount,
  decryptChunk,
  encryptChunk,
  encryptedSize,
  fromBase64Url,
  generateKey,
  open,
  openJson,
  seal,
  sealJson,
  toBase64Url,
  CHUNK_SIZE,
} from '@arai/crypto';
import { MAX_FILE_BYTES, type TrackDto, type TrackVersionDto } from '@arai/shared';
import { api, ApiError } from './api';
import { analyse, sniff, type AudioFormat } from './audio';
import { keyFor, newProjectId as newId, projectKey, type Project } from './projects';

export interface VersionMeta {
  fileName: string;
  format: AudioFormat['format'];
  mime: string;
  size: number;
  duration: number | null;
  sampleRate: number | null;
  channels: number | null;
  peaks: string | null; // base64url of 0–255 buckets
  rms?: string | null;
  loudness?: number | null; // LUFS
  peakDb?: number | null;
  bitDepth?: number | null;
  notes: string;
}

export interface TrackVersion {
  id: string;
  number: number;
  createdBy: string;
  createdAt: number;
  meta: VersionMeta | null;
  file: TrackVersionDto['file'];
}

export interface Trim {
  start: number;
  end: number | null;
}
export interface Track {
  id: string;
  title: string;
  /** Non-destructive trims per version (the original file is untouched). */
  trims: Record<string, Trim>;
  position: number;
  currentVersionId: string | null;
  versions: TrackVersion[];
  current: TrackVersion | null;
}

const trackCtx = (id: string) => `track/${id}/meta`;
const versionCtx = (id: string) => `version/${id}/meta`;
const fileKeyCtx = (id: string) => `file/${id}/key`;

function needKey(project: Project): Uint8Array {
  const k = projectKey(project);
  if (!k) throw new Error('locked');
  return k;
}

async function decodeTrack(dto: TrackDto, projectId: string): Promise<Track> {
  let title = 'Untitled track';
  const trims: Record<string, Trim> = {};
  try {
    const key = keyFor(projectId, dto.keyVersion);
    if (!key) throw new Error('locked');
    const m = await openJson<{ title?: unknown; trims?: unknown }>(key, await fromBase64Url(dto.encMeta), trackCtx(dto.id));
    if (typeof m.title === 'string') title = m.title.slice(0, 200);
    if (m.trims && typeof m.trims === 'object') {
      for (const [vid, t] of Object.entries(m.trims as Record<string, Partial<Trim>>)) {
        const start = typeof t?.start === 'number' && t.start >= 0 ? t.start : 0;
        const end = typeof t?.end === 'number' && t.end > start ? t.end : null;
        if (start > 0 || end) trims[vid] = { start, end };
      }
    }
  } catch {
    title = 'Locked track';
  }
  const versions = await Promise.all(
    dto.versions.map(async (v): Promise<TrackVersion> => {
      let meta: VersionMeta | null = null;
      try {
        const key = keyFor(projectId, v.keyVersion);
        if (key) meta = await openJson<VersionMeta>(key, await fromBase64Url(v.encMeta), versionCtx(v.id));
      } catch {
        meta = null;
      }
      return { id: v.id, number: v.number, createdBy: v.createdBy, createdAt: v.createdAt, meta, file: v.file };
    }),
  );
  return { id: dto.id, title, trims, position: dto.position, currentVersionId: dto.currentVersionId, versions, current: versions.find((v) => v.id === dto.currentVersionId) ?? versions.at(-1) ?? null };
}

/** The decrypted per-file key of a version (wrapped by the key version current at upload). */
export async function fileKeyOf(project: { id: string }, v: TrackVersion): Promise<Uint8Array> {
  const key = keyFor(project.id, v.file.keyVersion);
  if (!key) throw new Error('locked');
  return open(key, await fromBase64Url(v.file.encFileKey), fileKeyCtx(v.file.id));
}

export async function loadTracks(project: Project): Promise<Track[]> {
  needKey(project);
  const { tracks } = await api<{ tracks: TrackDto[] }>('GET', `/projects/${project.id}/tracks`);
  return Promise.all(tracks.map((t) => decodeTrack(t, project.id)));
}

export async function renameTrack(project: Project, track: Track, title: string, trims: Record<string, Trim> = track.trims): Promise<Track> {
  const key = needKey(project);
  const encMeta = await toBase64Url(await sealJson(key, { title, trims }, trackCtx(track.id)));
  const { track: t } = await api<{ track: TrackDto }>('PATCH', `/tracks/${track.id}`, { encMeta, keyVersion: project.keyVersion });
  return decodeTrack(t, project.id);
}

/** Saves (or clears, with null) the trim of one version. */
export function setTrim(project: Project, track: Track, versionId: string, trim: Trim | null): Promise<Track> {
  const trims = { ...track.trims };
  if (trim && (trim.start > 0 || trim.end)) trims[versionId] = trim;
  else delete trims[versionId];
  return renameTrack(project, track, track.title, trims);
}

export async function makeCurrent(project: Project, track: Track, versionId: string): Promise<Track> {
  const { track: t } = await api<{ track: TrackDto }>('PATCH', `/tracks/${track.id}`, { currentVersionId: versionId });
  return decodeTrack(t, project.id);
}

export async function deleteTrack(track: Track): Promise<void> {
  await api('DELETE', `/tracks/${track.id}`);
}

// ---------------------------------------------------------------- uploads

export type UploadState = 'preparing' | 'uploading' | 'finishing' | 'done' | 'failed' | 'cancelled';

async function putChunk(fileId: string, idx: number, body: Uint8Array, signal: AbortSignal): Promise<void> {
  let delay = 800;
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(`/api/files/${fileId}/chunks/${idx}`, {
        method: 'PUT',
        headers: { 'X-Arai-CSRF': '1', 'Content-Type': 'application/octet-stream' },
        credentials: 'same-origin',
        body: body as BodyInit,
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
    }
    if (res?.ok) return;
    const retryable = !res || res.status >= 500 || res.status === 429;
    if (!retryable || attempt >= 3) {
      const data = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
      throw new ApiError(res?.status ?? 0, data.error ?? 'network_error');
    }
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
}

/**
 * One file upload. `start()` runs it; after a failure, `start()` again resumes
 * from the first chunk the server does not have yet.
 */
export class UploadJob {
  readonly id = crypto.randomUUID();
  state: UploadState = 'preparing';
  progress = 0;
  error: string | null = null;
  private controller = new AbortController();
  private fileId: string | null = null;
  private fileKey: Uint8Array | null = null;
  private meta: VersionMeta | null = null;
  private trackDone: Track | null = null;

  constructor(
    readonly project: Project,
    readonly file: File,
    readonly onChange: (job: UploadJob) => void,
    readonly existingTrack: Track | null = null,
    readonly notes = '',
    readonly title: string | null = null,
  ) {}

  get name() {
    return this.file.name;
  }

  get result() {
    return this.trackDone;
  }

  cancel() {
    this.controller.abort();
    this.set('cancelled');
  }

  private set(state: UploadState, error: string | null = null) {
    this.state = state;
    this.error = error;
    this.onChange(this);
  }

  async start(): Promise<Track | null> {
    if (this.controller.signal.aborted) this.controller = new AbortController();
    const signal = this.controller.signal;
    try {
      const key = needKey(this.project);
      if (!this.fileId) {
        this.set('preparing');
        if (this.file.size === 0) throw new Error('empty_file');
        if (this.file.size > MAX_FILE_BYTES) throw new Error('too_large');
        const fmt = await sniff(this.file);
        if (!fmt) throw new Error('unsupported_format');
        const a = await analyse(this.file, fmt.format);
        this.meta = {
          fileName: this.file.name.slice(0, 200),
          format: fmt.format,
          mime: fmt.mime,
          size: this.file.size,
          duration: a.duration,
          sampleRate: a.sampleRate,
          channels: a.channels,
          peaks: a.peaks ? await toBase64Url(a.peaks) : null,
          rms: a.rms ? await toBase64Url(a.rms) : null,
          loudness: a.loudness,
          peakDb: a.peakDb,
          bitDepth: a.bitDepth,
          notes: this.notes.slice(0, 500),
        };
        const fileId = newId();
        const fileKey = await generateKey();
        await api('POST', `/projects/${this.project.id}/files`, {
          id: fileId,
          kind: 'audio',
          encSize: encryptedSize(this.file.size),
          chunkCount: chunkCount(this.file.size),
          encFileKey: await toBase64Url(await seal(key, fileKey, fileKeyCtx(fileId))),
          keyVersion: this.project.keyVersion,
        });
        this.fileId = fileId;
        this.fileKey = fileKey;
      }
      const fileId = this.fileId!;
      const n = chunkCount(this.file.size);
      const { received } = await api<{ received: number[] }>('GET', `/files/${fileId}/status`);
      const have = new Set(received);
      this.set('uploading');
      for (let i = 0; i < n; i++) {
        if (signal.aborted) return null;
        if (!have.has(i)) {
          const plain = new Uint8Array(await this.file.slice(i * CHUNK_SIZE, Math.min(this.file.size, (i + 1) * CHUNK_SIZE)).arrayBuffer());
          const enc = await encryptChunk(this.fileKey!, fileId, i, i === n - 1, plain);
          await putChunk(fileId, i, enc, signal);
        }
        this.progress = (i + 1) / n;
        this.onChange(this);
      }
      this.set('finishing');
      await api('POST', `/files/${fileId}/complete`);
      const versionId = newId();
      const encMeta = await toBase64Url(await sealJson(key, this.meta, versionCtx(versionId)));
      let dto: TrackDto;
      if (this.existingTrack) {
        dto = (await api<{ track: TrackDto }>('POST', `/tracks/${this.existingTrack.id}/versions`, { id: versionId, fileId, encMeta, keyVersion: this.project.keyVersion })).track;
      } else {
        const trackId = newId();
        const title = (this.title ?? this.file.name.replace(/\.[^.]+$/, '')).slice(0, 200) || 'Untitled track';
        dto = (
          await api<{ track: TrackDto }>('POST', `/projects/${this.project.id}/tracks`, {
            id: trackId,
            encMeta: await toBase64Url(await sealJson(key, { title }, trackCtx(trackId))),
            keyVersion: this.project.keyVersion,
            version: { id: versionId, fileId, encMeta, keyVersion: this.project.keyVersion },
          })
        ).track;
      }
      this.trackDone = await decodeTrack(dto, this.project.id);
      this.progress = 1;
      this.set('done');
      return this.trackDone;
    } catch (e) {
      if (signal.aborted) return null;
      const code = e instanceof ApiError ? e.code : e instanceof Error ? e.message : 'upload_failed';
      this.set('failed', code);
      return null;
    }
  }
}

export const UPLOAD_ERRORS: Record<string, string> = {
  unsupported_format: 'This file is not a supported audio format (WAV, AIFF, FLAC, MP3, M4A or OGG).',
  too_large: 'Files can be up to 250 MB.',
  empty_file: 'This file is empty.',
  quota_exceeded: 'You have used your 500 MB of storage. Delete something to make room.',
  storage_full: 'Arai’s free storage is full right now. Uploads are paused.',
  network_error: 'The connection dropped. Retry to continue where it stopped.',
  forbidden: 'You do not have permission to upload to this project.',
  locked: 'This project is locked in this browser.',
  stale_key: 'The project’s key just changed (someone left). Reload the page and try again.',
};

// ---------------------------------------------------------------- playback

const urlCache = new Map<string, string>();

/** Downloads, verifies and decrypts a version; returns a playable blob URL. */
export async function audioUrl(project: Project, v: TrackVersion, onProgress?: (p: number) => void): Promise<string> {
  const cached = urlCache.get(v.id);
  if (cached) return cached;
  const fileKey = await fileKeyOf(project, v);
  const n = v.file.chunkCount;
  const parts: Uint8Array[] = Array.from({ length: n });
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < n) {
      const i = next++;
      const res = await fetch(`/api/files/${v.file.id}/chunks/${i}`, { credentials: 'same-origin' });
      if (!res.ok) throw new ApiError(res.status, 'download_failed');
      parts[i] = await decryptChunk(fileKey, v.file.id, i, i === n - 1, new Uint8Array(await res.arrayBuffer()));
      onProgress?.(++done / n);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, n) }, worker));
  const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: v.meta?.mime ?? 'application/octet-stream' }));
  urlCache.set(v.id, url);
  // Keep memory bounded: only the few most recent decrypted tracks stay in memory.
  if (urlCache.size > 4) {
    const [oldest] = urlCache.keys();
    URL.revokeObjectURL(urlCache.get(oldest!)!);
    urlCache.delete(oldest!);
  }
  return url;
}

export interface WaveData {
  peaks: Uint8Array;
  rms: Uint8Array | null;
}

export async function decodeWave(meta: VersionMeta | null): Promise<WaveData | null> {
  if (!meta?.peaks) return null;
  try {
    return { peaks: await fromBase64Url(meta.peaks), rms: meta.rms ? await fromBase64Url(meta.rms) : null };
  } catch {
    return null;
  }
}
