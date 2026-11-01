import { z } from 'zod';
import { b64 } from './encoding';

/** Must match @arai/crypto chunks.ts. */
export const CHUNK_SIZE = 1024 * 1024;
export const CHUNK_OVERHEAD = 40;
export const MAX_FILE_BYTES = 250 * 1024 * 1024;

export const entityId = z.string().regex(/^[a-z2-7]{26}$/, 'invalid_id');
const encMeta = b64(41, 16 * 1024);

/** Layout check shared by client and server: sizes must match the chunk format exactly. */
export function validChunkLayout(encSize: number, chunkCount: number): boolean {
  if (!Number.isInteger(encSize) || !Number.isInteger(chunkCount) || chunkCount < 1) return false;
  const full = CHUNK_SIZE + CHUNK_OVERHEAD;
  const last = encSize - (chunkCount - 1) * full;
  return last >= CHUNK_OVERHEAD && last <= full;
}

export function expectedChunkSize(encSize: number, chunkCount: number, idx: number): number {
  const full = CHUNK_SIZE + CHUNK_OVERHEAD;
  return idx < chunkCount - 1 ? full : encSize - (chunkCount - 1) * full;
}

export const createFileRequest = z
  .object({
    id: entityId,
    kind: z.literal('audio'),
    encSize: z.number().int().positive().max(MAX_FILE_BYTES + 300 * CHUNK_OVERHEAD),
    chunkCount: z.number().int().positive().max(300),
    encFileKey: b64(41, 200),
    keyVersion: z.number().int().positive(),
  })
  .refine((v) => validChunkLayout(v.encSize, v.chunkCount), 'invalid_layout');

const versionInput = z.object({ id: entityId, fileId: entityId, encMeta });
export const createTrackRequest = z.object({ id: entityId, encMeta, version: versionInput });
export const addVersionRequest = versionInput;
export const updateTrackRequest = z
  .object({ encMeta: encMeta.optional(), currentVersionId: entityId.optional(), position: z.number().finite().optional() })
  .refine((v) => v.encMeta !== undefined || v.currentVersionId !== undefined || v.position !== undefined, 'empty_update');

export interface TrackVersionDto {
  id: string;
  number: number;
  encMeta: string;
  createdBy: string;
  createdAt: number;
  file: { id: string; encSize: number; chunkCount: number; encFileKey: string; keyVersion: number };
}
export interface TrackDto {
  id: string;
  encMeta: string;
  position: number;
  currentVersionId: string | null;
  createdAt: number;
  updatedAt: number;
  versions: TrackVersionDto[];
}
