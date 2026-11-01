import type { ProjectMeta } from '@arai/shared';
import { useId, useState, type FormEvent } from 'react';
import { Field } from './Field';

/** Curated cover colours; each gives a distinct, calm glow. A custom colour is always allowed. */
export const COLOURS = [
  { hex: '#c2412d', name: 'Brick' },
  { hex: '#d9a441', name: 'Ochre' },
  { hex: '#5e7d3a', name: 'Moss' },
  { hex: '#2f7f6f', name: 'Teal' },
  { hex: '#3f5ba9', name: 'Indigo' },
  { hex: '#6b3fa0', name: 'Violet' },
  { hex: '#b8506e', name: 'Rose' },
  { hex: '#8a8f98', name: 'Slate' },
];

export interface ProjectFormValues {
  meta: ProjectMeta;
  visibility: 'private' | 'public';
}

export function ProjectForm({
  initial,
  submitLabel,
  busyLabel,
  showVisibility,
  onSubmit,
  onCancel,
}: {
  initial?: ProjectFormValues;
  submitLabel: string;
  busyLabel: string;
  showVisibility: boolean;
  onSubmit: (v: ProjectFormValues) => Promise<void>;
  onCancel?: () => void;
}) {
  const ids = useId();
  const [name, setName] = useState(initial?.meta.name ?? '');
  const [description, setDescription] = useState(initial?.meta.description ?? '');
  const [genre, setGenre] = useState(initial?.meta.genre ?? '');
  const [tags, setTags] = useState((initial?.meta.tags ?? []).join(', '));
  const [color, setColor] = useState(initial?.meta.color ?? COLOURS[Math.floor(Math.random() * COLOURS.length)]!.hex);
  const [visibility, setVisibility] = useState<'private' | 'public'>(initial?.visibility ?? 'private');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameError = touched && !name.trim() ? 'Give your project a name.' : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSubmit({
        meta: {
          name: name.trim().slice(0, 120),
          description: description.trim().slice(0, 2000),
          genre: genre.trim().slice(0, 60),
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10).map((t) => t.slice(0, 30)),
          color,
        },
        visibility,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="project-form">
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} error={nameError} maxLength={120} required autoFocus={!initial} />
      <div className="field">
        <label htmlFor={`${ids}-desc`}>Description</label>
        <textarea id={`${ids}-desc`} className="input textarea" rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field-pair">
        <Field label="Genre" hint="Optional." value={genre} onChange={(e) => setGenre(e.target.value)} maxLength={60} />
        <Field label="Tags" hint="Optional. Separate with commas." value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>

      <fieldset className="field fieldset">
        <legend>Colour</legend>
        <p className="hint">Until you add artwork, this colour fills your space when the project is in it.</p>
        <div className="swatches">
          {COLOURS.map((c) => (
            <label key={c.hex} className="swatch" style={{ background: c.hex }}>
              <input type="radio" name={`${ids}-colour`} value={c.hex} checked={color === c.hex} onChange={() => setColor(c.hex)} />
              <span className="visually-hidden">{c.name}</span>
            </label>
          ))}
          <label className="swatch swatch-custom" style={{ background: COLOURS.some((c) => c.hex === color) ? undefined : color }}>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value.toLowerCase())} />
            <span className="visually-hidden">Custom colour</span>
          </label>
        </div>
      </fieldset>

      {showVisibility && (
        <fieldset className="field fieldset">
          <legend>Who can see it</legend>
          <label className="choice">
            <input type="radio" name={`${ids}-vis`} checked={visibility === 'private'} onChange={() => setVisibility('private')} />
            <span>
              <strong>Private</strong>
              <span className="row-sub">Only you and people you invite. Encrypted so that not even Arai can read it.</span>
            </span>
          </label>
          <label className="choice">
            <input type="radio" name={`${ids}-vis`} checked={visibility === 'public'} onChange={() => setVisibility('public')} />
            <span>
              <strong>Public</strong>
              <span className="row-sub">Anyone can find it and see its name, description, genre and tags.</span>
            </span>
          </label>
          {visibility === 'public' && (
            <p className="alert alert-warn" role="status">
              Public details are stored unencrypted so others can see them. You can make the project private again at any time, but people may already have seen them.
            </p>
          )}
        </fieldset>
      )}

      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? busyLabel : submitLabel}
        </button>
        {onCancel && (
          <button className="btn btn-ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Ink colour that reads on a given cover colour. */
export function inkFor(hex: string): string {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? '#141216' : '#f6f3ee';
}
