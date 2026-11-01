import { useNavigate } from 'react-router';
import { useState } from 'react';
import { ProjectForm } from '../components/ProjectForm';
import { Notice } from '../components/Unavailable';
import { errorMessage } from '../lib/api';
import { useProjects } from '../lib/projects';

export function NewProject() {
  const { create } = useProjects();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <header className="page-header">
        <h1>New project</h1>
        <span className="voice">a fresh room for something new</span>
      </header>
      {error && <Notice kind="error">{error}</Notice>}
      <ProjectForm
        submitLabel="Create project"
        busyLabel="Encrypting…"
        showVisibility
        onCancel={() => nav('/')}
        onSubmit={async ({ meta, visibility }) => {
          setError(null);
          try {
            const p = await create(meta, visibility);
            nav(`/projects/${p.id}`, { viewTransition: true });
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
    </>
  );
}
