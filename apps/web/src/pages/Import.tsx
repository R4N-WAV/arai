import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import { COLOURS } from '../components/ProjectForm';
import { Notice } from '../components/Unavailable';
import { api, errorMessage } from '../lib/api';
import { formatBytes } from '../lib/audio';
import { prepareImage } from '../lib/images';
import { ART_BYTES, ART_PX, uploadArt } from '../lib/art';
import { buildPlan, coverColour, expandZips, fromDrop, fromFileList, type ImportPlan, type SourceFile } from '../lib/importer';
import { useProjects, type Project } from '../lib/projects';
import { UPLOAD_ERRORS, UploadJob, type Track } from '../lib/tracks';

type Phase = 'pick' | 'reading' | 'review' | 'importing' | 'done';
interface Result { name: string; project: Project | null; uploaded: number; failed: { file: string; reason: string }[] }

export function ImportPage() {
  const { create, refresh } = useProjects();
  const [phase, setPhase] = useState<Phase>('pick');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [reading, setReading] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [results, setResults] = useState<Result[]>([]);
  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ used: number; quota: number }>('GET', '/account/storage').then(setStorage).catch(() => undefined);
    // Folder picking needs a non-standard attribute React does not type.
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  async function load(get: () => Promise<SourceFile[]>) {
    setError(null);
    setPhase('reading');
    try {
      const sources = await expandZips(await get(), (n) => setReading(`Unpacking ${n}…`));
      const p = buildPlan(sources);
      if (p.projects.length === 0) {
        setError('No audio files were found. Choose the folder or ZIP you downloaded from the other platform.');
        setPhase('pick');
        return;
      }
      setPlan(p);
      setNames(Object.fromEntries(p.projects.map((x) => [x.key, x.name])));
      setInclude(Object.fromEntries(p.projects.map((x) => [x.key, true])));
      setPhase('review');
    } catch {
      setError('Those files could not be read. If it is a ZIP, check that it is not damaged.');
      setPhase('pick');
    }
  }

  const chosen = plan?.projects.filter((p) => include[p.key]) ?? [];
  const chosenBytes = chosen.reduce((n, p) => n + p.bytes, 0);
  const fileCount = chosen.reduce((n, p) => n + p.tracks.reduce((m, t) => m + t.versions.length, 0), 0);
  const overQuota = storage ? storage.used + chosenBytes * 1.001 > storage.quota : false;

  async function run() {
    setPhase('importing');
    setProgress({ done: 0, total: fileCount, current: '' });
    const out: Result[] = [];
    let done = 0;
    for (const [i, p] of chosen.entries()) {
      const r: Result = { name: names[p.key]?.trim() || p.name, project: null, uploaded: 0, failed: [] };
      out.push(r);
      setResults([...out]);
      try {
        const color = (p.cover && (await coverColour(p.cover))) ?? COLOURS[i % COLOURS.length]!.hex;
        r.project = await create({ name: r.name.slice(0, 120), description: 'Imported', genre: '', tags: ['imported'], color }, 'private');
        // The cover becomes the project's artwork (square-cropped and re-encoded here).
        if (p.cover) await prepareImage(p.cover, { w: ART_PX, h: ART_PX }, ART_BYTES).then((img) => uploadArt(r.project!, img)).catch(() => undefined);
      } catch (e) {
        r.failed.push({ file: 'project', reason: errorMessage(e) });
        done += p.tracks.reduce((m, t) => m + t.versions.length, 0);
        setProgress((x) => ({ ...x, done }));
        continue;
      }
      for (const t of p.tracks) {
        let track: Track | null = null;
        for (const f of t.versions) {
          setProgress({ done, total: fileCount, current: `${r.name} · ${f.name}` });
          const job = new UploadJob(r.project, f, () => undefined, track, '', t.title);
          const got = await job.start();
          if (got) {
            track = got;
            r.uploaded++;
          } else {
            r.failed.push({ file: f.name, reason: UPLOAD_ERRORS[job.error ?? ''] ?? 'Upload failed.' });
            if (job.error === 'quota_exceeded' || job.error === 'storage_full') {
              setResults([...out]);
              setPhase('done');
              return;
            }
          }
          done++;
          setProgress({ done, total: fileCount, current: '' });
          setResults([...out]);
        }
      }
    }
    setPhase('done');
    void refresh();
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const items = e.dataTransfer.items;
    void load(() => fromDrop(items));
  };

  return (
    <>
      <header className="page-header">
        <h1>Import</h1>
        <span className="voice">bring your library with you</span>
      </header>
      {error && <Notice kind="error">{error}</Notice>}

      {(phase === 'pick' || phase === 'reading') && (
        <>
          <section className="section" aria-labelledby="how-h">
            <h2 id="how-h">From other platforms</h2>
            <p className="muted">
              Most music platforms do not let other apps copy your library directly, so the move happens through your own computer:
            </p>
            <ol className="steps">
              <li><strong>Download your music</strong> from the other platform using its download or export option, project by project. Folders or ZIP files both work.</li>
              <li><strong>Keep one folder per project</strong> if you can. Arai turns each folder (or ZIP) into a project.</li>
              <li><strong>Choose that folder below.</strong> Files named like “Song v2”, “Song (3)” or “Song final” become versions of one track.</li>
            </ol>
            <p className="row-sub">Everything is read and encrypted in this browser before it uploads. Your password for the other platform is never needed.</p>
          </section>
          <div
            className={dragging ? 'dropzone dragging' : 'dropzone'}
            onDragOver={(e) => (e.preventDefault(), setDragging(true))}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            {phase === 'reading' ? (
              <p className="voice" role="status">{reading || 'Reading your files…'}</p>
            ) : (
              <>
                <p className="voice">Drop a folder or ZIP here</p>
                <p className="row-sub">Or pick it:</p>
                <div className="form-actions">
                  <button type="button" className="btn btn-sm" onClick={() => folderInput.current?.click()}>Choose a folder</button>
                  <button type="button" className="btn btn-sm" onClick={() => filesInput.current?.click()}>Choose ZIP or audio files</button>
                </div>
              </>
            )}
            <input ref={folderInput} type="file" multiple hidden onChange={(e) => { const l = e.target.files; if (l) void load(async () => fromFileList(l)); e.target.value = ''; }} />
            <input ref={filesInput} type="file" multiple hidden accept=".zip,audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a,.ogg,.opus" onChange={(e) => { const l = e.target.files; if (l) void load(async () => fromFileList(l)); e.target.value = ''; }} />
          </div>
        </>
      )}

      {phase === 'review' && plan && (
        <section className="section" aria-labelledby="review-h">
          <h2 id="review-h">Here is what will be created</h2>
          <p className="section-lede">
            {chosen.length} project{chosen.length === 1 ? '' : 's'} · {fileCount} file{fileCount === 1 ? '' : 's'} · {formatBytes(chosenBytes)}. All private. Rename projects now or later.
          </p>
          {overQuota && storage && (
            <Notice kind="warn">This is more than your remaining storage ({formatBytes(Math.max(0, storage.quota - storage.used))} left). Untick some projects, or the import will stop when storage runs out.</Notice>
          )}
          <ul className="list import-plan">
            {plan.projects.map((p) => (
              <li key={p.key} className="row">
                <input type="checkbox" className="import-check" checked={!!include[p.key]} onChange={(e) => setInclude({ ...include, [p.key]: e.target.checked })} aria-label={`Import ${names[p.key]}`} />
                <div className="row-main">
                  <label className="visually-hidden" htmlFor={`name-${p.key}`}>Project name</label>
                  <input id={`name-${p.key}`} className="input import-name" value={names[p.key] ?? ''} maxLength={120} onChange={(e) => setNames({ ...names, [p.key]: e.target.value })} />
                  <p className="row-sub">
                    {p.tracks.length} track{p.tracks.length === 1 ? '' : 's'}
                    {p.tracks.some((t) => t.versions.length > 1) && ` · ${p.tracks.reduce((n, t) => n + t.versions.length, 0)} versions`} · {formatBytes(p.bytes)}
                    {p.cover && ' · cover art becomes the artwork'}
                  </p>
                  <details className="import-tracks">
                    <summary>Tracks</summary>
                    <ul>
                      {p.tracks.map((t) => (
                        <li key={t.title}>{t.title}{t.versions.length > 1 && <span className="muted"> — {t.versions.length} versions: {t.versions.map((f) => f.name).join(', ')}</span>}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              </li>
            ))}
          </ul>
          {plan.skipped.length > 0 && (
            <details className="import-tracks" style={{ marginTop: 'var(--s-4)' }}>
              <summary>{plan.skipped.length} file{plan.skipped.length === 1 ? '' : 's'} skipped (not audio)</summary>
              <ul>{plan.skipped.slice(0, 200).map((s) => <li key={s} className="muted">{s}</li>)}</ul>
            </details>
          )}
          <div className="form-actions" style={{ marginTop: 'var(--s-6)' }}>
            <button type="button" className="btn btn-primary" disabled={chosen.length === 0} onClick={() => void run()}>
              Import {chosen.length} project{chosen.length === 1 ? '' : 's'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setPlan(null); setPhase('pick'); }}>Start over</button>
          </div>
        </section>
      )}

      {(phase === 'importing' || phase === 'done') && (
        <section className="section" aria-labelledby="prog-h">
          <h2 id="prog-h">{phase === 'done' ? 'Import finished' : 'Importing…'}</h2>
          <p className="section-lede" aria-live="polite">
            {progress.done} of {progress.total} files{progress.current && ` · ${progress.current}`}
          </p>
          <progress className="import-progress" max={Math.max(1, progress.total)} value={progress.done} aria-label="Import progress" />
          {phase === 'importing' && <p className="row-sub">Keep this tab open. Each file is encrypted here before it uploads.</p>}
          <ul className="list" style={{ marginTop: 'var(--s-5)' }}>
            {results.map((r) => (
              <li key={r.name} className="row">
                <div className="row-main">
                  <div className="row-title">{r.project ? <Link to={`/projects/${r.project.id}`}>{r.name}</Link> : r.name}</div>
                  <p className="row-sub">
                    {r.uploaded} uploaded{r.failed.length > 0 && ` · ${r.failed.length} not imported`}
                  </p>
                  {r.failed.length > 0 && (
                    <ul className="import-failed">
                      {r.failed.map((f, i) => <li key={i}>{f.file}: {f.reason}</li>)}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {phase === 'done' && (
            <p style={{ marginTop: 'var(--s-5)' }}><Link to="/" className="btn">Go to your library</Link></p>
          )}
        </section>
      )}
    </>
  );
}
