import type { NotificationDto, PersonDto } from '@arai/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Avatar } from '../components/ProfileView';
import { Notice } from '../components/Unavailable';
import { describe } from '../lib/activity';
import { api, errorMessage } from '../lib/api';

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export function Activity() {
  const [items, setItems] = useState<NotificationDto[] | null>(null);
  const [friends, setFriends] = useState<{ friends: PersonDto[]; incoming: PersonDto[]; outgoing: PersonDto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [n, f] = await Promise.all([api<{ notifications: NotificationDto[] }>('GET', '/notifications'), api<{ friends: PersonDto[]; incoming: PersonDto[]; outgoing: PersonDto[] }>('GET', '/social/me/friends')]);
      setItems(n.notifications);
      setFriends(f);
      if (n.notifications.some((x) => !x.read)) await api('POST', '/notifications/read');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const answer = (p: PersonDto, accept: boolean) => api(accept ? 'POST' : 'DELETE', `/social/${p.username}/friend`).then(load).catch((e) => setError(errorMessage(e)));

  return (
    <>
      <header className="page-header">
        <h1>Activity</h1>
      </header>
      {error && <Notice kind="error">{error}</Notice>}
      {friends && friends.incoming.length > 0 && (
        <section className="section" aria-labelledby="fr-h">
          <h2 id="fr-h" className="section-title">Friend requests</h2>
          <ul className="list">
            {friends.incoming.map((p) => (
              <li key={p.id} className="row">
                <Avatar profile={p} size={40} />
                <div className="row-main">
                  <Link to={`/u/${p.username}`} className="row-title">{p.displayName || p.username}</Link>
                  <p className="row-sub">@{p.username}</p>
                </div>
                <span className="form-actions">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void answer(p, true)}>Accept<span className="visually-hidden"> @{p.username}</span></button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void answer(p, false)}>Decline<span className="visually-hidden"> @{p.username}</span></button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="section" aria-labelledby="act-h">
        <h2 id="act-h" className="section-title">Recent</h2>
        {items === null ? (
          <p className="muted" role="status">Loading…</p>
        ) : items.length === 0 ? (
          <p className="voice">Nothing yet. Invitations, comments, follows and messages show up here.</p>
        ) : (
          <ul className="list">
            {items.map((n) => {
              const d = describe(n);
              return (
                <li key={n.id} className={`row activity${n.read ? '' : ' unread'}`}>
                  <div className="row-main">
                    {d.to ? <Link to={d.to} className="row-title">{d.text}</Link> : <span className="row-title">{d.text}</span>}
                    <p className="row-sub">{ago(n.createdAt)}{!n.read && ' · new'}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {friends && friends.friends.length > 0 && (
        <section className="section" aria-labelledby="fl-h">
          <h2 id="fl-h" className="section-title">Friends</h2>
          <ul className="list">
            {friends.friends.map((p) => (
              <li key={p.id} className="row">
                <Avatar profile={p} size={32} />
                <div className="row-main">
                  <Link to={`/u/${p.username}`} className="row-title">{p.displayName || p.username}</Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
