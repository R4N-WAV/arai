import { linkService, type ProfileDto } from '@arai/shared';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { useAmbient } from './Ambient';
import { Cover } from './Cover';

const joined = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export function imageUrl(p: Pick<ProfileDto, 'username'>, kind: 'avatar' | 'banner', v: number) {
  return `/api/profiles/${encodeURIComponent(p.username)}/${kind}?v=${v}`;
}

export function Avatar({ profile, size = 112 }: { profile: Pick<ProfileDto, 'username' | 'avatar' | 'displayName'>; size?: number }) {
  return profile.avatar ? (
    <img className="avatar-img" src={imageUrl(profile, 'avatar', profile.avatar)} alt="" width={size} height={size} />
  ) : (
    <span className="avatar-img avatar-fallback" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {(profile.displayName || profile.username).slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ProfileView({ profile, isOwn }: { profile: ProfileDto; isOwn: boolean }) {
  const { setOverride } = useAmbient();
  // A profile glows with the colours of its public projects.
  useEffect(() => {
    setOverride(profile.projects.flatMap((p) => (p.publicMeta.color ? [p.publicMeta.color] : [])));
    return () => setOverride(null);
  }, [profile, setOverride]);

  const name = profile.displayName || profile.username;
  return (
    <article className="profile" aria-labelledby="profile-name">
      <div className={profile.banner ? 'profile-banner' : 'profile-banner profile-banner-empty'}>
        {profile.banner && <img src={imageUrl(profile, 'banner', profile.banner)} alt="" />}
      </div>
      <header className="profile-head">
        <Avatar profile={profile} />
        <div className="profile-names">
          <h1 id="profile-name">{name}</h1>
          <p className="row-sub">
            @{profile.username}
            {profile.location && ` · ${profile.location}`} · joined {joined(profile.joinedAt)}
          </p>
        </div>
        {isOwn && <Link to="/profile/edit" className="btn btn-sm profile-edit">Edit profile</Link>}
      </header>
      {profile.bio && <p className="voice profile-bio">{profile.bio}</p>}
      {profile.links.length > 0 && (
        <ul className="profile-links">
          {profile.links.map((l) => (
            <li key={l.url}>
              <a href={l.url} rel="noopener noreferrer nofollow ugc" target="_blank">
                {l.label || linkService(l.url)}
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <section className="section" aria-labelledby="pub-h">
        <h2 id="pub-h">Public projects</h2>
        {profile.projects.length === 0 ? (
          <p className="muted">{isOwn ? 'Nothing public yet. Projects you make public appear here.' : 'Nothing public yet.'}</p>
        ) : (
          <>
            <ul className="sleeves">
              {profile.projects.map((p) => (
                <li key={p.id} className="sleeve">
                  <Cover name={p.publicMeta.name} color={p.publicMeta.color ?? '#8a8f98'} />
                  <span className="sleeve-name">{p.publicMeta.name}</span>
                  <span className="sleeve-meta">{[p.publicMeta.genre, ...p.publicMeta.tags].filter(Boolean).join(' · ') || 'public'}</span>
                </li>
              ))}
            </ul>
            <p className="muted" style={{ fontSize: 'var(--fs-sm)', marginTop: 'var(--s-5)' }}>Listening from profiles arrives with public sharing, in the next phase.</p>
          </>
        )}
      </section>
    </article>
  );
}
