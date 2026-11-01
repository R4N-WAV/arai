import { Link, NavLink, Outlet } from 'react-router';
import { useSession } from '../lib/session';
import { IconDiscover, IconLibrary, IconMessages, IconSettings, Logo } from './Icons';

const NAV = [
  { to: '/', label: 'Library', icon: IconLibrary, end: true },
  { to: '/discover', label: 'Discover', icon: IconDiscover },
  { to: '/messages', label: 'Messages', icon: IconMessages },
  { to: '/settings', label: 'Settings', icon: IconSettings },
];

export function AppShell() {
  const { user, signOut } = useSession();
  const links = NAV.map(({ to, label, icon: Icon, end }) => (
    <NavLink key={to} to={to} end={end} className="nav-link">
      <Icon />
      <span>{label}</span>
    </NavLink>
  ));
  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <nav className="sidebar" aria-label="Main">
        <Link className="brand" to="/"><Logo /> Arai</Link>
        {links}
        <div className="sidebar-foot">
          <p className="muted" style={{ padding: '0 var(--s-3)', fontSize: 'var(--fs-sm)' }}>@{user?.username}</p>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => void signOut()}>Sign out</button>
        </div>
      </nav>
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Main">{links}</nav>
    </div>
  );
}
