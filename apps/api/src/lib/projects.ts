import { roleRank, type Role } from '@arai/shared';

export interface Membership {
  role: Role;
  owner_id: string;
}

/**
 * The single authorization check for project resources. Returns the caller's
 * membership if they hold at least `min`, else null. Callers answer 404 (not
 * 403) on null so project existence never leaks to outsiders.
 */
export async function requireProjectRole(db: D1Database, projectId: string, userId: string, min: Role): Promise<Membership | null> {
  const m = await db
    .prepare(
      `SELECT m.role, p.owner_id FROM project_members m JOIN projects p ON p.id = m.project_id
        WHERE m.project_id = ? AND m.user_id = ? AND m.revoked_at IS NULL AND m.accepted_at IS NOT NULL AND p.deleted_at IS NULL`,
    )
    .bind(projectId, userId)
    .first<Membership>();
  if (!m || roleRank(m.role) < roleRank(min)) return null;
  return m;
}
