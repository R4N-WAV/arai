/**
 * The guide: a short tour drawn on top of the app. It opens by itself the
 * first time someone enters Arai with an account, and again from the Help
 * button. Each step can spotlight the part of the interface it talks about.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

interface Step {
  title: string;
  body: string;
  /** CSS selectors tried in order; the first visible one is spotlighted. */
  target?: string[];
}

const STEPS: Step[] = [
  { title: 'Welcome to அறை', body: 'Arai is a private room for your music. Everything here is encrypted on your device before it is uploaded, so only you and the people you invite can hear it.' },
  { title: 'Your library', body: 'Projects live here. As you add them, the space takes on the colours of their artwork.', target: ['.tabbar a[href="/"]', '.sidebar a[href="/"]'] },
  { title: 'Start a project', body: 'Create a project and drop your bounces on it, or import a whole library from another platform. New versions stack up under each track.', target: ['a[href="/projects/new"]'] },
  { title: 'Work together', body: 'Inside a project, People invites collaborators and Share makes a link for anyone. Comments pin notes to exact moments in a track.' },
  { title: 'Messages', body: 'End-to-end encrypted chats with friends, groups and every project you are in.', target: ['.tabbar a[href="/messages"]', '.sidebar a[href="/messages"]'] },
  { title: 'Activity', body: 'Invitations, comments, follows and friend requests arrive here. Turn on notifications in Settings to get them on your phone.', target: ['.mobile-bar .bell', '.sidebar a[href="/activity"]'] },
  { title: 'Keep your recovery key safe', body: 'It is the only way back in if you forget your password; nobody else, Arai included, can unlock your account. You can reopen this guide any time with Help.', target: ['.mobile-bar .help-btn', '.sidebar .help-btn'] },
];

function visible(selectors?: string[]): DOMRect | null {
  for (const s of selectors ?? []) {
    for (const el of document.querySelectorAll<HTMLElement>(s)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return r;
    }
  }
  return null;
}

export function Guide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = STEPS[i]!;
  const last = i === STEPS.length - 1;

  useEffect(() => {
    if (open) setI(0);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setRect(visible(step.target));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, step]);
  useEffect(() => {
    if (!open) return;
    card.current?.querySelector<HTMLButtonElement>('.guide-next')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setI((x) => Math.min(STEPS.length - 1, x + 1));
      else if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, i, onClose]);
  if (!open) return null;

  // Place the card away from the spotlight (below it, or above when it sits low).
  const pad = 8;
  const below = rect ? rect.bottom + 16 < window.innerHeight * 0.55 : true;
  const style = rect ? (below ? { top: Math.min(rect.bottom + 16, window.innerHeight - 280) } : { bottom: Math.max(16, window.innerHeight - rect.top + 16) }) : undefined;

  return (
    <div className="guide" role="presentation">
      <div className="guide-scrim" onClick={onClose} />
      {rect && <div className="guide-spot" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} aria-hidden="true" />}
      <div ref={card} className={`guide-card${rect ? '' : ' centred'}`} style={style} role="dialog" aria-modal="true" aria-labelledby="guide-title" aria-describedby="guide-body">
        <p className="row-sub guide-count">{i + 1} of {STEPS.length}</p>
        <h2 id="guide-title">{step.title}</h2>
        <p id="guide-body">{step.body}</p>
        {last && (
          <p className="row-sub">
            More answers in <Link to="/help" onClick={onClose}>Help</Link> · how encryption works in <Link to="/privacy" onClick={onClose}>Privacy</Link>
          </p>
        )}
        <div className="guide-dots" aria-hidden="true">
          {STEPS.map((_, k) => <span key={k} className={k === i ? 'on' : ''} />)}
        </div>
        <div className="form-actions">
          {i > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setI(i - 1)}>Back</button>}
          <button type="button" className="btn btn-primary btn-sm guide-next" onClick={() => (last ? onClose() : setI(i + 1))}>{last ? 'Done' : 'Next'}</button>
          {!last && <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Skip</button>}
        </div>
      </div>
    </div>
  );
}
