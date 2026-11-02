import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Discover } from './pages/Discover';
import { AdminPage } from './pages/Admin';
import { Messages } from './pages/Messages';
import { RealtimeProvider } from './lib/messages';
import { Activity } from './pages/Activity';
import { ListenPage, SharePage } from './pages/SharePage';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AmbientProvider } from './components/Ambient';
import { AppShell, AppShellWith } from './components/AppShell';
import { SessionProvider, useSession } from './lib/session';
import { PlayerProvider } from './lib/player';
import { ProjectsProvider } from './lib/projects';
import { MeProvider } from './lib/me';
import { Library } from './pages/Library';
import { NewProject } from './pages/NewProject';
import { EditProfile } from './pages/EditProfile';
import { ImportPage } from './pages/Import';
import { ProfilePage, PublicProfilePage } from './pages/Profile';
import { ProjectPage } from './pages/Project';
import { Recover } from './pages/Recover';
import { Register } from './pages/Register';
import { Settings } from './pages/Settings';
import { SignIn } from './pages/SignIn';
import { Unlock } from './pages/Unlock';
import { startStreamingWorker } from './lib/stream';
import './styles/app.css';

void startStreamingWorker();

function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, user, keys } = useSession();
  if (loading) return <p className="loading" role="status">Loading…</p>;
  if (!user) return <Navigate to="/signin" replace />;
  if (!keys) return <Unlock />;
  return <>{children}</>;
}

function ProfileRoute() {
  const { loading, user, keys } = useSession();
  if (loading) return <p className="loading" role="status">Loading…</p>;
  if (!user) return <PublicProfilePage />;
  if (!keys) return <Unlock />;
  return (
    <AppShellWith>
      <ProfilePage />
    </AppShellWith>
  );
}

/**
 * Signed-in state that must outlive page changes: projects, the player (so
 * music keeps playing wherever you go) and your own profile. Keyed by user,
 * so signing out tears everything down.
 */
function SignedIn({ children }: { children: ReactNode }) {
  const { user, keys } = useSession();
  if (!user || !keys) return <>{children}</>;
  return (
    <ProjectsProvider key={user.id}>
      <PlayerProvider>
        <MeProvider>
          <RealtimeProvider>{children}</RealtimeProvider>
        </MeProvider>
      </PlayerProvider>
    </ProjectsProvider>
  );
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { loading, user } = useSession();
  if (loading) return <p className="loading" role="status">Loading…</p>;
  return user ? <Navigate to="/" replace /> : <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AmbientProvider>
    <SessionProvider>
      <SignedIn>
      <BrowserRouter>
        <Routes>
          <Route path="/signin" element={<GuestOnly><SignIn /></GuestOnly>} />
          <Route path="/register" element={<GuestOnly><Register /></GuestOnly>} />
          <Route path="/recover" element={<GuestOnly><Recover /></GuestOnly>} />
          <Route element={<RequireAuth><AppShell /></RequireAuth>}>
            <Route index element={<Library />} />
            <Route path="projects/new" element={<NewProject />} />
            <Route path="projects/:id" element={<ProjectPage />} />
            <Route path="discover" element={<Discover />} />
            <Route path="activity" element={<Activity />} />
            <Route path="admin" element={<AdminPage />} />
            <Route path="messages" element={<Messages />} />
            <Route path="messages/:id" element={<Messages />} />
            <Route path="settings" element={<Settings />} />
            <Route path="profile/edit" element={<EditProfile />} />
            <Route path="import" element={<ImportPage />} />
          </Route>
          <Route path="/u/:username" element={<ProfileRoute />} />
          <Route path="/s/:id" element={<SharePage />} />
          <Route path="/listen/:projectId" element={<ListenPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </SignedIn>
    </SessionProvider>
    </AmbientProvider>
  </StrictMode>,
);
