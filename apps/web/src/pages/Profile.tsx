import type { ProfileDto } from '@arai/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { HomeLink } from '../components/Logo';
import { ProfileView } from '../components/ProfileView';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';

export function ProfilePage() {
  const { username } = useParams();
  const { user } = useSession();
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setProfile(null);
    setMissing(false);
    api<{ profile: ProfileDto }>('GET', `/profiles/${encodeURIComponent(username ?? '')}`)
      .then((r) => setProfile(r.profile))
      .catch((e) => (e instanceof ApiError && e.status === 404 ? setMissing(true) : setMissing(true)));
  }, [username]);

  if (missing) {
    return (
      <>
        <header className="page-header"><h1>No one here</h1></header>
        <p className="voice" style={{ fontSize: 'var(--fs-xl)' }}>There is no profile at @{username}.</p>
      </>
    );
  }
  if (!profile) return <p className="muted" role="status">Loading…</p>;
  return <ProfileView profile={profile} isOwn={user?.username.toLowerCase() === profile.username.toLowerCase()} signedIn={!!user} />;
}

/** The same profile for visitors who are not signed in. */
export function PublicProfilePage() {
  return (
    <div className="public-page">
      <header className="public-bar">
        <HomeLink />
        <Link to="/signin" className="btn btn-sm">Sign in</Link>
      </header>
      <main id="main" className="content">
        <ProfilePage />
      </main>
    </div>
  );
}
