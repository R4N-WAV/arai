import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useSession } from '../lib/session';
import { IconDiscover, IconLibrary, IconMessages, IconSettings } from './Icons';
import { HomeLink } from './Logo';
import { PlayerBar } from './PlayerBar';
import { usePlayer } from '../lib/player';
import { useProjects } from '../lib/projects';
import { useMe } from '../lib/me';
import { Avatar } from './ProfileView';

const NAV = [
  { to: '/', label: 'Library', icon: IconLibrary, end: true },
  { to: '/discover', label: 'Discover', icon: IconDiscover },
  { to: '/messages', label: 'Messages', icon: IconMessages },
  { to: '/settings', label: 'Settings', icon: IconSettings },
];

export function AppShell() {
  return <AppShellWith><Outlet /></AppShellWith>;
}

export function AppShellWith({ children }: { children: ReactNode }) {
  const { user, signOut } = useSession();
  const { item } = usePlayer();
  const location = useLocation();
  const navigate = useNavigate();
  // Top-level tabs have no back button; everything deeper does (installed apps have no browser back).
  const isTop = ['/', '/discover', '/messages', '/settings'].includes(location.pathname);
  const goBack = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/', { viewTransition: true }));
  const back = (cls: string) => !isTop && (
    <button type="button" className={`back-btn ${cls}`} onClick={goBack} aria-label="Back">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 5-7 7 7 7" /></svg>
      <span>Back</span>
    </button>
  );
  const { projects } = useProjects();
  const { profile } = useMe();
  const me = profile ?? { username: user?.username ?? '', avatar: null, displayName: '' };
  const links = NAV.map(({ to, label, icon: Icon, end }) => (
    <NavLink key={to} to={to} end={end} className="nav-link" viewTransition>
      <Icon />
      <span>{label}</span>
    </NavLink>
  ));
  return (
    <div className={item ? 'shell has-player' : 'shell'}>
      <a className="skip-link" href="#main">Skip to content</a>
      <nav className="sidebar" aria-label="Main">
        <HomeLink />
        <div className="nav-group">{links}</div>
        {projects && projects.length > 0 && (
          <div className="nav-projects">
            <p className="nav-heading">Your projects</p>
            <ul>
              {projects.slice(0, 14).map((p) => (
                <li key={p.id}>
                  <NavLink to={`/projects/${p.id}`} className="nav-project" viewTransition>
                    <span className="nav-swatch" style={{ background: p.meta?.color ?? '#555' }} aria-hidden="true" />
                    <span className="nav-project-name">{p.meta?.name ?? 'Locked project'}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="sidebar-foot">
          <Link to={`/u/${user?.username ?? ''}`} className="user-chip">
            <Avatar profile={me} size={32} />
            <span className="user-name">{profile?.displayName || user?.username}</span>
            <span className="visually-hidden">, your profile</span>
          </Link>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()}>Sign out</button>
        </div>
      </nav>
      <div>
        <header className="mobile-bar">
          <span className="mobile-bar-left">
            {back('mobile-back')}
            {isTop && <HomeLink />}
          </span>
          <span className="form-actions">
            <Link to={`/u/${user?.username ?? ''}`} className="mobile-avatar" aria-label="Your profile"><Avatar profile={me} size={32} /></Link>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()}>Sign out</button>
          </span>
        </header>
        <main id="main" className="content" tabIndex={-1} key={location.pathname}>
          {back('content-back')}
          {children}
        </main>
      </div>
      <PlayerBar />
      <nav className="tabbar" aria-label="Main">{links}</nav>
    </div>
  );
}
