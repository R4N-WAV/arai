import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItem } from './Menu';

export interface MenuPoint {
  x: number;
  y: number;
  /** Opened by a long press: the finger is still down, so the menu waits for it to lift. */
  touch: boolean;
}

const HOLD_MS = 420;
const SLOP = 10;

/**
 * Opens a menu the way each platform expects: right click (or the menu key /
 * Shift+F10) on a computer, press and hold on a phone. Spread the returned
 * props on the element.
 */
export function useContextTrigger<T>(open: (target: T, at: MenuPoint) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => cancel, []);
  return (target: T) => ({
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      // Links, players and fields keep the browser's own menu.
      if ((e.target as HTMLElement).closest('a, audio, video, input, textarea')) return;
      e.preventDefault();
      if (!fired.current) open(target, { x: e.clientX, y: e.clientY, touch: false });
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      fired.current = false;
      if (e.pointerType === 'mouse') return;
      start.current = { x: e.clientX, y: e.clientY };
      cancel();
      timer.current = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(8);
        open(target, { ...start.current, touch: true });
      }, HOLD_MS);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    // The tap that ends a long press must not also press whatever is under the finger.
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (fired.current) {
        fired.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey) || e.key === 'Enter') {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        open(target, { x: r.left + Math.min(r.width / 2, 160), y: r.top + Math.min(r.height, 40), touch: false });
      }
    },
  });
}

/** A menu at a point on screen (a bottom sheet on phones). Esc, a click outside or choosing something closes it. */
export function ContextMenu({ at, label, items, header, onClose }: { at: MenuPoint; label: string; items: MenuItem[]; header?: ReactNode; onClose: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: at.x, y: at.y });
  const [armed, setArmed] = useState(!at.touch);
  const returnTo = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at.x, at.y]);

  useEffect(() => {
    if (armed) {
      list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
      return;
    }
    const arm = () => setArmed(true);
    window.addEventListener('pointerup', arm, { once: true });
    window.addEventListener('pointercancel', arm, { once: true });
    const t = setTimeout(arm, 1500);
    return () => {
      window.removeEventListener('pointerup', arm);
      window.removeEventListener('pointercancel', arm);
      clearTimeout(t);
    };
  }, [armed]);

  const close = () => {
    onClose();
    returnTo.current?.focus?.({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape' || e.key === 'Tab') close();
    else if (e.key === 'ArrowDown') els[(i + 1) % els.length]?.focus();
    else if (e.key === 'ArrowUp') els[(i - 1 + els.length) % els.length]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div className="ctx" onKeyDown={onKey}>
      <div className="ctx-backdrop" onPointerDown={() => armed && close()} onContextMenu={(e) => (e.preventDefault(), close())} />
      <div ref={list} className={`menu-list ctx-menu${armed ? '' : ' unarmed'}`} role="menu" aria-label={label} style={{ '--x': `${pos.x}px`, '--y': `${pos.y}px` } as React.CSSProperties}>
        {header}
        {items.map((it) => (
          <button key={it.label} type="button" role="menuitem" className={it.danger ? 'danger' : undefined} onClick={() => (close(), it.onSelect())}>
            {it.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
