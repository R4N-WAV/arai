import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AmbientProvider } from './components/Ambient';
import { AppShell, AppShellWith } from './components/AppShell';
import { SessionProvider, useSession } from './lib/session';
import { PlayerProvider } from './lib/player';
import { ProjectsProvider } from './lib/projects';
import { Library, NotBuilt } from './pages/Library';
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
    <ProjectsProvider>
      <PlayerProvider>
        <AppShellWith>
          <ProfilePage />
        </AppShellWith>
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
      <BrowserRouter>
        <Routes>
          <Route path="/signin" element={<GuestOnly><SignIn /></GuestOnly>} />
          <Route path="/register" element={<GuestOnly><Register /></GuestOnly>} />
          <Route path="/recover" element={<GuestOnly><Recover /></GuestOnly>} />
          <Route element={<RequireAuth><ProjectsProvider><PlayerProvider><AppShell /></PlayerProvider></ProjectsProvider></RequireAuth>}>
            <Route index element={<Library />} />
            <Route path="projects/new" element={<NewProject />} />
            <Route path="projects/:id" element={<ProjectPage />} />
            <Route path="discover" element={<NotBuilt title="Discover" />} />
            <Route path="messages" element={<NotBuilt title="Messages" />} />
            <Route path="settings" element={<Settings />} />
            <Route path="profile/edit" element={<EditProfile />} />
            <Route path="import" element={<ImportPage />} />
          </Route>
          <Route path="/u/:username" element={<ProfileRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
    </AmbientProvider>
  </StrictMode>,
);
