import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../lib/api';
import { createShare, listShares, revokeShare, type Share } from '../lib/collab';
import type { Project } from '../lib/projects';
import type { Track } from '../lib/tracks';
import { Modal } from './Modal';
import { Notice } from './Unavailable';

const EXPIRY = [
  { label: 'Never', days: null },
  { label: '1 day', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
] as const;

export function ShareDialog({ p, tracks, open, onClose, trackId = null }: { p: Project; tracks: Track[]; open: boolean; onClose: () => void; trackId?: string | null }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [scope, setScope] = useState<string>('all');
  const [password, setPassword] = useState('');
  const [expiry, setExpiry] = useState(0);
  const [download, setDownload] = useState(false);
  const [comments, setComments] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Share | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const pRef = useRef(p);
  pRef.current = p;
  const load = useCallback(async () => {
    try {
      setShares(await listShares(pRef.current));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    if (open) {
      setError(null);
      setCreated(null);
      setPassword('');
      setScope(trackId ?? 'all');
      void load();
    }
  }, [open, load, trackId, p.id]);

  const copy = async (s: Share) => {
    if (!s.url) return;
    try {
      await navigator.clipboard.writeText(s.url);
      setCopied(s.id);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setError('Copying is blocked here; select the link and copy it yourself.');
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await createShare(p, tracks, { trackId: scope === 'all' ? null : scope, password, expiresInDays: EXPIRY[expiry]!.days, allowDownload: download, allowComments: comments });
      setCreated(s);
      setPassword('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const describe = (s: Share) =>
    [
      s.isPublic ? 'Public listening (anyone)' : s.trackId ? tracks.find((t) => t.id === s.trackId)?.title ?? 'One track' : 'Whole project',
      s.hasPassword && 'password',
      s.expiresAt ? `expires ${new Date(s.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : null,
      s.allowDownload && 'download',
      s.allowComments && 'comments',
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <Modal open={open} onClose={onClose} title="Share">
      {error && <Notice kind="error">{error}</Notice>}
      {created?.url && (
        <div className="share-created" role="status">
          <p className="row-title">Link ready</p>
          <input className="input mono" readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
          <div className="form-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void copy(created)}>{copied === created.id ? 'Copied' : 'Copy link'}</button>
          </div>
          <p className="row-sub">The part after # is the key. It never reaches Arai’s servers, so only people with the full link can listen.</p>
        </div>
      )}
      <form className="share-form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">What to share</span>
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">The whole project (current versions)</option>
            {tracks.filter((t) => t.current).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Password (optional)</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={200} />
        </label>
        <label className="field">
          <span className="field-label">Expires</span>
          <select className="input" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
            {EXPIRY.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} /> Listeners can leave comments</label>
        <label className="check"><input type="checkbox" checked={download} onChange={(e) => setDownload(e.target.checked)} /> Show a download button</label>
        <p className="row-sub">Anyone who can play a track can also record it; turning downloads off only hides the button.</p>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || tracks.length === 0}>{busy ? 'Encrypting…' : 'Create link'}</button>
      </form>

      {shares && shares.length > 0 && (
        <section className="modal-section" aria-labelledby="links-h">
          <h3 id="links-h">Active links</h3>
          <ul className="list">
            {shares.map((s) => (
              <li key={s.id} className="share-row">
                <div className="row-main">
                  <div className="row-title">{describe(s)}</div>
                  <p className="row-sub">Created {new Date(s.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                </div>
                {s.url && <button type="button" className="btn btn-sm" onClick={() => void copy(s)}>{copied === s.id ? 'Copied' : 'Copy'}</button>}
                {!s.isPublic && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void revokeShare(p, s.id).then(load).catch((e) => setError(errorMessage(e)))}>
                    Turn off
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Modal>
  );
}
