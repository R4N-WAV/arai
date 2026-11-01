import { z } from 'zod';
import { b64 } from './encoding';
import { entityId } from './tracks';

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
