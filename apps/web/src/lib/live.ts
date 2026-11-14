/**
 * Keeping an open tab current. Arai has no polling: the server announces
 * changes over the realtime socket, and anything missed while the tab was
 * hidden, offline or asleep is picked up when it comes back.
 */
import type { RealtimeEvent } from '@arai/shared';
import { useEffect, useRef } from 'react';
import { useRealtime } from './messages';

export type ProjectEvent = Extract<RealtimeEvent, { type: 'project' }>;

/** Runs `fn` when the tab is looked at again, the network returns, or the realtime socket reconnects. */
export function useResume(fn: () => void, minGapMs = 8000): void {
  const { connected } = useRealtime();
  const ref = useRef(fn);
  ref.current = fn;
  const last = useRef(0);
  const wasConnected = useRef<boolean | null>(null);
  const run = useRef(() => {
    if (document.visibilityState !== 'visible' || Date.now() - last.current < minGapMs) return;
    last.current = Date.now();
    ref.current();
  });
  useEffect(() => {
    last.current = Date.now(); // whoever mounts this has just loaded
    const on = () => run.current();
    document.addEventListener('visibilitychange', on);
    window.addEventListener('focus', on);
    window.addEventListener('online', on);
    window.addEventListener('pageshow', on);
    return () => {
      document.removeEventListener('visibilitychange', on);
      window.removeEventListener('focus', on);
      window.removeEventListener('online', on);
      window.removeEventListener('pageshow', on);
    };
  }, []);
  // A socket that dropped may have missed events: catch up when it is back.
  useEffect(() => {
    if (connected && wasConnected.current === false) {
      last.current = Date.now();
      ref.current();
    }
    if (wasConnected.current !== null || connected) wasConnected.current = connected;
  }, [connected]);
}

/** Runs `fn` (debounced) when the server announces a change to a project. */
export function useProjectEvents(fn: (e: ProjectEvent) => void, delayMs = 250): void {
  const { subscribe } = useRealtime();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const off = subscribe((e) => {
      if (e.type !== 'project') return;
      const k = `${e.projectId}:${e.what}:${e.versionId ?? ''}`;
      clearTimeout(timers.get(k));
      timers.set(k, setTimeout(() => (timers.delete(k), ref.current(e)), delayMs));
    });
    return () => {
      off();
      timers.forEach((t) => clearTimeout(t));
    };
  }, [subscribe, delayMs]);
}
