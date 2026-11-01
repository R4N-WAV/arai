export function Library() {
  return (
    <>
      <h1 className="visually-hidden">Library</h1>
      <section className="empty" aria-labelledby="empty-title">
        <h2 id="empty-title">Your space is quiet.</h2>
        <p className="voice">Start a project and its colours will begin to seep in.</p>
        <p className="note">Projects, uploads and playback arrive in the next update.</p>
      </section>
    </>
  );
}

export function NotBuilt({ title }: { title: string }) {
  return (
    <>
      <header className="page-header">
        <h1>{title}</h1>
      </header>
      <p className="voice" style={{ fontSize: 'var(--fs-xl)' }}>Not built yet. This part of the space is still being made.</p>
    </>
  );
}
