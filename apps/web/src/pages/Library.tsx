export function Library() {
  return (
    <>
      <h1>Library</h1>
      <div className="empty">
        <h2>No projects yet</h2>
        <p className="muted">
          Projects, uploads and playback are the next development phase and are not built yet. This page will list your projects once
          they are.
        </p>
      </div>
    </>
  );
}

export function NotBuilt({ title }: { title: string }) {
  return (
    <>
      <h1>{title}</h1>
      <div className="empty">
        <p className="muted">This section is planned and not built yet.</p>
      </div>
    </>
  );
}
