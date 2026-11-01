import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { errorMessage } from '../lib/api';
import { formatTime } from '../lib/audio';
import { addComment, deleteComment, editComment, loadComments, resolveComment, type Comment } from '../lib/collab';
import type { Project } from '../lib/projects';
import { useSession } from '../lib/session';
import type { TrackVersion, WaveData } from '../lib/tracks';
import { Notice } from './Unavailable';
import { Waveform } from './Waveform';

const when = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export interface CommentsApi {
  load: () => Promise<Comment[]>;
  add: (text: string, at: number | null, parentId: string | null, name?: string) => Promise<Comment>;
  edit?: (c: Comment, text: string) => Promise<Comment>;
  resolve?: (c: Comment, v: boolean) => Promise<void>;
  remove?: (c: Comment) => Promise<void>;
  canResolve: (c: Comment) => boolean;
  canEdit: (c: Comment) => boolean;
  canDelete: (c: Comment) => boolean;
  guestName?: boolean;
}

/** Member comments on one version of a track. */
export function VersionComments(props: {
  project: Project;
  version: TrackVersion;
  wave: WaveData | null;
  active: boolean;
  time: number;
  duration: number;
  onSeek?: (t: number) => void;
  onJump: (t: number) => void;
  title: string;
}) {
  const { project: p } = props;
  const { user } = useSession();
  const canModerate = p.role === 'admin' || p.role === 'owner';
  const canResolveAll = p.role !== 'listener';
  const api: CommentsApi = useMemo(
    () => ({
      load: () => loadComments(p, props.version.id),
      add: (text, at, parentId) => addComment(p, props.version.id, { text, at }, parentId),
      edit: (c, text) => editComment(p, c, text),
      resolve: (c, v) => resolveComment(c, v),
      remove: (c) => deleteComment(c).then(() => undefined),
      canResolve: (c) => canResolveAll || c.authorId === user?.id,
      canEdit: (c) => c.authorId === user?.id && !c.guest,
      canDelete: (c) => canModerate || c.authorId === user?.id,
    }),
    [p, props.version.id, user?.id, canModerate, canResolveAll],
  );
  return <CommentThread {...props} api={api} />;
}

export function CommentThread({
  api,
  wave,
  active,
  time,
  duration,
  onSeek,
  onJump,
  title,
  version,
}: {
  api: CommentsApi;
  wave: WaveData | null;
  active: boolean;
  time: number;
  duration: number;
  onSeek?: (t: number) => void;
  onJump: (t: number) => void;
  title: string;
  version: { id: string; meta: { duration: number | null } | null };
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState(true);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const total = duration || version.meta?.duration || 0;

  const refresh = useCallback(async () => {
    try {
      setComments(await api.load());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const top = (comments ?? []).filter((c) => !c.parentId && (showResolved || !c.resolved) && !(c.deleted && !(comments ?? []).some((r) => r.parentId === c.id)));
  top.sort((a, b) => (a.body?.at ?? Infinity) - (b.body?.at ?? Infinity) || a.createdAt - b.createdAt);
  const resolvedCount = (comments ?? []).filter((c) => !c.parentId && c.resolved).length;
  const markers = top.flatMap((c) => (c.body?.at != null && total > 0 ? [{ id: c.id, ratio: c.body.at / total }] : []));
  const at = active ? time : 0;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const post = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    void run(async () => {
      await api.add(t, pin && active ? Math.round(at * 10) / 10 : null, null, name.trim() || undefined);
      setText('');
    });
  };

  const one = (c: Comment, reply = false) => (
    <article key={c.id} className={`comment${reply ? ' reply' : ''}${c.resolved ? ' resolved' : ''}`}>
      <header className="comment-head">
        <span className="comment-author">{c.author}{c.guest && <span className="tag">guest</span>}</span>
        {c.body?.at != null && (
          <button type="button" className="time-chip mono" onClick={() => onJump(c.body!.at!)} aria-label={`Play from ${formatTime(c.body.at)}`}>
            {formatTime(c.body.at)}
          </button>
        )}
        <span className="row-sub">{when(c.createdAt)}{c.editedAt && ' · edited'}{c.resolved && ' · resolved'}</span>
      </header>
      {editing === c.id ? (
        <form
          className="comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!api.edit || !editText.trim()) return;
            void run(async () => {
              await api.edit!(c, editText.trim());
              setEditing(null);
            });
          }}
        >
          <label className="visually-hidden" htmlFor={`edit-${c.id}`}>Edit comment</label>
          <textarea id={`edit-${c.id}`} value={editText} onChange={(e) => setEditText(e.target.value)} maxLength={2000} rows={2} />
          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Save</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <p className="comment-text">{c.deleted ? <span className="muted">Comment deleted.</span> : c.body ? c.body.text : <span className="muted">This comment could not be decrypted.</span>}</p>
      )}
      {!c.deleted && editing !== c.id && (
        <div className="comment-actions">
          {!reply && <button type="button" className="link-btn" onClick={() => (setReplyTo(replyTo === c.id ? null : c.id), setReplyText(''))}>Reply</button>}
          {!reply && api.resolve && api.canResolve(c) && (
            <button type="button" className="link-btn" disabled={busy} onClick={() => void run(() => api.resolve!(c, !c.resolved))}>{c.resolved ? 'Reopen' : 'Resolve'}</button>
          )}
          {api.edit && api.canEdit(c) && c.body && <button type="button" className="link-btn" onClick={() => (setEditing(c.id), setEditText(c.body!.text))}>Edit</button>}
          {api.remove && api.canDelete(c) && <button type="button" className="link-btn danger" disabled={busy} onClick={() => void run(() => api.remove!(c))}>Delete</button>}
        </div>
      )}
    </article>
  );

  return (
    <section className="comments" aria-label={`Comments on ${title}`}>
      <Waveform data={wave} current={active ? time : 0} duration={active ? duration : 0} onSeek={active ? onSeek : undefined} className="waveform waveform-detail" label={`Waveform of ${title}`} markers={markers} />
      {error && <Notice kind="error">{error}</Notice>}
      <form className="comment-form" onSubmit={post}>
        {api.guestName && (
          <>
            <label className="visually-hidden" htmlFor={`name-${version.id}`}>Your name</label>
            <input id={`name-${version.id}`} className="input" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </>
        )}
        <label className="visually-hidden" htmlFor={`c-${version.id}`}>Add a comment</label>
        <textarea id={`c-${version.id}`} placeholder={active ? `Comment at ${formatTime(at)}…` : 'Add a comment…'} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} rows={2} />
        <div className="form-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>Comment</button>
          {active && (
            <label className="check">
              <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> at {formatTime(at)}
            </label>
          )}
          {resolvedCount > 0 && (
            <button type="button" className="link-btn" onClick={() => setShowResolved(!showResolved)}>
              {showResolved ? 'Hide resolved' : `Show ${resolvedCount} resolved`}
            </button>
          )}
        </div>
      </form>
      {comments === null ? (
        <p className="muted" role="status">Loading comments…</p>
      ) : top.length === 0 ? (
        <p className="voice comment-empty">No comments yet. Play the track and leave a note at the moment you mean.</p>
      ) : (
        <div className="comment-list">
          {top.map((c) => (
            <div key={c.id} className="thread">
              {one(c)}
              {(comments ?? []).filter((r) => r.parentId === c.id && !r.deleted).map((r) => one(r, true))}
              {replyTo === c.id && (
                <form
                  className="comment-form reply"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const t = replyText.trim();
                    if (!t) return;
                    void run(async () => {
                      await api.add(t, null, c.id, name.trim() || undefined);
                      setReplyTo(null);
                    });
                  }}
                >
                  <label className="visually-hidden" htmlFor={`r-${c.id}`}>Reply to {c.author}</label>
                  <textarea id={`r-${c.id}`} value={replyText} onChange={(e) => setReplyText(e.target.value)} maxLength={2000} rows={2} autoFocus />
                  <div className="form-actions">
                    <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !replyText.trim()}>Reply</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplyTo(null)}>Cancel</button>
                  </div>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
