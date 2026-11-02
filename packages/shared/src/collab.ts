import { z } from 'zod';
import { b64 } from './encoding';
import { entityId, validChunkLayout } from './tracks';

export const memberRole = z.enum(['listener', 'editor', 'admin']);

const keyGrant = z.object({ keyVersion: z.number().int().positive(), wrappedKey: b64(80), signature: b64(64) });
const memberGrant = z.object({ userId: z.string().min(1).max(64), wrappedKey: b64(80), signature: b64(64) });

/** Invite: grants for every key version 1..current, sealed to the invitee. */
export const inviteRequest = z.object({ userId: z.string().min(1).max(64), role: memberRole, grants: z.array(keyGrant).min(1).max(1000) });
export const roleRequest = z.object({ role: memberRole });
/** Rotation: a new key version granted to every remaining member. */
export const rotateRequest = z.object({ keyVersion: z.number().int().min(2), encMeta: b64(41, 16 * 1024), grants: z.array(memberGrant).min(1).max(500) });

export interface UserKeysDto {
  id: string;
  username: string;
  displayName: string;
  boxKey: string;
  signKey: string;
}
export interface MemberDto extends UserKeysDto {
  role: 'listener' | 'editor' | 'admin' | 'owner';
  pending: boolean;
  createdAt: number;
}

// ---- comments ---------------------------------------------------------------

const encBody = b64(41, 8 * 1024);
export const createCommentRequest = z.object({ id: entityId, parentId: entityId.nullable().optional(), keyVersion: z.number().int().positive(), encBody });
export const updateCommentRequest = z
  .object({ keyVersion: z.number().int().positive().optional(), encBody: encBody.optional(), resolved: z.boolean().optional() })
  .refine((v) => (v.encBody === undefined) === (v.keyVersion === undefined), 'key_version_required')
  .refine((v) => v.encBody !== undefined || v.resolved !== undefined, 'empty_update');

export interface CommentDto {
  id: string;
  versionId: string;
  parentId: string | null;
  authorId: string | null;
  authorName: string | null;
  linkId: string | null;
  keyVersion: number | null;
  encBody: string | null;
  resolved: boolean;
  createdAt: number;
  editedAt: number | null;
}
/** Plaintext inside enc_body. */
export interface CommentBody {
  text: string;
  /** Seconds into the version, or null for a general comment. */
  at: number | null;
  /** Guest comments only: the name the guest typed. */
  name?: string;
}

// ---- share links ------------------------------------------------------------

const encPayload = b64(41, 900 * 1024);
const fileRef = z.object({ fileId: entityId, versionId: entityId });
export const createShareRequest = z.object({
  id: entityId,
  trackId: entityId.nullable(),
  tokenHash: b64(32),
  hasPassword: z.boolean(),
  allowDownload: z.boolean(),
  allowComments: z.boolean(),
  expiresAt: z.number().int().positive().nullable(),
  encPayload,
  encSecret: b64(41, 1024),
  keyVersion: z.number().int().positive(),
  files: z.array(fileRef).max(1000),
  publicSecret: b64(32).optional(),
});
export const updateShareRequest = z.object({ encPayload, files: z.array(fileRef).max(1000) });
export const openShareRequest = z.object({ token: b64(32) });
export const guestCommentRequest = z.object({ token: b64(32), id: entityId, versionId: entityId, parentId: entityId.nullable().optional(), encBody });

export interface ShareDto {
  id: string;
  trackId: string | null;
  hasPassword: boolean;
  allowDownload: boolean;
  allowComments: boolean;
  isPublic: boolean;
  expiresAt: number | null;
  encSecret: string;
  keyVersion: number;
  createdAt: number;
}
/** Decrypted share payload. */
export interface SharePayload {
  project: { name: string; color: string; description: string };
  tracks: Array<{
    title: string;
    versionId: string;
    versionNumber: number;
    file: { id: string; encSize: number; chunkCount: number };
    fileKey: string;
    meta: unknown;
  }>;
}

// ---- social -------------------------------------------------------------------

export const reportRequest = z.object({
  targetType: z.enum(['user', 'project', 'comment', 'message']),
  targetId: z.string().min(1).max(64),
  reason: z.enum(['spam', 'harassment', 'hate', 'sexual', 'violence', 'copyright', 'impersonation', 'other']),
  details: z.string().max(2000).default(''),
  evidence: z.string().max(4000).optional(),
});

export interface PersonDto {
  id: string;
  username: string;
  displayName: string;
  avatar: number | null;
}
export interface NotificationDto {
  id: string;
  kind: 'invite' | 'comment' | 'follow' | 'friend_request' | 'friend_accept' | 'message' | 'moderation';
  actor: string | null;
  targetId: string | null;
  createdAt: number;
  read: boolean;
}
export interface DiscoverProjectDto {
  id: string;
  publicMeta: { name: string; description: string; genre: string; tags: string[]; color?: string };
  publishedAt: number;
  owner: string;
  listenable: boolean;
}

// ---- messaging ----------------------------------------------------------------

export const REACTIONS = ['like', 'love', 'laugh', 'wow', 'sad', 'fire'] as const;
export type Reaction = (typeof REACTIONS)[number];
const memberGrantC = z.object({ userId: z.string().min(1).max(64), wrappedKey: b64(80), signature: b64(64) });
export const createConversationRequest = z.object({
  id: entityId,
  kind: z.enum(['dm', 'group']),
  userIds: z.array(z.string().min(1).max(64)).min(1).max(31),
  grants: z.array(memberGrantC).min(2).max(32),
  encMeta: b64(41, 4096).optional(),
});
export const sendMessageRequest = z.object({ id: entityId, keyVersion: z.number().int().positive(), encBody: b64(41, 48 * 1024), replyTo: entityId.nullable().optional() });
export const editMessageRequest = z.object({ keyVersion: z.number().int().positive(), encBody: b64(41, 48 * 1024) });
export const addConversationMemberRequest = z.object({ userId: z.string().min(1).max(64), grants: z.array(z.object({ keyVersion: z.number().int().positive(), wrappedKey: b64(80), signature: b64(64) })).min(1).max(1000) });
export const rotateConversationRequest = z.object({ keyVersion: z.number().int().min(2), encMeta: b64(41, 4096).nullable(), grants: z.array(memberGrantC).min(1).max(32) });
export const convFileRequest = z
  .object({ id: entityId, encSize: z.number().int().positive().max(25 * 1024 * 1024 + 25 * 40), chunkCount: z.number().int().positive().max(25) })
  .refine((v) => validChunkLayout(v.encSize, v.chunkCount), 'invalid_layout');

export interface ConversationDto {
  id: string;
  kind: 'dm' | 'group' | 'project';
  projectId: string | null;
  keyVersion: number;
  encMeta: string | null;
  grants: Array<{ keyVersion: number; wrappedKey: string; signature: string; grantedBy: string; granterSignKey: string }>;
  members: Array<PersonDto & { status: 'active' | 'request' | 'left'; role: 'member' | 'admin'; lastReadAt: number; boxKey: string }>;
  myStatus: 'active' | 'request';
  myRole: 'member' | 'admin';
  rotationDue: boolean;
  unread: number;
  lastMessageAt: number | null;
  last: MessageDto | null;
}
export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  keyVersion: number;
  encBody: string | null;
  replyTo: string | null;
  createdAt: number;
  editedAt: number | null;
  reactions: Array<{ reaction: Reaction; userIds: string[] }>;
}
/** Plaintext inside a message's enc_body. */
export interface MessageBody {
  text: string;
  attachments?: Array<{ fileId: string; key: string; name: string; mime: string; size: number; encSize: number; chunkCount: number }>;
  gif?: { url: string; width: number; height: number };
}
export type RealtimeEvent =
  | { type: 'message'; conversationId: string; message: MessageDto }
  | { type: 'edit' | 'delete' | 'react'; conversationId: string; message: MessageDto }
  | { type: 'typing'; conversationId: string; userId: string }
  | { type: 'read'; conversationId: string; userId: string; at: number }
  | { type: 'conversation'; conversationId: string };
