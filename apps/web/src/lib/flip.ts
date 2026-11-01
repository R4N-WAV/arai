import { useLayoutEffect, useRef } from 'react';

/**
 * FLIP list animation: children with data-flip-id glide from their old
 * position to their new one whenever the list re-renders (reorders, inserts).
 */
export function useFlip<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const last = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, DOMRect>();
    el.querySelectorAll<HTMLElement>(':scope > [data-flip-id]').forEach((child) => {
      const id = child.dataset.flipId!;
      const rect = child.getBoundingClientRect();
      next.set(id, rect);
      const prev = last.current.get(id);
      if (!reduced && prev && child.dataset.dragging !== 'true') {
        const dy = prev.top - rect.top;
        if (Math.abs(dy) > 1) child.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' });
      }
    });
    last.current = next;
  }, [dep]);
  return ref;
}
