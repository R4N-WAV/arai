import type { RealtimeEvent } from '@arai/shared';
import type { Context } from 'hono';
import type { AppBindings, Env } from '../env.js';

/** Sends a realtime event to every open tab of the given users. Never throws. */
export async function pushEvent(env: Env, userIds: string[], event: RealtimeEvent): Promise<void> {
  const body = JSON.stringify(event);
  await Promise.all([...new Set(userIds)].map((u) => env.HUB.get(env.HUB.idFromName(u)).push(body).catch(() => undefined)));
}

type ProjectEvent = Extract<RealtimeEvent, { type: 'project' }>;

/**
 * Tells everyone in a project (accepted or still invited, plus `extra`, e.g.
 * someone who was just removed) that it changed, after the response is sent.
 * Without this, open tabs only learn about invitations, new tracks or a
 * rotated key when they are reloaded.
 */
export function announceProject(c: Context<any>, projectId: string, what: ProjectEvent['what'], extra: string[] = [], versionId?: string): void {
  const ctx = c as unknown as Context<AppBindings>;
  const job = (async () => {
    const { results } = await ctx.env.DB.prepare('SELECT user_id FROM project_members WHERE project_id = ? AND revoked_at IS NULL LIMIT 500').bind(projectId).all<{ user_id: string }>();
    await pushEvent(ctx.env, [...results.map((r) => r.user_id), ...extra], { type: 'project', projectId, what, ...(versionId ? { versionId } : {}) });
  })().catch(() => undefined);
  try {
    ctx.executionCtx.waitUntil(job);
  } catch {
    /* no execution context (some tests): the job still runs */
  }
}
