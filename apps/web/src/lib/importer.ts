/**
 * Library import (Samply, Untitled or any folder of audio).
 *
 * Neither service offers a public way for another app to copy your library,
 * so import works from what they let you download: folders or ZIP files.
 * Everything here runs in the browser: files are read locally, grouped into
 * projects → tracks → versions, then encrypted and uploaded through the
 * normal upload pipeline. Nothing is sent anywhere unencrypted.
 */
import { Unzip, UnzipInflate } from 'fflate';

export interface SourceFile {
  path: string[]; // folder segments + file name
  file: File;
}

export interface PlanTrack {
  title: string;
  versions: File[]; // oldest → newest
}

export interface PlanProject {
  key: string;
  name: string;
  cover: File | null;
  tracks: PlanTrack[];
  bytes: number;
}

export interface ImportPlan {
  projects: PlanProject[];
  skipped: string[];
  bytes: number;
}

const AUDIO = /\.(wav|wave|aif|aiff|aifc|flac|mp3|m4a|ogg|oga|opus)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const COVER = /^(cover|artwork|folder|front|album|art)(\b|[_ .-])/i;
const JUNK = (seg: string) => seg === '__MACOSX' || seg.startsWith('.') || seg === 'Thumbs.db' || seg.startsWith('._');

export function isJunk(path: string[]): boolean {
  return path.some(JUNK);
}

// ------------------------------------------------------------- collecting

export function fromFileList(list: FileList | File[]): SourceFile[] {
  return Array.from(list).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return { file, path: rel ? rel.split('/') : [file.name] };
  });
}

/** Walks dropped folders (DataTransferItem.webkitGetAsEntry). */
export async function fromDrop(items: DataTransferItemList): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string[]): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: [...prefix, entry.name] });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, [...prefix, entry.name]);
      }
    }
  };
  const entries = Array.from(items)
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  for (const e of entries) await walk(e, []);
  return out;
}

/** Expands .zip archives in place (streamed, no worker, CSP-friendly). */
export async function expandZips(sources: SourceFile[], onProgress?: (name: string) => void): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const s of sources) {
    if (!/\.zip$/i.test(s.file.name)) {
      out.push(s);
      continue;
    }
    onProgress?.(s.file.name);
    const base = [...s.path.slice(0, -1), s.file.name.replace(/\.zip$/i, '')];
    const pending: Promise<void>[] = [];
    const unzip = new Unzip((entry) => {
      if (entry.name.endsWith('/')) return;
      const segs = entry.name.split('/');
      if (isJunk(segs) || !(AUDIO.test(entry.name) || IMAGE.test(entry.name))) return;
      const parts: Uint8Array[] = [];
      pending.push(
        new Promise<void>((resolve, reject) => {
          entry.ondata = (err, chunk, final) => {
            if (err) return reject(err);
            parts.push(chunk);
            if (final) {
              out.push({ path: [...base, ...segs], file: new File(parts as BlobPart[], segs.at(-1)!, { lastModified: s.file.lastModified }) });
              resolve();
            }
          };
          entry.start();
        }),
      );
    });
    unzip.register(UnzipInflate);
    const reader = s.file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        unzip.push(new Uint8Array(0), true);
        break;
      }
      unzip.push(value);
    }
    await Promise.all(pending);
  }
  return out;
}

// ------------------------------------------------------------- planning

const MARKERS = [
  { re: /[\s._-]*\((\d{1,3})\)$/, kind: 'num' },
  { re: /[\s._-]*-?\s*copy(\s*\d+)?$/i, kind: 'copy' },
  { re: /[\s._-]*(?:v|ver|version|rev|revision|take|mix|bounce|draft)[\s._-]*(\d{1,3})$/i, kind: 'num' },
  { re: /[\s._-]*(?:final|master|mastered)$/i, kind: 'final' },
] as const;

/** "Song v3.wav" → { title: "Song", version: 3 }. Plain trailing numbers are kept ("Track 2" is a different song). */
export function parseName(fileName: string): { title: string; version: number } {
  let title = fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  let version = 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of MARKERS) {
      const hit = m.re.exec(title);
      if (hit && hit.index > 0) {
        if (m.kind === 'num') version = Math.max(version, Number(hit[1]));
        if (m.kind === 'final') version = Math.max(version, 10_000);
        title = title.slice(0, hit.index).trim();
        changed = true;
      }
    }
  }
  return { title: title || fileName, version };
}

export function buildPlan(sources: SourceFile[]): ImportPlan {
  const files = sources.filter((s) => !isJunk(s.path));
  const skipped = files.filter((s) => !AUDIO.test(s.file.name) && !IMAGE.test(s.file.name)).map((s) => s.path.join('/'));
  const useful = files.filter((s) => AUDIO.test(s.file.name) || IMAGE.test(s.file.name));

  // Strip folders every file shares (e.g. the chosen "Samply export" folder).
  const dirs = useful.map((s) => s.path.slice(0, -1));
  let common = 0;
  while (dirs.length && dirs.every((d) => d.length > common + 1 && d[common] === dirs[0]![common])) common++;

  const groups = new Map<string, SourceFile[]>();
  for (const s of useful) {
    const rest = s.path.slice(common);
    const key = rest.length > 1 ? rest[0]! : (s.path[common - 1] ?? 'Imported');
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }

  const projects: PlanProject[] = [];
  for (const [key, list] of groups) {
    const audio = list.filter((s) => AUDIO.test(s.file.name));
    if (audio.length === 0) {
      skipped.push(...list.map((s) => s.path.join('/')));
      continue;
    }
    const images = list.filter((s) => IMAGE.test(s.file.name));
    const cover = (images.find((s) => COVER.test(s.file.name)) ?? images[0])?.file ?? null;
    const tracks = new Map<string, { title: string; items: { file: File; version: number }[] }>();
    for (const s of audio) {
      const { title, version } = parseName(s.file.name);
      const id = title.toLowerCase();
      const t = tracks.get(id) ?? { title, items: [] };
      t.items.push({ file: s.file, version });
      tracks.set(id, t);
    }
    const planTracks = [...tracks.values()]
      .map((t) => ({
        title: t.title,
        versions: t.items
          .sort((a, b) => a.version - b.version || a.file.lastModified - b.file.lastModified || a.file.name.localeCompare(b.file.name, undefined, { numeric: true }))
          .map((x) => x.file),
      }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    projects.push({ key, name: key.slice(0, 120), cover, tracks: planTracks, bytes: audio.reduce((n, s) => n + s.file.size, 0) });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { projects, skipped, bytes: projects.reduce((n, p) => n + p.bytes, 0) };
}

/** Average colour of a cover image (for the project colour / ambient glow). */
export async function coverColour(file: File): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0, 24, 24);
    bmp.close();
    const d = ctx.getImageData(0, 0, 24, 24).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      // Weight saturated pixels so a cover's character wins over its background.
      const max = Math.max(d[i]!, d[i + 1]!, d[i + 2]!), min = Math.min(d[i]!, d[i + 1]!, d[i + 2]!);
      const w = 1 + (max - min) / 32;
      r += d[i]! * w; g += d[i + 1]! * w; b += d[i + 2]! * w; n += w;
    }
    const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  } catch {
    return null;
  }
}
