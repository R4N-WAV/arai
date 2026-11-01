import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** Small popover menu: arrow keys move, Esc closes, click outside closes. */
export function Menu({ label, items, icon }: { label: string; items: MenuItem[]; icon?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', close);
    requestAnimationFrame(() => wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const els = Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown') els[(i + 1) % els.length]?.focus();
    else if (e.key === 'ArrowUp') els[(i - 1 + els.length) % els.length]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="menu" ref={wrap} onKeyDown={onKey}>
      <button ref={button} type="button" className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon ?? <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="6" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18" cy="12" r="1.6" /></svg>}
      </button>
      {open && (
        <ul className="menu-list" role="menu" aria-label={label}>
          {items.map((it) => (
            <li key={it.label} role="none">
              <button type="button" role="menuitem" className={it.danger ? 'danger' : undefined} onClick={() => (setOpen(false), it.onSelect())}>
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
