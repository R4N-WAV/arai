import { useArt } from '../lib/art';
import type { Project } from '../lib/projects';
import { inkFor } from './ProjectForm';

/**
 * A project's cover: its artwork when there is some, otherwise the project's
 * colour as a flat printed sleeve with its name set small in the corner.
 */
export function Cover({ name, color, size = 'grid', art = null }: { name: string; color: string; size?: 'grid' | 'hero' | 'thumb'; art?: string | null }) {
  return (
    <div className={`cover cover-${size}${art ? ' has-art' : ''}`} style={{ background: color, color: inkFor(color) }} aria-hidden="true">
      {art ? <img src={art} alt="" decoding="async" draggable={false} /> : size !== 'thumb' && <span className="cover-title">{name}</span>}
    </div>
  );
}

/** Cover for a project you are a member of (decrypts its artwork). */
export function ProjectCover({ p, size = 'grid' }: { p: Pick<Project, 'id' | 'art' | 'meta'>; size?: 'grid' | 'hero' | 'thumb' }) {
  const art = useArt(p);
  if (!p.meta) return <div className={`cover cover-${size} cover-locked`} aria-hidden="true" />;
  return <Cover name={p.meta.name} color={p.meta.color} size={size} art={art} />;
}
