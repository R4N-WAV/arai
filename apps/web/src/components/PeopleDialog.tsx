import type { MemberDto } from '@arai/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, errorMessage } from '../lib/api';
import { createInviteLink, inviteMember, listInviteLinks, listMembers, lookupUser, removeMember, revokeInviteLink, setMemberRole, type InviteLink } from '../lib/collab';
import { roleWithArticle, useProjects, type Project } from '../lib/projects';
import { useSession } from '../lib/session';
import { Modal } from './Modal';
import { Notice } from './Unavailable';

const ROLE_TEXT = {
  listener: 'Listener: plays and comments',
  editor: 'Editor: also uploads and edits',
  admin: 'Admin: also invites, removes and publishes',
} as const;
type InviteRole = keyof typeof ROLE_TEXT;

export function PeopleDialog({ p, open, onClose }: { p: Project; open: boolean; onClose: () => void }) {
  const { user, keys } = useSession();
  const { refresh } = useProjects();
  const nav = useNavigate();
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<InviteRole>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const isOwner = p.role === 'owner';
  const canAdmin = isOwner || p.role === 'admin';

  // Keyed on the project id: a refreshed project object must not reset the dialog.
  const pRef = useRef(p);
  pRef.current = p;
  const load = useCallback(async () => {
    try {
      setMembers(await listMembers(pRef.current));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    if (open) {
      setError(null);
      setStatus(null);
      setConfirm(null);
      void load();
    }
  }, [open, load, p.id]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
      setStatus(done);
      await load();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'No one with that username can be invited.' : e instanceof ApiError && e.code === 'already_member' ? 'They are already in this project.' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const invite = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim().replace(/^@/, '');
    if (!n || !keys) return;
    void run(async () => {
      const u = await lookupUser(n);
      if (u.id === user?.id) throw new Error('That is you.');
      await inviteMember(p, keys, u, role);
      setName('');
    }, `Invited @${n}. They can accept it from their library.`);
  };

  const canManage = (m: MemberDto) => m.role !== 'owner' && m.id !== user?.id && (isOwner || (canAdmin && m.role !== 'admin'));

  return (
    <Modal open={open} onClose={onClose} title="People">
      {error && <Notice kind="error">{error}</Notice>}
      <p className="form-actions people-chat">
        <button type="button" className="btn btn-sm" onClick={() => { onClose(); nav(`/messages/p-${p.id}`); }}>Open project chat</button>
        <span className="row-sub">Everyone here can read it; it uses the project’s key.</span>
      </p>
      {status && <Notice kind="ok">{status}</Notice>}
      {canAdmin && (
        <form className="invite-form" onSubmit={invite}>
          <label className="field">
            <span className="field-label">Invite by username</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="username" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={31} />
          </label>
          <label className="field">
            <span className="field-label">Role</span>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as InviteRole)}>
              {(Object.keys(ROLE_TEXT) as InviteRole[]).filter((r) => r !== 'admin' || isOwner).map((r) => <option key={r} value={r}>{ROLE_TEXT[r]}</option>)}
            </select>
          </label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>Invite</button>
          <p className="row-sub">They receive the project key sealed to their account, so the project stays end-to-end encrypted.</p>
        </form>
      )}
      {canAdmin && <InviteLinks p={p} />}
      <ul className="list member-list" aria-label="Members">
        {(members ?? []).map((m) => (
          <li key={m.id} className="member">
            <div className="row-main">
              <div className="row-title">
                {m.displayName || m.username}
                {m.id === user?.id && <span className="tag">you</span>}
                {m.pending && <span className="tag">invited</span>}
              </div>
              <p className="row-sub">@{m.username}</p>
            </div>
            {canManage(m) ? (
              <>
                <label className="visually-hidden" htmlFor={`role-${m.id}`}>Role of {m.username}</label>
                <select
                  id={`role-${m.id}`}
                  className="input input-sm"
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => void run(() => setMemberRole(p, m.id, e.target.value as InviteRole), `@${m.username} is now ${roleWithArticle(e.target.value)}.`)}
                >
                  {(['listener', 'editor', 'admin'] as const).filter((r) => r !== 'admin' || isOwner).map((r) => <option key={r} value={r}>{r[0]!.toUpperCase() + r.slice(1)}</option>)}
                </select>
                {confirm === m.id ? (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await removeMember(p, m.id);
                        await refresh(); // rotates the key for everyone who remains
                      }, `Removed @${m.username}. A new project key was made for everyone else.`)
                    }
                  >
                    Remove @{m.username}
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(m.id)}>{m.pending ? 'Cancel invite' : 'Remove'}</button>
                )}
              </>
            ) : (
              <span className="row-sub member-role">{m.role[0]!.toUpperCase() + m.role.slice(1)}</span>
            )}
          </li>
        ))}
      </ul>
      {!isOwner && (
        <section className="modal-section danger" aria-labelledby="leave-h">
          <h3 id="leave-h">Leave project</h3>
          <p className="row-sub">You lose access straight away. Someone has to invite you again to come back.</p>
          {confirm === 'leave' ? (
            <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void run(async () => { await removeMember(p, 'me'); await refresh(); nav('/', { replace: true }); }, 'You left the project.')}>
              Leave for good
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => setConfirm('leave')}>Leave…</button>
          )}
        </section>
      )}
    </Modal>
  );
}

/** Invite links: for people who are not on Arai yet (they sign up, then join). */
function InviteLinks({ p }: { p: Project }) {
  const [links, setLinks] = useState<InviteLink[] | null>(null);
  const [role, setRole] = useState<'listener' | 'editor'>('listener');
  const [uses, setUses] = useState(1);
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => listInviteLinks(p).then(setLinks).catch(() => setLinks([])), [p]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setError('Copying is blocked here; select the link and copy it yourself.');
    }
  };
  if (!open) {
    return (
      <p className="form-actions people-chat">
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Invite link…</button>
        <span className="row-sub">For people who are not on Arai yet.</span>
      </p>
    );
  }
  return (
    <section className="modal-section invite-links" aria-labelledby="il-h">
      <h3 id="il-h">Invite link</h3>
      <p className="row-sub">Anyone with the link can create an account and join, so send it privately. It carries the project key in the part after #, which never reaches Arai. It stops working after its uses, after 7 days, or when someone is removed from the project.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="form-actions">
        <label className="visually-hidden" htmlFor="il-role">Role</label>
        <select id="il-role" className="input input-sm" value={role} onChange={(e) => setRole(e.target.value as 'listener' | 'editor')}>
          <option value="listener">Listener</option>
          <option value="editor">Editor</option>
        </select>
        <label className="visually-hidden" htmlFor="il-uses">How many people</label>
        <select id="il-uses" className="input input-sm" value={uses} onChange={(e) => setUses(Number(e.target.value))}>
          {[1, 5, 25].map((n) => <option key={n} value={n}>{n === 1 ? 'One person' : `Up to ${n} people`}</option>)}
        </select>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void createInviteLink(p, role, uses, 7).then((u) => (setMade(u), load())).catch((e) => setError(errorMessage(e)))}>Create link</button>
      </div>
      {made && (
        <div className="share-created">
          <input className="input mono" readOnly value={made} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
          <button type="button" className="btn btn-sm" onClick={() => void copy(made)}>{copied === made ? 'Copied' : 'Copy link'}</button>
        </div>
      )}
      {links && links.length > 0 && (
        <ul className="list">
          {links.map((l) => (
            <li key={l.id} className="share-row">
              <div className="row-main">
                <div className="row-title">{l.role === 'editor' ? 'Editor' : 'Listener'} · {l.uses} of {l.maxUses} used</div>
                <p className="row-sub">Expires {new Date(l.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</p>
              </div>
              {l.url && <button type="button" className="btn btn-sm" onClick={() => void copy(l.url!)}>{copied === l.url ? 'Copied' : 'Copy'}</button>}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void revokeInviteLink(p, l.id).then(load)}>Turn off</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
