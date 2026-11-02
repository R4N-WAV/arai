import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useSession } from '../lib/session';
import { IconBell, IconDiscover, IconLibrary, IconMessages, IconSettings } from './Icons';
import { useUnread } from '../lib/activity';
import { useRealtime } from '../lib/messages';
import { useLibrary } from '../lib/library';
import { setBadge } from '../lib/push';
import { ShortcutsDialog } from './Shortcuts';
import { Guide } from './Guide';
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

/**
 * Measures the fixed bars at the bottom of the screen (player + tab bar,
 * including the home-indicator inset) and exposes their height as
 * `--chrome-bottom`, so page content can always scroll fully clear of them.
 */
/** True once a new version of the app has taken over this page (service worker update). */
function useAppUpdated(): boolean {
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw?.controller) return; // first install is not an update
    const on = () => setUpdated(true);
    sw.addEventListener('controllerchange', on);
    return () => sw.removeEventListener('controllerchange', on);
  }, []);
  return updated;
}

function useBottomChrome(active: unknown) {
  useEffect(() => {
    const root = document.documentElement;
    const measure = () => {
      let top = window.innerHeight;
      for (const el of document.querySelectorAll<HTMLElement>('.player, .tabbar')) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.top < top) top = r.top;
      }
      root.style.setProperty('--chrome-bottom', `${Math.max(0, Math.ceil(window.innerHeight - top))}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    document.querySelectorAll('.player, .tabbar').forEach((el) => ro.observe(el));
    window.addEventListener('resize', measure);
    // The player slides in; measure again once it has settled.
    const t = window.setTimeout(measure, 500);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); window.clearTimeout(t); };
  }, [active]);
}

export function AppShellWith({ children }: { children: ReactNode }) {
  const { user, signOut } = useSession();
  const { item } = usePlayer();
  const { recordPlay, prefs, ready, dismissWelcome } = useLibrary();
  const [guide, setGuide] = useState(false);
  // First time someone enters with an account: show the guide once.
  const seenKey = `arai.guide-seen.${user?.id ?? ''}`;
  const seenHere = () => {
    try {
      return localStorage.getItem(seenKey) === '1';
    } catch {
      return false;
    }
  };
  useEffect(() => {
    if (ready && !prefs.welcomed && !seenHere()) setGuide(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, prefs.welcomed]);
  const closeGuide = () => {
    setGuide(false);
    try {
      localStorage.setItem(seenKey, '1');
    } catch {
      /* storage blocked: the synced preference still records it */
    }
    if (!prefs.welcomed) dismissWelcome();
  };
  const helpBtn = (cls: string) => (
    <button type="button" className={cls} aria-label="Help: open the guide" onClick={() => setGuide(true)}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.8v.3" /><path d="M12 16.8h.01" /></svg>
      {cls.includes('nav-link') && <span>Help</span>}
    </button>
  );
  const playedId = item?.track.id;
  useEffect(() => {
    if (item) recordPlay({ projectId: item.project.id, trackId: item.track.id, title: item.track.title });
    // Record once per track change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playedId]);
  const location = useLocation();
  useBottomChrome(Boolean(item));
  const unread = useUnread(location.pathname);
  const { unread: unreadMessages } = useRealtime();
  useEffect(() => setBadge(unread + unreadMessages), [unread, unreadMessages]);
  const updated = useAppUpdated();
  const bell = (cls: string) => (
    <Link to="/activity" className={cls} aria-label={unread ? `Activity, ${unread} new` : 'Activity'} viewTransition>
      <IconBell />
      {cls === 'nav-link' && <span>Activity</span>}
      {unread > 0 && <span className="badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
    </Link>
  );
  const navigate = useNavigate();
  // Top-level tabs have no back button; everything deeper does (installed apps have no browser back).
  const isTop = ['/', '/discover', '/settings', '/activity'].includes(location.pathname) || location.pathname.startsWith('/messages');
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
    <NavLink key={to} to={to} end={end} className="nav-link" viewTransition aria-label={to === '/messages' && unreadMessages ? `${label}, ${unreadMessages} unread` : undefined}>
      <Icon />
      <span>{label}</span>
      {to === '/messages' && unreadMessages > 0 && <span className="badge" aria-hidden="true">{unreadMessages > 9 ? '9+' : unreadMessages}</span>}
    </NavLink>
  ));
  return (
    <div className={item ? 'shell has-player' : 'shell'}>
      <a className="skip-link" href="#main">Skip to content</a>
      <nav className="sidebar" aria-label="Main">
        <HomeLink />
        <div className="nav-group">{links}{bell('nav-link')}{helpBtn('nav-link help-btn')}</div>
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
            {helpBtn('icon-btn help-btn')}
            {bell('icon-btn bell')}
            <Link to={`/u/${user?.username ?? ''}`} className="mobile-avatar" aria-label="Your profile"><Avatar profile={me} size={32} /></Link>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()}>Sign out</button>
          </span>
        </header>
        <main id="main" className="content" tabIndex={-1} key={location.pathname}>
          {back('content-back')}
          {children}
        </main>
      </div>
      {updated && (
        <div className="update-banner" role="status">
          Arai was updated.
          <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
      <ShortcutsDialog />
      <Guide open={guide} onClose={closeGuide} />
      <PlayerBar />
      <nav className="tabbar" aria-label="Main">{links}</nav>
    </div>
  );
}
