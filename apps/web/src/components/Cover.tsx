import { inkFor } from './ProjectForm';

/**
 * Typographic cover used until artwork uploads exist: the project's colour as
 * a flat printed sleeve with grain, its name set small in the corner.
 */
export function Cover({ name, color, size = 'grid' }: { name: string; color: string; size?: 'grid' | 'hero' | 'thumb' }) {
  return (
    <div className={`cover cover-${size}`} style={{ background: color, color: inkFor(color) }} aria-hidden="true">
      {size !== 'thumb' && <span className="cover-title">{name}</span>}
    </div>
  );
}
