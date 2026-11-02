import type { Capabilities, Reaction, RealtimeEvent } from '@arai/shared';
import { REACTIONS } from '@arai/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Menu } from '../components/Menu';
import { Modal } from '../components/Modal';
import { Avatar } from '../components/ProfileView';
import { ReportDialog } from '../components/ReportDialog';
import { Notice } from '../components/Unavailable';
import { api, errorMessage } from '../lib/api';
import { lookupUser } from '../lib/collab';
import {
  addToGroup,
  attachmentUrl,
  decodeConversation,
  decodeMessage,
  deleteMessage,
  editMessage,
  loadMessages,
  react,
  rotateGroup,
  sendMessage,
  startConversation,
  uploadAttachment,
  useRealtime,
  type Conversation,
  type Message,
} from '../lib/messages';
import { useProjects } from '../lib/projects';
import { useSession } from '../lib/session';

const time = (t: number) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

const REACTION_ICON: Record<Reaction, ReactElement> = {
  like: <path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2 3l-.5 3H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7" />,
  love: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  laugh: <><circle cx="12" cy="12" r="8" /><path d="M8 13a4 4 0 0 0 8 0zM9 9.5h.01M15 9.5h.01" /></>,
  wow: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="15" r="1.8" /><path d="M9 9.5h.01M15 9.5h.01" /></>,
  sad: <><circle cx="12" cy="12" r="8" /><path d="M8.5 16a4 4 0 0 1 7 0M9 10h.01M15 10h.01" /></>,
  fire: <path d="M12 21a6 6 0 0 0 6-6c0-4-3-5.5-3-9-2 1-3.5 3-3.5 5C10 10 9 9 9 7c-2 2-3 4.5-3 8a6 6 0 0 0 6 6z" />,
};
const ReactionIcon = ({ r }: { r: Reaction }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{REACTION_ICON[r]}</svg>
);
const REACTION_LABEL: Record<Reaction, string> = { like: 'Like', love: 'Love', laugh: 'Laugh', wow: 'Wow', sad: 'Sad', fire: 'Fire' };

function useConversationTitle() {
  const { projects } = useProjects();
  const { user } = useSession();
  return useCallback(
    (c: Conversation) => {
      if (c.kind === 'project') return projects?.find((p) => p.id === c.projectId)?.meta?.name ?? 'Project chat';
      if (c.name) return c.name;
      const others = c.members.filter((m) => m.id !== user?.id);
      return others.map((m) => m.displayName || m.username).join(', ') || 'Just you';
    },
    [projects, user?.id],
  );
}

function NewConversation({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { user, keys } = useSession();
  const [names, setNames] = useState('');
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) (setNames(''), setGroup(''), setError(null));
  }, [open]);
  const list = names.split(/[\s,]+/).map((n) => n.replace(/^@/, '')).filter(Boolean);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!keys || !user || list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const people = [];
      for (const n of list.slice(0, 31)) {
        try {
          people.push(await lookupUser(n));
        } catch {
          throw new Error(`No one called @${n} can be messaged.`);
        }
      }
      const c = await startConversation(keys, user.id, people.filter((p) => p.id !== user.id), list.length > 1 || group.trim() ? group.trim() || 'Group' : null);
      onCreated(c.id);
    } catch (err) {
      setError(err instanceof Error && !('status' in err) ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New message">
      <form className="share-form" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        <label className="field">
          <span className="field-label">To (usernames, separated by spaces)</span>
          <input className="input" value={names} onChange={(e) => setNames(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="username" />
        </label>
        {list.length > 1 && (
          <label className="field">
            <span className="field-label">Group name</span>
            <input className="input" value={group} onChange={(e) => setGroup(e.target.value)} maxLength={80} placeholder="Group" />
          </label>
        )}
        <p className="row-sub">Messages are end-to-end encrypted. People who are not your friends get a message request first.</p>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || list.length === 0}>{busy ? 'Encrypting…' : list.length > 1 ? 'Start group' : 'Start conversation'}</button>
      </form>
    </Modal>
  );
}

function Attachment({ a }: { a: NonNullable<NonNullable<Message['body']>['attachments']>[number] }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const isImage = /^image\/(png|jpeg|gif|webp)$/.test(a.mime);
  const isAudio = a.mime.startsWith('audio/');
  useEffect(() => {
    if (isImage || isAudio) attachmentUrl(a).then(setUrl).catch(() => setErr(true));
  }, [a, isImage, isAudio]);
  const size = a.size > 1048576 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.ceil(a.size / 1024)} KB`;
  if (err) return <p className="row-sub">{a.name} could not be decrypted.</p>;
  if (isImage) return url ? <img className="msg-image" src={url} alt={a.name} /> : <p className="row-sub">Decrypting {a.name}…</p>;
  return (
    <div className="msg-file">
      {isAudio && url && <audio controls src={url} preload="metadata" />}
      <button
        type="button"
        className="btn btn-sm"
        onClick={async () => {
          const u = await attachmentUrl(a);
          const link = document.createElement('a');
          link.href = u;
          link.download = a.name;
          link.click();
        }}
      >
        Download {a.name} <span className="row-sub">· {size}</span>
      </button>
    </div>
  );
}

function Thread({ c, onChanged }: { c: Conversation; onChanged: () => void }) {
  const { user, keys } = useSession();
  const realtime = useRealtime();
  const nav = useNavigate();
  const title = useConversationTitle()(c);
  const [items, setItems] = useState<Message[] | null>(null);
  const [more, setMore] = useState(false);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [report, setReport] = useState<Message | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const stick = useRef(true);
  const others = c.members.filter((m) => m.id !== user?.id);
  const nameOf = (id: string) => (id === user?.id ? 'You' : c.members.find((m) => m.id === id)?.displayName || c.members.find((m) => m.id === id)?.username || 'Someone');

  // Refreshed conversation objects (read receipts, unread counts) must not reload the thread.
  const cRef = useRef(c);
  cRef.current = c;
  const rtRef = useRef(realtime);
  rtRef.current = realtime;
  const load = useCallback(async () => {
    const cur = cRef.current;
    try {
      const r = await loadMessages(cur);
      setItems(r.messages);
      setMore(r.more);
      if (cur.myStatus === 'active') void api('POST', `/conversations/${cur.id}/read`).then(() => rtRef.current.refreshUnread());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    setItems(null);
    void load();
  }, [load, c.id, c.keyVersion, c.myStatus]);
  useEffect(() => {
    api<Capabilities>('GET', '/config').then(setCaps).catch(() => undefined);
  }, []);

  // Rotate the group key if someone left (admins only).
  useEffect(() => {
    if (c.kind === 'group' && c.rotationDue && c.myRole === 'admin' && keys && user) void rotateGroup(keys, user.id, c).then(onChanged).catch(() => undefined);
  }, [c, keys, user, onChanged]);

  useEffect(
    () =>
      realtime.subscribe(async (e: RealtimeEvent) => {
        if (e.conversationId !== c.id) return;
        if (e.type === 'typing') setTyping((t) => ({ ...t, [e.userId]: Date.now() }));
        else if (e.type === 'read' || e.type === 'conversation') onChanged();
        else {
          const m = await decodeMessage(c, e.message);
          setItems((prev) => {
            const cur = prev ?? [];
            const i = cur.findIndex((x) => x.id === m.id);
            return i >= 0 ? cur.map((x) => (x.id === m.id ? m : x)) : [...cur, m];
          });
          if (e.type === 'message') {
            setTyping((t) => ({ ...t, [e.message.senderId]: 0 }));
            if (e.message.senderId !== user?.id && document.visibilityState === 'visible') void api('POST', `/conversations/${c.id}/read`).then(() => realtime.refreshUnread());
          }
        }
      }),
    [realtime, c, onChanged, user?.id],
  );

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  // Typing indicators fade after a few seconds.
  useEffect(() => {
    const t = setInterval(() => setTyping((x) => Object.fromEntries(Object.entries(x).filter(([, at]) => Date.now() - at < 4000))), 1500);
    return () => clearInterval(t);
  }, []);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const m = await editMessage(c, editing, t);
        setItems((prev) => (prev ?? []).map((x) => (x.id === m.id ? m : x)));
        setEditing(null);
      } else {
        const m = await sendMessage(c, { text: t }, replyTo?.id ?? null);
        stick.current = true;
        setItems((prev) => ((prev ?? []).some((x) => x.id === m.id) ? prev : [...(prev ?? []), m]));
        setReplyTo(null);
      }
      setText('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const onType = (v: string) => {
    setText(v);
    if (v && Date.now() - lastTyping.current > 2500) {
      lastTyping.current = Date.now();
      void api('POST', `/conversations/${c.id}/typing`).catch(() => undefined);
    }
  };
  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    try {
      const atts = [];
      for (const f of Array.from(files).slice(0, 5)) atts.push(await uploadAttachment(c, f, setProgress));
      const m = await sendMessage(c, { text: text.trim(), attachments: atts }, replyTo?.id ?? null);
      setItems((prev) => [...(prev ?? []), m]);
      setText('');
      setReplyTo(null);
    } catch (err) {
      setError(err instanceof Error && err.message === 'attachment_too_large' ? 'Attachments can be up to 25 MB.' : errorMessage(err));
    } finally {
      setProgress(null);
      if (file.current) file.current.value = '';
    }
  };
  const toggleReaction = async (m: Message, r: Reaction) => {
    const on = !m.reactions.find((x) => x.reaction === r)?.userIds.includes(user?.id ?? '');
    const res = await react(m, r, on).catch(() => null);
    if (res) {
      const next = await decodeMessage(c, res.message);
      setItems((prev) => (prev ?? []).map((x) => (x.id === next.id ? next : x)));
    }
  };

  const typingNames = Object.entries(typing).filter(([id, at]) => at && id !== user?.id && Date.now() - at < 4000).map(([id]) => nameOf(id));
  const dmOther = c.kind === 'dm' ? others[0] : null;
  const myLast = [...(items ?? [])].reverse().find((m) => m.senderId === user?.id);
  const seen = dmOther && myLast && dmOther.lastReadAt >= myLast.createdAt;

  return (
    <section className="thread-pane" aria-label={`Conversation: ${title}`}>
      <header className="thread-head">
        <Link to="/messages" className="btn btn-ghost btn-sm thread-back" aria-label="All conversations">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 5-7 7 7 7" /></svg>
        </Link>
        <div className="row-main">
          <h2 className="thread-title">{c.kind === 'project' ? <Link to={`/projects/${c.projectId}`}>{title}</Link> : dmOther ? <Link to={`/u/${dmOther.username}`}>{title}</Link> : title}</h2>
          <p className="row-sub">{c.kind === 'project' ? 'Project chat' : c.kind === 'group' ? `${c.members.length} people` : `@${dmOther?.username ?? ''}`} · end-to-end encrypted</p>
        </div>
        {c.kind !== 'project' && (
          <Menu
            label="Conversation options"
            items={[
              ...(c.kind === 'group' && c.myRole === 'admin' ? [{ label: 'Add someone…', onSelect: () => setAddOpen(true) }] : []),
              { label: c.kind === 'group' ? 'Leave group' : 'Hide conversation', onSelect: () => void api('DELETE', `/conversations/${c.id}/members/me`).then(() => (onChanged(), nav('/messages'))), danger: c.kind === 'group' },
              ...(dmOther ? [{ label: `Block @${dmOther.username}`, onSelect: () => void api('POST', `/social/${dmOther.username}/block`).then(() => (onChanged(), nav('/messages'))), danger: true }] : []),
            ]}
          />
        )}
      </header>

      {c.myStatus === 'request' && (
        <div className="request-banner">
          <p>{title} wants to message you. They will not know you saw this unless you accept.</p>
          <span className="form-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void api('POST', `/conversations/${c.id}/accept`).then(onChanged)}>Accept</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void api('DELETE', `/conversations/${c.id}/members/me`).then(() => (onChanged(), nav('/messages')))}>Decline</button>
            {dmOther && <button type="button" className="btn btn-danger btn-sm" onClick={() => void api('POST', `/social/${dmOther.username}/block`).then(() => (onChanged(), nav('/messages')))}>Block</button>}
          </span>
        </div>
      )}

      <div
        className="msg-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        aria-live="polite"
        aria-relevant="additions"
      >
        {more && items && (
          <button type="button" className="btn btn-ghost btn-sm msg-more" onClick={async () => { stick.current = false; const r = await loadMessages(c, items[0]?.createdAt); setItems([...r.messages, ...items]); setMore(r.more); }}>
            Earlier messages
          </button>
        )}
        {items === null ? (
          <p className="muted" role="status">Decrypting…</p>
        ) : items.length === 0 ? (
          <p className="voice msg-empty">Say something. Only the people here can read it.</p>
        ) : (
          items.map((m, i) => {
            const mine = m.senderId === user?.id;
            const grouped = i > 0 && items[i - 1]!.senderId === m.senderId && m.createdAt - items[i - 1]!.createdAt < 5 * 60_000;
            const parent = m.replyTo ? items.find((x) => x.id === m.replyTo) : null;
            return (
              <article key={m.id} className={`msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`} aria-label={`${nameOf(m.senderId)}, ${time(m.createdAt)}`}>
                {!grouped && (
                  <header className="msg-head">
                    <span className="msg-author">{nameOf(m.senderId)}</span>
                    <time className="row-sub" dateTime={new Date(m.createdAt).toISOString()}>{time(m.createdAt)}</time>
                  </header>
                )}
                {parent && <p className="msg-quote">↳ {nameOf(parent.senderId)}: {parent.body?.text.slice(0, 80) || '…'}</p>}
                <div className="msg-body">
                  {m.deleted ? <span className="muted">Message deleted.</span> : m.body ? (
                    <>
                      {m.body.text && <p className="msg-text">{m.body.text}{m.editedAt && <span className="row-sub"> · edited</span>}</p>}
                      {m.body.attachments?.map((a) => <Attachment key={a.fileId} a={a} />)}
                    </>
                  ) : <span className="muted">This message could not be decrypted.</span>}
                </div>
                {m.reactions.length > 0 && (
                  <div className="msg-reactions">
                    {m.reactions.map((r) => (
                      <button key={r.reaction} type="button" className="reaction" aria-pressed={r.userIds.includes(user?.id ?? '')} onClick={() => void toggleReaction(m, r.reaction)} aria-label={`${REACTION_LABEL[r.reaction]}, ${r.userIds.length}`}>
                        <ReactionIcon r={r.reaction} /> {r.userIds.length}
                      </button>
                    ))}
                  </div>
                )}
                {!m.deleted && c.myStatus === 'active' && (
                  <div className="msg-tools">
                    <Menu
                      label={`Message options (${nameOf(m.senderId)}, ${time(m.createdAt)})`}
                      items={[
                        { label: 'Reply', onSelect: () => setReplyTo(m) },
                        ...REACTIONS.map((r) => ({ label: `React: ${REACTION_LABEL[r]}`, onSelect: () => void toggleReaction(m, r) })),
                        ...(mine && m.body ? [{ label: 'Edit', onSelect: () => (setEditing(m), setText(m.body!.text)) }] : []),
                        ...(mine ? [{ label: 'Delete for everyone', onSelect: () => void deleteMessage(m).then(async (r) => { const next = await decodeMessage(c, r.message); setItems((prev) => (prev ?? []).map((x) => (x.id === next.id ? next : x))); }), danger: true }] : []),
                        ...(!mine ? [{ label: 'Report…', onSelect: () => setReport(m) }] : []),
                      ]}
                    />
                  </div>
                )}
              </article>
            );
          })
        )}
        {seen && <p className="row-sub msg-seen">Seen</p>}
      </div>

      <p className="row-sub typing" aria-live="polite">{typingNames.length ? `${typingNames.join(', ')} ${typingNames.length > 1 ? 'are' : 'is'} typing…` : ' '}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {c.myStatus === 'active' && (
        <form className="composer" onSubmit={send}>
          {(replyTo || editing) && (
            <p className="row-sub composer-context">
              {editing ? 'Editing your message' : `Replying to ${nameOf(replyTo!.senderId)}`}{' '}
              <button type="button" className="link-btn" onClick={() => (setReplyTo(null), setEditing(null), editing && setText(''))}>Cancel</button>
            </p>
          )}
          <div className="composer-row">
            <button type="button" className="icon-btn" aria-label="Attach files (up to 25 MB, encrypted)" onClick={() => file.current?.click()} disabled={progress !== null}>
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m20 11.5-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7" /></svg>
            </button>
            <input ref={file} type="file" multiple hidden onChange={(e) => void attach(e.target.files)} />
            <button type="button" className="icon-btn gif-btn" disabled={!caps?.gifs} aria-label={caps?.gifs ? 'GIFs' : 'GIFs are not available yet'} title={caps?.gifs ? 'GIFs' : 'GIFs need a GIF provider, not set up yet'}>
              <span aria-hidden="true">GIF</span>
            </button>
            <label className="visually-hidden" htmlFor={`compose-${c.id}`}>Message</label>
            <textarea id={`compose-${c.id}`} className="composer-input" rows={1} value={text} onChange={(e) => onType(e.target.value)} onKeyDown={onKey} placeholder={progress !== null ? `Encrypting and uploading… ${Math.round(progress * 100)}%` : 'Message'} maxLength={8000} />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>{editing ? 'Save' : 'Send'}</button>
          </div>
        </form>
      )}
      {report && <ReportDialog open onClose={() => setReport(null)} targetType="message" targetId={report.id} label="this message" evidence={report.body?.text ?? ''} />}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add someone">
        <form
          className="share-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!keys) return;
            try {
              await addToGroup(keys, c, await lookupUser(addName));
              setAddOpen(false);
              setAddName('');
              onChanged();
            } catch (err) {
              setError(errorMessage(err));
              setAddOpen(false);
            }
          }}
        >
          <label className="field">
            <span className="field-label">Username</span>
            <input className="input" value={addName} onChange={(e) => setAddName(e.target.value)} autoComplete="off" autoCapitalize="none" />
          </label>
          <p className="row-sub">They will be able to read the earlier messages in this group too.</p>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!addName.trim()}>Add</button>
        </form>
      </Modal>
    </section>
  );
}

export function Messages() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user, keys } = useSession();
  const realtime = useRealtime();
  const titleOf = useConversationTitle();
  const [list, setList] = useState<Conversation[] | null>(null);
  const [tab, setTab] = useState<'inbox' | 'requests'>('inbox');
  const [newOpen, setNewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [single, setSingle] = useState<Conversation | null>(null);

  const load = useCallback(async () => {
    if (!keys || !user) return;
    try {
      const r = await api<{ conversations: import('@arai/shared').ConversationDto[] }>('GET', '/conversations');
      setList(await Promise.all(r.conversations.map((d) => decodeConversation(d, keys, user.id))));
      realtime.refreshUnread();
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [keys, user, realtime]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => realtime.subscribe((e) => (e.type === 'message' || e.type === 'conversation' || e.type === 'read') && void load()), [realtime, load]);

  // A conversation not in the list yet (e.g. a project chat with no messages).
  useEffect(() => {
    if (!id || !keys || !user || list === null || list.some((c) => c.id === id)) return setSingle(null);
    const path = id.startsWith('p-') ? `/projects/${id.slice(2)}/conversation` : `/conversations/${id}`;
    api<{ conversation: import('@arai/shared').ConversationDto }>('GET', path)
      .then(async (r) => {
        if (id.startsWith('p-')) return nav(`/messages/${r.conversation.id}`, { replace: true });
        setSingle(await decodeConversation(r.conversation, keys, user.id));
      })
      .catch(() => setError('This conversation is not available.'));
  }, [id, list, keys, user, nav]);

  const current = list?.find((c) => c.id === id) ?? single;
  const requests = (list ?? []).filter((c) => c.myStatus === 'request');
  const shown = (list ?? []).filter((c) => (tab === 'requests' ? c.myStatus === 'request' : c.myStatus === 'active'));
  const preview = useMemo(() => (c: Conversation) => (c.lastText ? (c.last?.senderId === user?.id ? `You: ${c.lastText}` : c.lastText) : 'No messages yet'), [user?.id]);

  return (
    <div className={`messages${current ? ' has-thread' : ''}`}>
      <section className="conv-pane" aria-label="Conversations">
        <header className="page-header page-header-actions">
          <div className="page-header-title"><h1>Messages</h1></div>
          <button type="button" className="btn btn-sm" onClick={() => setNewOpen(true)}>New message</button>
        </header>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="filters" role="group" aria-label="Show">
          <button type="button" className="filter" aria-pressed={tab === 'inbox'} onClick={() => setTab('inbox')}>Inbox</button>
          <button type="button" className="filter" aria-pressed={tab === 'requests'} onClick={() => setTab('requests')}>Requests{requests.length ? ` (${requests.length})` : ''}</button>
        </div>
        {list === null ? (
          <p className="muted" role="status">Decrypting…</p>
        ) : shown.length === 0 ? (
          <p className="voice">{tab === 'requests' ? 'No message requests.' : 'No conversations yet. Start one, or open a project’s chat from its People panel.'}</p>
        ) : (
          <ul className="conv-list">
            {shown.map((c) => {
              const other = c.kind === 'dm' ? c.members.find((m) => m.id !== user?.id) : null;
              return (
                <li key={c.id}>
                  <Link to={`/messages/${c.id}`} className={`conv${c.id === id ? ' active' : ''}${c.unread ? ' unread' : ''}`} aria-current={c.id === id ? 'page' : undefined}>
                    {other ? <Avatar profile={other} size={36} /> : <span className="avatar-img avatar-fallback conv-mark" style={{ width: 36, height: 36 }} aria-hidden="true">{c.kind === 'project' ? '♪' : '#'}</span>}
                    <span className="conv-main">
                      <span className="conv-title">{titleOf(c)}</span>
                      <span className="row-sub conv-preview">{preview(c)}</span>
                    </span>
                    <span className="conv-side">
                      {c.lastMessageAt && <span className="row-sub">{time(c.lastMessageAt)}</span>}
                      {c.unread > 0 && <span className="badge conv-badge" aria-label={`${c.unread} unread`}>{c.unread}</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {current ? <Thread key={current.id} c={current} onChanged={load} /> : <div className="thread-pane thread-empty"><p className="voice">Choose a conversation.</p></div>}
      <NewConversation open={newOpen} onClose={() => setNewOpen(false)} onCreated={(cid) => { setNewOpen(false); void load().then(() => nav(`/messages/${cid}`)); }} />
    </div>
  );
}
