/**
 * Collaboration, client side: inviting people (sealing every project key
 * version to them), comments (encrypted with the project key) and share
 * links (a random secret in the URL fragment; the server stores only a hash
 * of the derived access token and the payload encrypted with the link key).
 */
import { createGrant, deriveShareKeys, fromBase64Url, newShareSecret, openJson, sealJson, shareTokenHash, toBase64Url, type AccountKeys } from '@arai/crypto';
import type { CommentBody, CommentDto, InviteLinkDto, InvitePayload, MemberDto, ShareDto, SharePayload, UserKeysDto } from '@arai/shared';
import { api } from './api';
import { keyFor, newProjectId as newId, projectKey, type Project } from './projects';
import { fileKeyOf, type Track } from './tracks';
import { artDataUrl } from './art';

// ---- people -------------------------------------------------------------------

export async function lookupUser(username: string): Promise<UserKeysDto> {
  return (await api<{ user: UserKeysDto }>('GET', `/users/lookup/${encodeURIComponent(username.trim().replace(/^@/, ''))}`)).user;
}

export async function listMembers(p: Project): Promise<MemberDto[]> {
  return (await api<{ members: MemberDto[] }>('GET', `/projects/${p.id}/members`)).members;
}

/** Seals every key version 1..current to the invitee and signs each grant. */
export async function inviteMember(p: Project, keys: AccountKeys, user: UserKeysDto, role: 'listener' | 'editor' | 'admin'): Promise<void> {
  const box = await fromBase64Url(user.boxKey);
  const grants = [];
  for (let v = 1; v <= p.keyVersion; v++) {
    const key = keyFor(p.id, v);
    if (!key) throw new Error('locked');
    const g = await createGrant(keys, box, 'project', p.id, v, user.id, key);
    grants.push({ keyVersion: v, wrappedKey: await toBase64Url(g.wrapped), signature: await toBase64Url(g.signature) });
  }
  await api('POST', `/projects/${p.id}/members`, { userId: user.id, role, grants });
}

export const setMemberRole = (p: Project, userId: string, role: 'listener' | 'editor' | 'admin') => api('PATCH', `/projects/${p.id}/members/${userId}`, { role });
export const removeMember = (p: Project, userId: string) => api('DELETE', `/projects/${p.id}/members/${userId}`);

// ---- comments -------------------------------------------------------------------

export interface Comment {
  id: string;
  versionId: string;
  parentId: string | null;
  authorId: string | null;
  author: string;
  guest: boolean;
  body: CommentBody | null; // null = deleted or unreadable
  deleted: boolean;
  resolved: boolean;
  createdAt: number;
  editedAt: number | null;
}

const commentCtx = (id: string) => `comment/${id}`;
const guestCommentCtx = (linkId: string, id: string) => `share/${linkId}/comment/${id}`;
const shareSecretCtx = (linkId: string) => `share/${linkId}/secret`;
const payloadCtx = (linkId: string) => `share/${linkId}/payload`;

function cleanBody(b: unknown): CommentBody | null {
  if (!b || typeof b !== 'object') return null;
  const o = b as Record<string, unknown>;
  if (typeof o.text !== 'string') return null;
  return {
    text: o.text.slice(0, 4000),
    at: typeof o.at === 'number' && Number.isFinite(o.at) && o.at >= 0 ? o.at : null,
    ...(typeof o.name === 'string' ? { name: o.name.slice(0, 60) } : {}),
  };
}

async function linkKeyFromSecret(projectId: string, linkId: string, encSecret: string, keyVersion: number): Promise<{ secret: string; password: string; key: Uint8Array; token: Uint8Array } | null> {
  const pk = keyFor(projectId, keyVersion);
  if (!pk) return null;
  try {
    const { s, pw } = await openJson<{ s: string; pw: string }>(pk, await fromBase64Url(encSecret), shareSecretCtx(linkId));
    const k = await deriveShareKeys(s, pw);
    return { secret: s, password: pw, ...k };
  } catch {
    return null;
  }
}

export async function decodeComment(dto: CommentDto, key: Uint8Array | null, ctx: string): Promise<Comment> {
  let body: CommentBody | null = null;
  if (dto.encBody && key) {
    try {
      body = cleanBody(await openJson(key, await fromBase64Url(dto.encBody), ctx));
    } catch {
      body = null;
    }
  }
  return {
    id: dto.id,
    versionId: dto.versionId,
    parentId: dto.parentId,
    authorId: dto.authorId,
    author: dto.authorName ?? body?.name ?? 'Guest',
    guest: dto.linkId !== null,
    body,
    deleted: dto.encBody === null,
    resolved: dto.resolved,
    createdAt: dto.createdAt,
    editedAt: dto.editedAt,
  };
}

export async function loadComments(p: Project, versionId: string): Promise<Comment[]> {
  const { comments, links } = await api<{ comments: CommentDto[]; links: Record<string, { encSecret: string; keyVersion: number }> }>('GET', `/versions/${versionId}/comments`);
  const linkKeys = new Map<string, Uint8Array | null>();
  for (const [lid, l] of Object.entries(links)) linkKeys.set(lid, (await linkKeyFromSecret(p.id, lid, l.encSecret, l.keyVersion))?.key ?? null);
  return Promise.all(
    comments.map((c) =>
      c.linkId ? decodeComment(c, linkKeys.get(c.linkId) ?? null, guestCommentCtx(c.linkId, c.id)) : decodeComment(c, c.keyVersion ? keyFor(p.id, c.keyVersion) : null, commentCtx(c.id)),
    ),
  );
}

export async function addComment(p: Project, versionId: string, body: CommentBody, parentId: string | null = null): Promise<Comment> {
  const key = projectKey(p);
  if (!key) throw new Error('locked');
  const id = newId();
  const { comment } = await api<{ comment: CommentDto }>('POST', `/versions/${versionId}/comments`, {
    id,
    parentId,
    keyVersion: p.keyVersion,
    encBody: await toBase64Url(await sealJson(key, body, commentCtx(id))),
  });
  return decodeComment(comment, key, commentCtx(id));
}

export async function editComment(p: Project, c: Comment, text: string): Promise<Comment> {
  const key = projectKey(p);
  if (!key || !c.body) throw new Error('locked');
  const { comment } = await api<{ comment: CommentDto }>('PATCH', `/comments/${c.id}`, {
    keyVersion: p.keyVersion,
    encBody: await toBase64Url(await sealJson(key, { ...c.body, text }, commentCtx(c.id))),
  });
  return decodeComment(comment, key, commentCtx(c.id));
}

export async function resolveComment(c: Comment, resolved: boolean): Promise<void> {
  await api('PATCH', `/comments/${c.id}`, { resolved });
}
export const deleteComment = (c: Comment) => api('DELETE', `/comments/${c.id}`);

// ---- share links --------------------------------------------------------------------

export interface Share extends ShareDto {
  url: string | null;
}

export function shareUrl(linkId: string, secret: string): string {
  return `${location.origin}/s/${linkId}#${secret}`;
}

/** What a link holder may play: the current version of each track in scope. */
async function buildPayload(p: Project, tracks: Track[]): Promise<{ payload: SharePayload; files: Array<{ fileId: string; versionId: string }> }> {
  const playable = tracks.filter((t) => t.current && t.current.meta);
  const items = await Promise.all(
    playable.map(async (t) => {
      const v = t.current!;
      return {
        title: t.title,
        versionId: v.id,
        versionNumber: v.number,
        file: { id: v.file.id, encSize: v.file.encSize, chunkCount: v.file.chunkCount },
        fileKey: await toBase64Url(await fileKeyOf(p, v)),
        meta: v.meta,
      };
    }),
  );
  return {
    payload: { project: { name: p.meta?.name ?? 'Project', color: p.meta?.color ?? '#8a8f98', description: p.meta?.description ?? '', art: await artDataUrl(p).catch(() => null) }, tracks: items },
    files: items.map((i) => ({ fileId: i.file.id, versionId: i.versionId })),
  };
}

export interface ShareOptions {
  trackId: string | null;
  password: string;
  expiresInDays: number | null;
  allowDownload: boolean;
  allowComments: boolean;
}

export async function createShare(p: Project, tracks: Track[], o: ShareOptions, isPublic = false): Promise<Share> {
  const key = projectKey(p);
  if (!key) throw new Error('locked');
  const id = newId();
  const secret = await newShareSecret();
  const { token, key: linkKey } = await deriveShareKeys(secret, o.password);
  const scope = o.trackId ? tracks.filter((t) => t.id === o.trackId) : tracks;
  const { payload, files } = await buildPayload(p, scope);
  const { share } = await api<{ share: ShareDto }>('POST', `/projects/${p.id}/shares`, {
    id,
    trackId: o.trackId,
    tokenHash: await toBase64Url(await shareTokenHash(token)),
    hasPassword: o.password.length > 0,
    allowDownload: o.allowDownload,
    allowComments: o.allowComments,
    expiresAt: o.expiresInDays ? Date.now() + o.expiresInDays * 86400_000 : null,
    encPayload: await toBase64Url(await sealJson(linkKey, payload, payloadCtx(id))),
    encSecret: await toBase64Url(await sealJson(key, { s: secret, pw: o.password }, shareSecretCtx(id))),
    keyVersion: p.keyVersion,
    files,
    ...(isPublic ? { publicSecret: secret } : {}),
  });
  return { ...share, url: shareUrl(id, secret) };
}

export async function listShares(p: Project): Promise<Share[]> {
  const { shares } = await api<{ shares: ShareDto[] }>('GET', `/projects/${p.id}/shares`);
  return Promise.all(
    shares.map(async (s) => {
      const k = await linkKeyFromSecret(p.id, s.id, s.encSecret, s.keyVersion);
      return { ...s, url: k ? shareUrl(s.id, k.secret) : null };
    }),
  );
}

export const revokeShare = (p: Project, linkId: string) => api('DELETE', `/projects/${p.id}/shares/${linkId}`);

/** Re-encrypts every live link's payload after the tracks changed. */
export async function syncShares(p: Project, tracks: Track[]): Promise<void> {
  if (p.role === 'listener' || !p.meta) return;
  const { shares } = await api<{ shares: ShareDto[] }>('GET', `/projects/${p.id}/shares`);
  for (const s of shares) {
    const k = await linkKeyFromSecret(p.id, s.id, s.encSecret, s.keyVersion);
    if (!k) continue;
    const scope = s.trackId ? tracks.filter((t) => t.id === s.trackId) : tracks;
    const { payload, files } = await buildPayload(p, scope);
    await api('PUT', `/projects/${p.id}/shares/${s.id}`, { encPayload: await toBase64Url(await sealJson(k.key, payload, payloadCtx(s.id))), files });
  }
}

/** Public projects get one link whose secret is published, so anyone can listen. */
export async function ensurePublicListening(p: Project, tracks: Track[]): Promise<void> {
  if (p.visibility !== 'public' || (p.role !== 'admin' && p.role !== 'owner')) return;
  const { shares } = await api<{ shares: ShareDto[] }>('GET', `/projects/${p.id}/shares`);
  if (shares.some((s) => s.isPublic)) return;
  await createShare(p, tracks, { trackId: null, password: '', expiresInDays: null, allowDownload: false, allowComments: false }, true);
}

// ---- opening a link (anyone) ----------------------------------------------------------

export interface OpenedShare {
  linkId: string;
  token: string;
  key: Uint8Array;
  payload: SharePayload;
  allowDownload: boolean;
  allowComments: boolean;
}

export async function shareInfo(linkId: string): Promise<{ hasPassword: boolean }> {
  return api('GET', `/share/${linkId}`);
}

export async function openShare(linkId: string, secret: string, password = ''): Promise<OpenedShare> {
  const { token, key } = await deriveShareKeys(secret, password);
  const tokenB64 = await toBase64Url(token);
  const r = await api<{ encPayload: string; allowDownload: boolean; allowComments: boolean }>('POST', `/share/${linkId}/open`, { token: tokenB64 });
  const payload = await openJson<SharePayload>(key, await fromBase64Url(r.encPayload), payloadCtx(linkId));
  return { linkId, token: tokenB64, key, payload, allowDownload: r.allowDownload, allowComments: r.allowComments };
}

export async function guestComments(s: OpenedShare): Promise<Comment[]> {
  const { comments } = await api<{ comments: CommentDto[] }>('POST', `/share/${s.linkId}/comments/list`, { token: s.token });
  return Promise.all(comments.map((c) => decodeComment(c, s.key, guestCommentCtx(s.linkId, c.id))));
}

export async function addGuestComment(s: OpenedShare, versionId: string, body: CommentBody, parentId: string | null = null): Promise<Comment> {
  const id = newId();
  const { comment } = await api<{ comment: CommentDto }>('POST', `/share/${s.linkId}/comments`, {
    token: s.token,
    id,
    versionId,
    parentId,
    encBody: await toBase64Url(await sealJson(s.key, body, guestCommentCtx(s.linkId, id))),
  });
  return decodeComment(comment, s.key, guestCommentCtx(s.linkId, id));
}

// ---- invite links ---------------------------------------------------------------------
const invitePayloadCtx = (id: string) => `invite/${id}/payload`;
const inviteSecretCtx = (id: string) => `invite/${id}/secret`;
export const inviteUrl = (id: string, secret: string) => `${location.origin}/join/${id}#${secret}`;

export interface InviteLink extends InviteLinkDto {
  url: string | null;
}

/** A link that lets anyone with an Arai account join; it carries the project keys in its secret part. */
export async function createInviteLink(p: Project, role: 'listener' | 'editor', maxUses: number, expiresInDays: number): Promise<string> {
  const key = projectKey(p);
  if (!key || !p.meta) throw new Error('locked');
  const id = newId();
  const secret = await newShareSecret();
  const { token, key: linkKey } = await deriveShareKeys(secret);
  const keys = [];
  for (let v = 1; v <= p.keyVersion; v++) {
    const k = keyFor(p.id, v);
    if (!k) throw new Error('locked');
    keys.push({ keyVersion: v, key: await toBase64Url(k) });
  }
  const payload: InvitePayload = { projectId: p.id, name: p.meta.name, keys };
  await api('POST', `/projects/${p.id}/invite-links`, {
    id,
    role,
    tokenHash: await toBase64Url(await shareTokenHash(token)),
    encPayload: await toBase64Url(await sealJson(linkKey, payload, invitePayloadCtx(id))),
    encSecret: await toBase64Url(await sealJson(key, { s: secret }, inviteSecretCtx(id))),
    keyVersion: p.keyVersion,
    maxUses,
    expiresInDays,
  });
  return inviteUrl(id, secret);
}

export async function listInviteLinks(p: Project): Promise<InviteLink[]> {
  const { links } = await api<{ links: InviteLinkDto[] }>('GET', `/projects/${p.id}/invite-links`);
  return Promise.all(
    links.map(async (l) => {
      const k = keyFor(p.id, l.keyVersion);
      const s = k ? await openJson<{ s: string }>(k, await fromBase64Url(l.encSecret), inviteSecretCtx(l.id)).catch(() => null) : null;
      return { ...l, url: s ? inviteUrl(l.id, s.s) : null };
    }),
  );
}
export const revokeInviteLink = (p: Project, id: string) => api('DELETE', `/projects/${p.id}/invite-links/${id}`);

export async function openInvite(linkId: string, secret: string): Promise<{ payload: InvitePayload; role: string; alreadyMember: boolean; token: string }> {
  const { token, key } = await deriveShareKeys(secret);
  const t = await toBase64Url(token);
  const r = await api<{ encPayload: string; role: string; alreadyMember: boolean }>('POST', `/join/${linkId}/open`, { token: t });
  const payload = await openJson<InvitePayload>(key, await fromBase64Url(r.encPayload), invitePayloadCtx(linkId));
  return { payload, role: r.role, alreadyMember: r.alreadyMember, token: t };
}

/** Joins: re-seals every key version to yourself (signed by you) and registers membership. */
export async function joinWithInvite(linkId: string, opened: { payload: InvitePayload; token: string }, keys: AccountKeys, myId: string): Promise<string> {
  const grants = await Promise.all(
    opened.payload.keys.map(async (k) => {
      const g = await createGrant(keys, keys.box.publicKey, 'project', opened.payload.projectId, k.keyVersion, myId, await fromBase64Url(k.key));
      return { keyVersion: k.keyVersion, wrappedKey: await toBase64Url(g.wrapped), signature: await toBase64Url(g.signature) };
    }),
  );
  return (await api<{ projectId: string }>('POST', `/join/${linkId}`, { token: opened.token, grants })).projectId;
}
