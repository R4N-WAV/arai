/**
 * Private library preferences: pinned projects, folders and recently played
 * tracks. Stored on the server as one blob encrypted with a key derived from
 * your account key, so they follow you across devices and nobody else
 * (Arai included) can read them.
 */
import { deriveSubkey, fromBase64Url, openJson, sealJson, toBase64Url } from '@arai/crypto';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { useResume } from './live';
import { newProjectId } from './projects';
import { useSession } from './session';

export interface Folder {
  id: string;
  name: string;
  projectIds: string[];
}
export interface RecentPlay {
  projectId: string;
  trackId: string;
  title: string;
  at: number;
}
export interface LibraryPrefs {
  pins: string[];
  folders: Folder[];
  recent: RecentPlay[];
  /** The first-run guide was dismissed. */
  welcomed: boolean;
}
const EMPTY: LibraryPrefs = { pins: [], folders: [], recent: [], welcomed: false };
const CTX = 'account/library-prefs';

function clean(x: unknown): LibraryPrefs {
  const o = (x && typeof x === 'object' ? x : {}) as Partial<LibraryPrefs>;
  const ids = (a: unknown) => (Array.isArray(a) ? a.filter((v): v is string => typeof v === 'string').slice(0, 1000) : []);
  return {
    pins: ids(o.pins).slice(0, 100),
    folders: (Array.isArray(o.folders) ? o.folders : [])
      .filter((f): f is Folder => !!f && typeof f.id === 'string' && typeof f.name === 'string')
      .slice(0, 100)
      .map((f) => ({ id: f.id, name: f.name.slice(0, 60), projectIds: ids(f.projectIds) })),
    recent: (Array.isArray(o.recent) ? o.recent : [])
      .filter((r): r is RecentPlay => !!r && typeof r.trackId === 'string' && typeof r.projectId === 'string')
      .slice(0, 30)
      .map((r) => ({ projectId: r.projectId, trackId: r.trackId, title: String(r.title ?? '').slice(0, 200), at: Number(r.at) || 0 })),
    welcomed: o.welcomed === true,
  };
}

interface LibraryState {
  prefs: LibraryPrefs;
  togglePin: (projectId: string) => void;
  addFolder: (name: string) => string;
  renameFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;
  setInFolder: (folderId: string, projectId: string, inside: boolean) => void;
  recordPlay: (p: Omit<RecentPlay, 'at'>) => void;
  dismissWelcome: () => void;
  /** Preferences have been loaded from the server (avoids flashing the guide). */
  ready: boolean;
}
const Ctx = createContext<LibraryState | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { keys } = useSession();
  const [prefs, setPrefs] = useState<LibraryPrefs>(EMPTY);
  const [ready, setReady] = useState(false);
  const key = useRef<Uint8Array | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Changes made here that the server does not have yet, in order. */
  const pending = useRef<Array<(p: LibraryPrefs) => LibraryPrefs>>([]);
  const flushing = useRef(false);
  const retry = useRef<() => void>(() => undefined);

  /** What the server holds right now. Throws when it cannot be reached (never "empty" by mistake). */
  const fetchStored = useCallback(async (): Promise<LibraryPrefs> => {
    const r = await api<{ prefs: { encData: string } | null }>('GET', '/account/prefs');
    if (!r.prefs || !key.current) return EMPTY;
    try {
      return clean(await openJson(key.current, await fromBase64Url(r.prefs.encData), CTX));
    } catch {
      return EMPTY; // unreadable (e.g. a different account key): start fresh
    }
  }, []);

  /**
   * Saving re-reads the stored preferences and applies only the changes made
   * here on top. Writing back the copy this tab loaded hours ago would undo
   * pins and folders made on another device, and a failed first load would
   * replace everything with an empty library.
   */
  const flush = useCallback(async () => {
    if (flushing.current || !key.current) return;
    flushing.current = true;
    try {
      const todo = pending.current.slice();
      const next = todo.reduce((p, fn) => clean(fn(p)), await fetchStored());
      if (todo.length) await api('PUT', '/account/prefs', { encData: await toBase64Url(await sealJson(key.current, next, CTX)) });
      pending.current = pending.current.slice(todo.length);
      // Show the merged result, with anything changed meanwhile still applied on top.
      setPrefs(pending.current.reduce((p, fn) => clean(fn(p)), next));
      setReady(true);
    } catch {
      /* offline: changes stay queued and go out with the next save or when the tab is used again */
    } finally {
      flushing.current = false;
      if (pending.current.length) {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => retry.current(), 15_000);
      }
    }
  }, [fetchStored]);
  useEffect(() => {
    retry.current = () => void flush();
  }, [flush]);

  useEffect(() => {
    if (!keys) return;
    let alive = true;
    void (async () => {
      key.current = await deriveSubkey(keys.ask, 'library-prefs');
      if (!alive) return;
      await flush();
      // Could not load: let the app in anyway; nothing is saved until a load succeeds.
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [keys, flush]);
  // Pick up pins, folders and plays from other devices when this one is used again.
  useResume(() => void flush(), 30_000);

  const update = useCallback(
    (fn: (p: LibraryPrefs) => LibraryPrefs, delay = 800) => {
      pending.current.push(fn);
      setPrefs((prev) => clean(fn(prev)));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    },
    [flush],
  );

  const value = useMemo<LibraryState>(
    () => ({
      prefs,
      togglePin: (id) => update((p) => ({ ...p, pins: p.pins.includes(id) ? p.pins.filter((x) => x !== id) : [id, ...p.pins] })),
      addFolder: (name) => {
        const id = newProjectId();
        update((p) => ({ ...p, folders: [...p.folders, { id, name: name.trim().slice(0, 60) || 'Folder', projectIds: [] }] }));
        return id;
      },
      renameFolder: (id, name) => update((p) => ({ ...p, folders: p.folders.map((f) => (f.id === id ? { ...f, name: name.trim().slice(0, 60) || f.name } : f)) })),
      deleteFolder: (id) => update((p) => ({ ...p, folders: p.folders.filter((f) => f.id !== id) })),
      setInFolder: (fid, pid, inside) =>
        update((p) => ({ ...p, folders: p.folders.map((f) => (f.id !== fid ? f : { ...f, projectIds: inside ? [...new Set([...f.projectIds, pid])] : f.projectIds.filter((x) => x !== pid) })) })),
      ready,
      dismissWelcome: () => update((p) => ({ ...p, welcomed: true }), 0),
      recordPlay: (r) => update((p) => ({ ...p, recent: [{ ...r, at: Date.now() }, ...p.recent.filter((x) => x.trackId !== r.trackId)].slice(0, 30) })),
    }),
    [prefs, update, ready],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLibrary(): LibraryState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLibrary outside LibraryProvider');
  return v;
}
