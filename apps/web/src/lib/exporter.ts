/**
 * "Download my data": everything readable to you, decrypted here in the
 * browser and saved as one JSON file. Audio is not included (use "Download
 * original" on a track); the file lists every version so nothing is missed.
 */
import type { ConversationDto, ProfileDto } from '@arai/shared';
import type { AccountKeys } from '@arai/crypto';
import { api } from './api';
import { loadComments } from './collab';
import { decodeConversation, loadMessages } from './messages';
import type { Project } from './projects';
import { loadTracks } from './tracks';

export async function exportMyData(userId: string, keys: AccountKeys, projects: Project[], onStep?: (s: string) => void): Promise<Blob> {
  const out: Record<string, unknown> = { format: 'arai-export/1', exportedAt: new Date().toISOString() };
  onStep?.('Profile');
  out.profile = (await api<{ profile: ProfileDto }>('GET', '/account/profile')).profile;
  out.sessions = (await api<{ sessions: unknown[] }>('GET', '/account/sessions')).sessions;
  const ps = [];
  for (const p of projects) {
    onStep?.(`Project: ${p.meta?.name ?? p.id}`);
    const tracks = p.meta ? await loadTracks(p).catch(() => []) : [];
    ps.push({
      id: p.id,
      role: p.role,
      visibility: p.visibility,
      createdAt: new Date(p.createdAt).toISOString(),
      meta: p.meta,
      tracks: await Promise.all(
        tracks.map(async (t) => ({
          title: t.title,
          trims: t.trims,
          versions: await Promise.all(
            t.versions.map(async (v) => ({
              number: v.number,
              createdAt: new Date(v.createdAt).toISOString(),
              meta: v.meta ? { ...v.meta, peaks: undefined, rms: undefined } : null,
              comments: (await loadComments(p, v.id).catch(() => [])).map((c) => ({ author: c.author, at: c.body?.at ?? null, text: c.body?.text ?? null, resolved: c.resolved, createdAt: new Date(c.createdAt).toISOString() })),
            })),
          ),
        })),
      ),
    });
  }
  out.projects = ps;
  onStep?.('Messages');
  const { conversations } = await api<{ conversations: ConversationDto[] }>('GET', '/conversations');
  const convs = [];
  for (const dto of conversations) {
    const c = await decodeConversation(dto, keys, userId);
    const msgs = [];
    let before: number | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await loadMessages(c, before);
      msgs.unshift(...r.messages);
      if (!r.more || !r.messages.length) break;
      before = r.messages[0]!.createdAt;
    }
    const names = Object.fromEntries(c.members.map((m) => [m.id, m.username]));
    convs.push({ kind: c.kind, name: c.name, members: c.members.map((m) => m.username), messages: msgs.map((m) => ({ from: names[m.senderId] ?? m.senderId, at: new Date(m.createdAt).toISOString(), text: m.body?.text ?? null, attachments: m.body?.attachments?.map((a) => a.name) ?? [] })) });
  }
  out.conversations = convs;
  return new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
}
