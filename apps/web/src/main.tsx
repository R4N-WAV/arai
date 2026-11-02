import { lazy, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';



import { RealtimeProvider } from './lib/messages';


import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AmbientProvider } from './components/Ambient';
import { AppShell, AppShellWith } from './components/AppShell';
import { SessionProvider, useSession } from './lib/session';
import { PlayerProvider } from './lib/player';
import { ProjectsProvider } from './lib/projects';
import { MeProvider } from './lib/me';
import { Library } from './pages/Library';
import { NewProject } from './pages/NewProject';


import { ProfilePage, PublicProfilePage } from './pages/Profile';
import { ProjectPage } from './pages/Project';

import { Register } from './pages/Register';

import { SignIn } from './pages/SignIn';
import { Unlock } from './pages/Unlock';
import { startStreamingWorker } from './lib/stream';
import './styles/app.css';
const Recover = lazy(() => import('./pages/Recover').then((m) => ({ default: m.Recover })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const ImportPage = lazy(() => import('./pages/Import').then((m) => ({ default: m.ImportPage })));
const EditProfile = lazy(() => import('./pages/EditProfile').then((m) => ({ default: m.EditProfile })));
const SharePage = lazy(() => import('./pages/SharePage').then((m) => ({ default: m.SharePage })));
const ListenPage = lazy(() => import('./pages/SharePage').then((m) => ({ default: m.ListenPage })));
const Activity = lazy(() => import('./pages/Activity').then((m) => ({ default: m.Activity })));
const Messages = lazy(() => import('./pages/Messages').then((m) => ({ default: m.Messages })));
const AdminPage = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminPage })));
const Discover = lazy(() => import('./pages/Discover').then((m) => ({ default: m.Discover })));

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
        <Suspense fallback={<p className="loading" role="status">Loading…</p>}>
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
        </Suspense>
      </BrowserRouter>
      </SignedIn>
    </SessionProvider>
    </AmbientProvider>
  </StrictMode>,
);
