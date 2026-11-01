import type { DiscoverProjectDto, PersonDto } from '@arai/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Cover } from '../components/Cover';
import { Avatar } from '../components/ProfileView';
import { Notice } from '../components/Unavailable';
import { api, errorMessage } from '../lib/api';

export function Discover() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ projects: DiscoverProjectDto[]; people: PersonDto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ projects: DiscoverProjectDto[]; people: PersonDto[] }>('GET', `/discover?q=${encodeURIComponent(q.trim())}`)
        .then((r) => (setRes(r), setError(null)))
        .catch((e) => setError(errorMessage(e)));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <header className="page-header">
        <h1>Discover</h1>
        <span className="voice">public music and people</span>
      </header>
      <div className="search">
        <label className="visually-hidden" htmlFor="discover-q">Search public projects and people</label>
        <input id="discover-q" className="input" type="search" placeholder="Search names, genres, tags, people" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} autoComplete="off" />
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {res && res.people.length > 0 && (
        <section className="section" aria-labelledby="people-h">
          <h2 id="people-h" className="section-title">People</h2>
          <ul className="list">
            {res.people.map((p) => (
              <li key={p.id} className="row">
                <Avatar profile={p} size={40} />
                <div className="row-main">
                  <Link to={`/u/${p.username}`} className="row-title">{p.displayName || p.username}</Link>
                  <p className="row-sub">@{p.username}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {res && (
        <section className="section" aria-labelledby="proj-h">
          <h2 id="proj-h" className="section-title">{q.trim() ? 'Projects' : 'Recently made public'}</h2>
          {res.projects.length === 0 ? (
            <p className="muted">{q.trim() ? 'Nothing public matches that yet.' : 'Nothing has been made public yet. Projects stay private until their owner publishes them.'}</p>
          ) : (
            <ul className="sleeves">
              {res.projects.map((p) => (
                <li key={p.id}>
                  <Link to={p.listenable ? `/listen/${p.id}` : `/u/${p.owner}`} className="sleeve">
                    <Cover name={p.publicMeta.name} color={p.publicMeta.color ?? '#8a8f98'} />
                    <span className="sleeve-name">{p.publicMeta.name}</span>
                    <span className="sleeve-meta">@{p.owner}{p.publicMeta.genre && ` · ${p.publicMeta.genre}`}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
