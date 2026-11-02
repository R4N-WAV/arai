/**
 * Projects, client side. Each project has its own random key; metadata
 * (name, description, genre, tags, colour) is encrypted with it before it
 * leaves the browser. The key reaches members as a signed, sealed grant.
 */
import {
  createGrant,
  fromBase64Url,
  generateKey,
  openGrant,
  openJson,
  sealJson,
  toBase64Url,
  type AccountKeys,
} from '@arai/crypto';
import type { MemberDto, ProjectDto, ProjectMeta, PublicMeta, Role } from '@arai/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAmbient } from '../components/Ambient';
import { api } from './api';
import { useSession } from './session';

export interface Project {
  id: string;
  role: Role;
  visibility: 'private' | 'public';
  keyVersion: number;
  createdAt: number;
  updatedAt: number;
  /** null when this browser could not open the project key (shown as locked). */
  meta: ProjectMeta | null;
  rotationDue: boolean;
  art: { at: number; keyVersion: number } | null;
  /** Username of whoever invited you, while this is an open invitation. */
  invitedBy?: string;
}

const keyCache = new Map<string, Uint8Array>();

/** The decrypted key for a project's current key version (only after it was opened). */
export function projectKey(p: { id: string; keyVersion: number }): Uint8Array | null {
  return keyCache.get(`${p.id}:${p.keyVersion}`) ?? null;
}
/** Any key version from this member's keyring (old content keeps its version). */
export function keyFor(projectId: string, version: number): Uint8Array | null {
  return keyCache.get(`${projectId}:${version}`) ?? null;
}
export function rememberKey(projectId: string, version: number, key: Uint8Array) {
  keyCache.set(`${projectId}:${version}`, key);
}
export const projectMetaContext = (id: string) => `project/${id}/meta`;
const metaContext = (id: string) => `project/${id}/meta`;

export function newProjectId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => alphabet[b & 31]).join('');
}

function cleanMeta(m: unknown): ProjectMeta | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (typeof o.name !== 'string' || typeof o.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(o.color)) return null;
  return {
    name: o.name.slice(0, 120),
    description: typeof o.description === 'string' ? o.description.slice(0, 2000) : '',
    genre: typeof o.genre === 'string' ? o.genre.slice(0, 60) : '',
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 10) : [],
    color: o.color,
  };
}

const publicPart = (m: ProjectMeta): PublicMeta => ({ name: m.name, description: m.description, genre: m.genre, tags: m.tags, color: m.color });

async function decode(dto: ProjectDto, keys: AccountKeys, myId: string): Promise<Project> {
  const base = { id: dto.id, role: dto.role, visibility: dto.visibility, keyVersion: dto.keyVersion, createdAt: dto.createdAt, updatedAt: dto.updatedAt, rotationDue: dto.rotationDue, art: dto.art, ...(dto.invitedBy ? { invitedBy: dto.invitedBy } : {}) };
  // Open every key version we hold; each grant's signature is checked first.
  for (const g of dto.grants) {
    if (keyCache.has(`${dto.id}:${g.keyVersion}`)) continue;
    try {
      // Our own grants are verified against the signing key held in this
      // browser, never the copy the server sends back.
      const granterKey = g.grantedBy === myId ? keys.sign.publicKey : await fromBase64Url(g.granterSignKey);
      const key = await openGrant(keys, granterKey, 'project', dto.id, g.keyVersion, myId, await fromBase64Url(g.wrappedKey), await fromBase64Url(g.signature));
      keyCache.set(`${dto.id}:${g.keyVersion}`, key);
    } catch {
      /* an unverifiable grant is ignored, never used */
    }
  }
  const key = keyCache.get(`${dto.id}:${dto.keyVersion}`);
  if (!key) return { ...base, meta: null };
  try {
    return { ...base, meta: cleanMeta(await openJson(key, await fromBase64Url(dto.encMeta), metaContext(dto.id))) };
  } catch {
    return { ...base, meta: null };
  }
}

/**
 * After someone left or was removed, an admin's browser makes a new project
 * key and grants it to everyone who remains. New content uses it; the person
 * who left never receives it.
 */
async function rotate(p: Project, keys: AccountKeys, myId: string): Promise<void> {
  if (!p.meta) return;
  const { members } = await api<{ members: MemberDto[] }>('GET', `/projects/${p.id}/members`);
  const next = p.keyVersion + 1;
  const key = await generateKey();
  const grants = await Promise.all(
    members.map(async (m) => {
      const box = m.id === myId ? keys.box.publicKey : await fromBase64Url(m.boxKey);
      const g = await createGrant(keys, box, 'project', p.id, next, m.id, key);
      return { userId: m.id, wrappedKey: await toBase64Url(g.wrapped), signature: await toBase64Url(g.signature) };
    }),
  );
  await api('POST', `/projects/${p.id}/rotate`, { keyVersion: next, encMeta: await toBase64Url(await sealJson(key, p.meta, metaContext(p.id))), grants });
  keyCache.set(`${p.id}:${next}`, key);
}

interface ProjectsState {
  projects: Project[] | null;
  invites: Project[];
  accept: (p: Project) => Promise<void>;
  decline: (p: Project) => Promise<void>;
  error: string | null;
  refresh: () => Promise<void>;
  create: (meta: ProjectMeta, visibility: 'private' | 'public') => Promise<Project>;
  update: (p: Project, changes: { meta?: ProjectMeta; visibility?: 'private' | 'public' }) => Promise<Project>;
  remove: (p: Project) => Promise<void>;
  /** Show only this project's colour in the background (null = all). */
  focus: (id: string | null) => void;
}

const Ctx = createContext<ProjectsState | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const { user, keys } = useSession();
  const { setSources } = useAmbient();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [invites, setInvites] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user || !keys) return;
    try {
      const [{ projects: dtos }, { invites: inv }] = await Promise.all([
        api<{ projects: ProjectDto[] }>('GET', '/projects'),
        api<{ invites: ProjectDto[] }>('GET', '/invites').catch(() => ({ invites: [] as ProjectDto[] })),
      ]);
      let list = await Promise.all(dtos.map((d) => decode(d, keys, user.id)));
      const due = list.filter((p) => p.rotationDue && (p.role === 'admin' || p.role === 'owner') && p.meta);
      if (due.length) {
        await Promise.all(due.map((p) => rotate(p, keys, user.id).catch(() => undefined)));
        const again = await api<{ projects: ProjectDto[] }>('GET', '/projects');
        list = await Promise.all(again.projects.map((d) => decode(d, keys, user.id)));
      }
      setProjects(list);
      setInvites(await Promise.all(inv.map((d) => decode(d, keys, user.id))));
      setError(null);
    } catch {
      setError('Your projects could not be loaded. Check your connection and try again.');
    }
  }, [user, keys]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The space takes on the colours of everything in it.
  useEffect(() => {
    const inView = (projects ?? []).filter((p) => !focused || p.id === focused);
    setSources(inView.flatMap((p) => (p.meta ? [p.meta.color] : [])));
  }, [projects, focused, setSources]);

  const value = useMemo<ProjectsState>(
    () => ({
      projects,
      invites,
      accept: async (p) => {
        await api('POST', `/invites/${p.id}/accept`);
        await refresh();
      },
      decline: async (p) => {
        await api('DELETE', `/projects/${p.id}/members/me`);
        setInvites((prev) => prev.filter((x) => x.id !== p.id));
      },
      error,
      refresh,
      focus: setFocused,
      create: async (meta, visibility) => {
        if (!user || !keys) throw new Error('locked');
        const id = newProjectId();
        const key = await generateKey();
        const grant = await createGrant(keys, keys.box.publicKey, 'project', id, 1, user.id, key);
        const { project } = await api<{ project: ProjectDto }>('POST', '/projects', {
          id,
          visibility,
          encMeta: await toBase64Url(await sealJson(key, meta, metaContext(id))),
          grant: { wrappedKey: await toBase64Url(grant.wrapped), signature: await toBase64Url(grant.signature) },
          publicMeta: visibility === 'public' ? publicPart(meta) : undefined,
        });
        keyCache.set(`${id}:1`, key);
        const p = await decode(project, keys, user.id);
        setProjects((prev) => [p, ...(prev ?? [])]);
        return p;
      },
      update: async (p, changes) => {
        if (!user || !keys) throw new Error('locked');
        const key = keyCache.get(`${p.id}:${p.keyVersion}`);
        if (!key) throw new Error('locked');
        const meta = changes.meta ?? p.meta;
        if (!meta) throw new Error('locked');
        const vis = changes.visibility ?? p.visibility;
        const body: Record<string, unknown> = {};
        if (changes.meta) body.encMeta = await toBase64Url(await sealJson(key, meta, metaContext(p.id)));
        if (changes.visibility !== undefined) body.visibility = vis;
        if (changes.visibility !== undefined || vis === 'public') body.publicMeta = vis === 'public' ? publicPart(meta) : null;
        const { project } = await api<{ project: ProjectDto }>('PATCH', `/projects/${p.id}`, body);
        const next = await decode(project, keys, user.id);
        setProjects((prev) => (prev ?? []).map((x) => (x.id === p.id ? next : x)));
        return next;
      },
      remove: async (p) => {
        await api('DELETE', `/projects/${p.id}`);
        setProjects((prev) => (prev ?? []).filter((x) => x.id !== p.id));
      },
    }),
    [projects, invites, error, refresh, user, keys],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjects(): ProjectsState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProjects outside ProjectsProvider');
  return v;
}

/** "an admin", "an editor", "a listener". */
export const roleWithArticle = (role: string) => `${/^[aeiou]/.test(role) ? 'an' : 'a'} ${role}`;
