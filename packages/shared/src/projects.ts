import { z } from 'zod';
import { b64 } from './encoding';

export const ROLES = ['listener', 'editor', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];
export const roleRank = (r: Role) => ROLES.indexOf(r);

export const projectId = z.string().regex(/^[a-z2-7]{26}$/, 'invalid_id');
export const visibility = z.enum(['private', 'public']);

/** Plaintext metadata, only ever sent when the owner publishes the project. */
export const publicMeta = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  genre: z.string().max(60).default(''),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  /** Cover colour, shown on public profiles. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type PublicMeta = z.infer<typeof publicMeta>;

/** What lives inside enc_meta (validated client-side after decryption). */
export interface ProjectMeta extends Omit<PublicMeta, 'color'> {
  /** Cover colour (hex). Drives the ambient background. */
  color: string;
}

const encMeta = b64(41, 16 * 1024);
const grant = z.object({ wrappedKey: b64(80), signature: b64(64) });

export const createProjectRequest = z
  .object({ id: projectId, visibility, encMeta, grant, publicMeta: publicMeta.optional() })
  .refine((v) => (v.visibility === 'public') === (v.publicMeta !== undefined), 'public_meta_mismatch');

export const updateProjectRequest = z
  .object({ encMeta: encMeta.optional(), visibility: visibility.optional(), publicMeta: publicMeta.nullable().optional() })
  .refine((v) => v.encMeta !== undefined || v.visibility !== undefined || v.publicMeta !== undefined, 'empty_update')
  .refine((v) => v.visibility === undefined || (v.visibility === 'public') === (v.publicMeta !== null && v.publicMeta !== undefined), 'public_meta_mismatch');

export interface ProjectDto {
  id: string;
  role: Role;
  visibility: 'private' | 'public';
  keyVersion: number;
  encMeta: string;
  publicMeta: PublicMeta | null;
  /** Every key version this member holds (keyring), newest last. */
  grants: Array<{ keyVersion: number; wrappedKey: string; signature: string; grantedBy: string; granterSignKey: string }>;
  /** A member was removed and the key has not been rotated yet (admins rotate). */
  rotationDue: boolean;
  /** Set while this is an invitation that has not been accepted. */
  invitedBy?: string;
  createdAt: number;
  updatedAt: number;
}
