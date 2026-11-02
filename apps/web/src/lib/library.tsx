/**
 * Private library preferences: pinned projects, folders and recently played
 * tracks. Stored on the server as one blob encrypted with a key derived from
 * your account key, so they follow you across devices and nobody else
 * (Arai included) can read them.
 */
import { deriveSubkey, fromBase64Url, openJson, sealJson, toBase64Url } from '@arai/crypto';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
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
  const loaded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!keys) return;
    let alive = true;
    void (async () => {
      key.current = await deriveSubkey(keys.ask, 'library-prefs');
      const r = await api<{ prefs: { encData: string } | null }>('GET', '/account/prefs').catch(() => ({ prefs: null }));
      if (!alive) return;
      if (r.prefs) {
        try {
          setPrefs(clean(await openJson(key.current, await fromBase64Url(r.prefs.encData), CTX)));
        } catch {
          /* unreadable (e.g. a different account key): start fresh */
        }
      }
      loaded.current = true;
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [keys]);

  // Save shortly after changes (batched), encrypted.
  const save = useCallback((next: LibraryPrefs) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (!key.current || !loaded.current) return;
      const encData = await toBase64Url(await sealJson(key.current, next, CTX));
      await api('PUT', '/account/prefs', { encData }).catch(() => undefined);
    }, 800);
  }, []);
  const update = useCallback(
    (fn: (p: LibraryPrefs) => LibraryPrefs) =>
      setPrefs((prev) => {
        const next = clean(fn(prev));
        save(next);
        return next;
      }),
    [save],
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
      dismissWelcome: () => update((p) => ({ ...p, welcomed: true })),
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
