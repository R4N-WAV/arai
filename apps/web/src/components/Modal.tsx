import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * Overlay panel on top of the page (native <dialog>: focus is trapped,
 * Esc closes, the page behind is inert). Slides/fades in and out.
 */
export function Modal({ open, onClose, title, children, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setClosing(false);
      d.showModal();
    } else if (!open && d.open) {
      setClosing(true);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const t = setTimeout(() => (d.close(), setClosing(false)), reduced ? 0 : 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' modal-wide' : ''}${closing ? ' closing' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => (e.preventDefault(), onClose())}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="modal-body">
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>
        {open || closing ? children : null}
      </div>
    </dialog>
  );
}
