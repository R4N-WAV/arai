import { z } from 'zod';

/** Base64url (no padding) of exactly `bytes` bytes, or a range. */
export const b64 = (min: number, max = min) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'invalid_base64url')
    .refine((s) => {
      const n = Math.floor((s.length * 3) / 4);
      return n >= min && n <= max;
    }, 'invalid_length');

