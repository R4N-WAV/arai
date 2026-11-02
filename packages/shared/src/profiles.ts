import { z } from 'zod';
import type { PublicMeta } from './projects';

export const IMAGE_LIMITS = { avatar: { bytes: 300 * 1024, px: 512 }, banner: { bytes: 900 * 1024, px: 1800 } } as const;
export type ImageKind = keyof typeof IMAGE_LIMITS;

const httpsUrl = z
  .string()
  .trim()
  .max(300)
  .refine((u) => {
    try {
      const x = new URL(u);
      return x.protocol === 'https:' && !!x.hostname && !x.username && !x.password;
    } catch {
      return false;
    }
  }, 'invalid_url');

export const profileLink = z.object({ url: httpsUrl, label: z.string().trim().max(40).default('') });

export const updateProfileRequest = z.object({
  displayName: z.string().trim().max(60),
  bio: z.string().trim().max(600),
  location: z.string().trim().max(80),
  links: z.array(profileLink).max(8),
});
export type ProfileInput = z.infer<typeof updateProfileRequest>;

export interface PublicProjectDto {
  id: string;
  publicMeta: PublicMeta;
  publishedAt: number;
  /** Has a public listening link (audio playable by anyone). */
  listenable?: boolean;
  /** Public artwork version (GET /public/projects/:id/art?v=…), null when none. */
  art?: number | null;
}

export interface ProfileDto {
  username: string;
  displayName: string;
  bio: string;
  location: string;
  links: { url: string; label: string }[];
  avatar: number | null; // version (updated_at) or null
  banner: number | null;
  joinedAt: number;
  projects: PublicProjectDto[];
}

/** Recognised services, for labels and ordering on profiles. */
export function linkService(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Link';
  }
  const map: [RegExp, string][] = [
    [/(^|\.)spotify\.com$/, 'Spotify'],
    [/(^|\.)soundcloud\.com$/, 'SoundCloud'],
    [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
    [/(^|\.)music\.apple\.com$/, 'Apple Music'],
    [/(^|\.)bandcamp\.com$/, 'Bandcamp'],
    [/(^|\.)instagram\.com$/, 'Instagram'],
    [/(^|\.)tiktok\.com$/, 'TikTok'],
    [/(^|\.)(x\.com|twitter\.com)$/, 'X'],
  ];
  return map.find(([re]) => re.test(host))?.[1] ?? host;
}
