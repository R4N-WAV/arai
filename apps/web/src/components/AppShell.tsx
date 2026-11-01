import type { ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { useSession } from '../lib/session';
import { IconDiscover, IconLibrary, IconMessages, IconSettings } from './Icons';
import { HomeLink } from './Logo';
import { PlayerBar } from './PlayerBar';
import { usePlayer } from '../lib/player';

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
  const initial = user?.username.slice(0, 1).toUpperCase();
  const links = NAV.map(({ to, label, icon: Icon, end }) => (
    <NavLink key={to} to={to} end={end} className="nav-link">
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
        <div className="sidebar-foot">
          <Link to={`/u/${user?.username ?? ''}`} className="user-chip">
            <span className="avatar" aria-hidden="true">{initial}</span>
            <span className="user-name">{user?.username}</span>
            <span className="visually-hidden">, your profile</span>
          </Link>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()}>Sign out</button>
        </div>
      </nav>
      <div>
        <header className="mobile-bar">
          <HomeLink />
          <span className="form-actions">
            <Link to={`/u/${user?.username ?? ''}`} className="avatar" aria-label="Your profile">{initial}</Link>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()}>Sign out</button>
          </span>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <PlayerBar />
      <nav className="tabbar" aria-label="Main">{links}</nav>
    </div>
  );
}
