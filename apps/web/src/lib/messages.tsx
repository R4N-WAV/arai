/**
 * Messaging, client side. Conversation keys (DMs, groups) are random keys
 * shared as signed sealed grants; project chats use the project keyring.
 * Message bodies and attachments are encrypted here before they leave the
 * browser. A single WebSocket per tab carries realtime events (ids and
 * ciphertext only).
 */
import {
  chunkCount,
  createGrant,
  decryptChunk,
  encryptChunk,
  encryptedSize,
  fromBase64Url,
  generateKey,
  openGrant,
  openJson,
  sealJson,
  toBase64Url,
  CHUNK_SIZE,
  type AccountKeys,
} from '@arai/crypto';
import type { ConversationDto, MessageBody, MessageDto, Reaction, RealtimeEvent, UserKeysDto } from '@arai/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { keyFor, newProjectId as newId, rememberKey } from './projects';
import { useSession } from './session';

// ---- keys ---------------------------------------------------------------------

const convKeys = new Map<string, Uint8Array>();
const ck = (id: string, v: number) => `${id}:${v}`;
export function conversationKey(c: { id: string; kind: string; projectId: string | null }, v: number): Uint8Array | null {
  return c.kind === 'project' ? keyFor(c.projectId!, v) : convKeys.get(ck(c.id, v)) ?? null;
}
const metaCtx = (id: string) => `conversation/${id}/meta`;
const msgCtx = (id: string) => `message/${id}`;

export interface Conversation extends ConversationDto {
  /** Group name (decrypted), else null. */
  name: string | null;
  lastText: string | null;
}

async function openKeys(dto: ConversationDto, keys: AccountKeys, me: string): Promise<void> {
  const scope = dto.kind === 'project' ? 'project' : 'conversation';
  const id = dto.kind === 'project' ? dto.projectId! : dto.id;
  for (const g of dto.grants) {
    const cacheHit = dto.kind === 'project' ? keyFor(id, g.keyVersion) : convKeys.get(ck(id, g.keyVersion));
    if (cacheHit) continue;
    try {
      const granter = g.grantedBy === me ? keys.sign.publicKey : await fromBase64Url(g.granterSignKey);
      const key = await openGrant(keys, granter, scope, id, g.keyVersion, me, await fromBase64Url(g.wrappedKey), await fromBase64Url(g.signature));
      if (dto.kind === 'project') rememberKey(id, g.keyVersion, key);
      else convKeys.set(ck(id, g.keyVersion), key);
    } catch {
      /* unverifiable grants are never used */
    }
  }
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: MessageBody | null;
  deleted: boolean;
  replyTo: string | null;
  createdAt: number;
  editedAt: number | null;
  reactions: MessageDto['reactions'];
}

export async function decodeMessage(c: Pick<Conversation, 'id' | 'kind' | 'projectId'>, m: MessageDto): Promise<Message> {
  let body: MessageBody | null = null;
  if (m.encBody) {
    const key = conversationKey(c, m.keyVersion);
    if (key) {
      try {
        const b = await openJson<MessageBody>(key, await fromBase64Url(m.encBody), msgCtx(m.id));
        body = typeof b?.text === 'string' ? { text: b.text.slice(0, 8000), attachments: Array.isArray(b.attachments) ? b.attachments.slice(0, 10) : undefined, gif: b.gif } : null;
      } catch {
        body = null;
      }
    }
  }
  return { id: m.id, conversationId: m.conversationId, senderId: m.senderId, body, deleted: m.encBody === null, replyTo: m.replyTo, createdAt: m.createdAt, editedAt: m.editedAt, reactions: m.reactions };
}

export async function decodeConversation(dto: ConversationDto, keys: AccountKeys, me: string): Promise<Conversation> {
  await openKeys(dto, keys, me);
  let name: string | null = null;
  if (dto.encMeta) {
    const key = conversationKey(dto, dto.keyVersion);
    if (key) name = await openJson<{ name?: string }>(key, await fromBase64Url(dto.encMeta), metaCtx(dto.id)).then((m) => (typeof m.name === 'string' ? m.name.slice(0, 80) : null)).catch(() => null);
  }
  const last = dto.last ? await decodeMessage(dto, dto.last) : null;
  const lastText = last ? (last.deleted ? 'Message deleted' : last.body ? last.body.text || (last.body.attachments?.length ? 'Attachment' : last.body.gif ? 'GIF' : '') : 'Encrypted message') : null;
  return { ...dto, name, lastText };
}

// ---- creating conversations -----------------------------------------------------

async function grantsFor(keys: AccountKeys, me: string, convId: string, version: number, key: Uint8Array, people: Array<{ id: string; boxKey: string }>) {
  return Promise.all(
    people.map(async (p) => {
      const box = p.id === me ? keys.box.publicKey : await fromBase64Url(p.boxKey);
      const g = await createGrant(keys, box, 'conversation', convId, version, p.id, key);
      return { userId: p.id, wrappedKey: await toBase64Url(g.wrapped), signature: await toBase64Url(g.signature) };
    }),
  );
}

export async function startConversation(keys: AccountKeys, me: string, people: UserKeysDto[], groupName: string | null): Promise<ConversationDto> {
  const id = newId();
  const key = await generateKey();
  const kind = people.length === 1 && !groupName ? 'dm' : 'group';
  const everyone = [{ id: me, boxKey: '' }, ...people.map((p) => ({ id: p.id, boxKey: p.boxKey }))];
  const { conversation } = await api<{ conversation: ConversationDto }>('POST', '/conversations', {
    id,
    kind,
    userIds: people.map((p) => p.id),
    grants: await grantsFor(keys, me, id, 1, key, everyone),
    ...(kind === 'group' ? { encMeta: await toBase64Url(await sealJson(key, { name: groupName || 'Group' }, metaCtx(id))) } : {}),
  });
  if (conversation.id === id) convKeys.set(ck(id, 1), key);
  return conversation;
}

export async function addToGroup(keys: AccountKeys, c: Conversation, user: UserKeysDto): Promise<void> {
  const box = await fromBase64Url(user.boxKey);
  const grants = [];
  for (let v = 1; v <= c.keyVersion; v++) {
    const key = conversationKey(c, v);
    if (!key) throw new Error('locked');
    const g = await createGrant(keys, box, 'conversation', c.id, v, user.id, key);
    grants.push({ keyVersion: v, wrappedKey: await toBase64Url(g.wrapped), signature: await toBase64Url(g.signature) });
  }
  await api('POST', `/conversations/${c.id}/members`, { userId: user.id, grants });
}

/** After someone left a group: a new key for everyone who remains (admin's browser). */
export async function rotateGroup(keys: AccountKeys, me: string, c: Conversation): Promise<void> {
  const next = c.keyVersion + 1;
  const key = await generateKey();
  const people = c.members.filter((m) => m.status !== 'left').map((m) => ({ id: m.id, boxKey: m.boxKey }));
  await api('POST', `/conversations/${c.id}/rotate`, {
    keyVersion: next,
    encMeta: c.name ? await toBase64Url(await sealJson(key, { name: c.name }, metaCtx(c.id))) : null,
    grants: await grantsFor(keys, me, c.id, next, key, people),
  });
  convKeys.set(ck(c.id, next), key);
}

// ---- messages ---------------------------------------------------------------------

export async function loadMessages(c: Conversation, before?: number): Promise<{ messages: Message[]; more: boolean }> {
  const r = await api<{ messages: MessageDto[]; more: boolean }>('GET', `/conversations/${c.id}/messages${before ? `?before=${before}` : ''}`);
  return { messages: await Promise.all(r.messages.map((m) => decodeMessage(c, m))), more: r.more };
}

export async function sendMessage(c: Conversation, body: MessageBody, replyTo: string | null = null): Promise<Message> {
  const key = conversationKey(c, c.keyVersion);
  if (!key) throw new Error('locked');
  const id = newId();
  const { message } = await api<{ message: MessageDto }>('POST', `/conversations/${c.id}/messages`, { id, keyVersion: c.keyVersion, encBody: await toBase64Url(await sealJson(key, body, msgCtx(id))), replyTo });
  return decodeMessage(c, message);
}

export async function editMessage(c: Conversation, m: Message, text: string): Promise<Message> {
  const key = conversationKey(c, c.keyVersion);
  if (!key || !m.body) throw new Error('locked');
  const { message } = await api<{ message: MessageDto }>('PATCH', `/messages/${m.id}`, { keyVersion: c.keyVersion, encBody: await toBase64Url(await sealJson(key, { ...m.body, text }, msgCtx(m.id))) });
  return decodeMessage(c, message);
}

export const deleteMessage = (m: Message) => api<{ message: MessageDto }>('DELETE', `/messages/${m.id}`);
export const react = (m: Message, r: Reaction, on: boolean) => api<{ message: MessageDto }>(on ? 'POST' : 'DELETE', `/messages/${m.id}/reactions/${r}`);

// ---- attachments --------------------------------------------------------------------

export const MAX_ATTACHMENT = 25 * 1024 * 1024;

export async function uploadAttachment(c: Conversation, file: File, onProgress?: (p: number) => void): Promise<NonNullable<MessageBody['attachments']>[number]> {
  if (file.size === 0) throw new Error('empty_file');
  if (file.size > MAX_ATTACHMENT) throw new Error('attachment_too_large');
  const id = newId();
  const key = await generateKey();
  const n = chunkCount(file.size);
  const encSize = encryptedSize(file.size);
  await api('POST', `/conversations/${c.id}/files`, { id, encSize, chunkCount: n });
  for (let i = 0; i < n; i++) {
    const plain = new Uint8Array(await file.slice(i * CHUNK_SIZE, Math.min(file.size, (i + 1) * CHUNK_SIZE)).arrayBuffer());
    const enc = await encryptChunk(key, id, i, i === n - 1, plain);
    const res = await fetch(`/api/conv-files/${id}/chunks/${i}`, { method: 'PUT', headers: { 'X-Arai-CSRF': '1', 'Content-Type': 'application/octet-stream' }, credentials: 'same-origin', body: enc as BodyInit });
    if (!res.ok) throw new ApiError(res.status, 'upload_failed');
    onProgress?.((i + 1) / n);
  }
  await api('POST', `/conv-files/${id}/complete`);
  return { fileId: id, key: await toBase64Url(key), name: file.name.slice(0, 200), mime: file.type.slice(0, 100) || 'application/octet-stream', size: file.size, encSize, chunkCount: n };
}

const attachmentUrls = new Map<string, string>();
export async function attachmentUrl(a: NonNullable<MessageBody['attachments']>[number]): Promise<string> {
  const hit = attachmentUrls.get(a.fileId);
  if (hit) return hit;
  const key = await fromBase64Url(a.key);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < a.chunkCount; i++) {
    const res = await fetch(`/api/conv-files/${a.fileId}/chunks/${i}`, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'download_failed');
    parts.push(await decryptChunk(key, a.fileId, i, i === a.chunkCount - 1, new Uint8Array(await res.arrayBuffer())));
  }
  // Only safe, inert types are shown inline; everything else downloads as bytes.
  const inline = /^(image\/(png|jpeg|gif|webp)|audio\/[a-z0-9.+-]+)$/.test(a.mime) ? a.mime : 'application/octet-stream';
  const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: inline }));
  attachmentUrls.set(a.fileId, url);
  return url;
}

// ---- realtime ----------------------------------------------------------------------------

type Listener = (e: RealtimeEvent) => void;
interface RealtimeState {
  subscribe: (fn: Listener) => () => void;
  connected: boolean;
  unread: number;
  refreshUnread: () => void;
}
const RealtimeCtx = createContext<RealtimeState | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);
  const [unread, setUnread] = useState(0);

  const refreshUnread = useCallback(() => {
    api<{ conversations: ConversationDto[] }>('GET', '/conversations')
      .then((r) => setUnread(r.conversations.reduce((n, c) => n + (c.myStatus === 'request' ? 1 : c.unread), 0)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!user) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let delay = 1000;
    let ping: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/realtime`);
      ws.onopen = () => {
        setConnected(true);
        delay = 1000;
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === 'pong') return;
        try {
          const e = JSON.parse(String(ev.data)) as RealtimeEvent;
          listeners.current.forEach((fn) => fn(e));
          if (e.type === 'message' || e.type === 'conversation') refreshUnread();
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        clearInterval(ping);
        if (!stopped) retry = setTimeout(connect, (delay = Math.min(delay * 2, 30_000)));
      };
    };
    connect();
    refreshUnread();
    return () => {
      stopped = true;
      clearInterval(ping);
      clearTimeout(retry);
      ws?.close();
    };
  }, [user, refreshUnread]);

  const value = useMemo<RealtimeState>(
    () => ({
      subscribe: (fn) => {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
      connected,
      unread,
      refreshUnread,
    }),
    [connected, unread, refreshUnread],
  );
  return <RealtimeCtx.Provider value={value}>{children}</RealtimeCtx.Provider>;
}

export function useRealtime(): RealtimeState {
  const v = useContext(RealtimeCtx);
  if (!v) throw new Error('useRealtime outside RealtimeProvider');
  return v;
}
