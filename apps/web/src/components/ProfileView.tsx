import { linkService, type ProfileDto } from '@arai/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '../lib/api';
import { useAmbient } from './Ambient';
import { Cover } from './Cover';
import { publicArtUrl } from '../lib/art';
import { Menu } from './Menu';
import { ReportDialog } from './ReportDialog';
import { Notice } from './Unavailable';

interface Relation {
  self: boolean;
  following: boolean;
  followsYou: boolean;
  friend: 'none' | 'requested' | 'incoming' | 'friends';
  blocked: boolean;
  followers: number;
  followingCount: number;
}

/** Follow, friend, block and report, for signed-in visitors of someone else's profile. */
function SocialActions({ username }: { username: string }) {
  const [rel, setRel] = useState<Relation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState(false);
  const path = `/social/${encodeURIComponent(username)}`;
  const load = useCallback(() => api<Relation>('GET', path).then(setRel).catch(() => setRel(null)), [path]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!rel || rel.self) return null;
  const act = (method: 'POST' | 'DELETE', what: string) => api(method, `${path}/${what}`).then(load).catch((e) => setError(errorMessage(e)));
  return (
    <div className="social-actions">
      {error && <Notice kind="error">{error}</Notice>}
      <p className="row-sub">{rel.followers} follower{rel.followers === 1 ? '' : 's'} · following {rel.followingCount}{rel.followsYou && ' · follows you'}</p>
      {rel.blocked ? (
        <button type="button" className="btn btn-sm" onClick={() => void act('DELETE', 'block')}>Unblock</button>
      ) : (
        <span className="form-actions">
          <button type="button" className={rel.following ? 'btn btn-sm' : 'btn btn-primary btn-sm'} onClick={() => void act(rel.following ? 'DELETE' : 'POST', 'follow')}>
            {rel.following ? 'Following' : 'Follow'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void act(rel.friend === 'friends' || rel.friend === 'requested' ? 'DELETE' : 'POST', 'friend')}>
            {rel.friend === 'friends' ? 'Friends' : rel.friend === 'requested' ? 'Request sent' : rel.friend === 'incoming' ? 'Accept friend request' : 'Add friend'}
          </button>
          <Menu
            label={`More for @${username}`}
            items={[
              ...(rel.friend === 'friends' ? [{ label: 'Remove friend', onSelect: () => void act('DELETE', 'friend') }] : []),
              { label: 'Report…', onSelect: () => setReport(true) },
              { label: `Block @${username}`, onSelect: () => void act('POST', 'block'), danger: true },
            ]}
          />
        </span>
      )}
      <ReportDialog open={report} onClose={() => setReport(false)} targetType="user" targetId={username} label={`@${username}`} />
    </div>
  );
}

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

export function ProfileView({ profile, isOwn, signedIn = false }: { profile: ProfileDto; isOwn: boolean; signedIn?: boolean }) {
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
      {signedIn && !isOwn && <SocialActions username={profile.username} />}
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
          <ul className="sleeves">
            {profile.projects.map((p) => {
              const inner = (
                <>
                  <Cover name={p.publicMeta.name} color={p.publicMeta.color ?? '#8a8f98'} art={publicArtUrl(p.id, p.art)} />
                  <span className="sleeve-name">{p.publicMeta.name}</span>
                  <span className="sleeve-meta">{p.listenable ? 'Listen' : [p.publicMeta.genre, ...p.publicMeta.tags].filter(Boolean).join(' · ') || 'public'}</span>
                </>
              );
              return (
                <li key={p.id}>
                  {p.listenable ? <Link to={`/listen/${p.id}`} className="sleeve">{inner}</Link> : <div className="sleeve">{inner}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </article>
  );
}
