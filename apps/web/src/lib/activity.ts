import type { NotificationDto } from '@arai/shared';
import { useEffect, useState } from 'react';
import { api } from './api';

/** Unread notification count, refreshed on navigation and every minute while visible. */
export function useUnread(dep: unknown): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      api<{ unread: number }>('GET', '/notifications').then((r) => alive && setN(r.unread)).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [dep]);
  return n;
}

export function describe(n: NotificationDto): { text: string; to: string | null } {
  const who = n.actor ? `@${n.actor}` : 'Someone';
  switch (n.kind) {
    case 'invite':
      return { text: `${who} invited you to a project`, to: '/' };
    case 'comment':
      return { text: `${who} commented in a project`, to: n.targetId ? `/projects/${n.targetId}` : null };
    case 'follow':
      return { text: `${who} followed you`, to: n.actor ? `/u/${n.actor}` : null };
    case 'friend_request':
      return { text: `${who} wants to be friends`, to: n.actor ? `/u/${n.actor}` : null };
    case 'friend_accept':
      return { text: `${who} accepted your friend request`, to: n.actor ? `/u/${n.actor}` : null };
    case 'message':
      return { text: `New message from ${who}`, to: n.targetId ? `/messages/${n.targetId}` : '/messages' };
    case 'moderation':
      return { text: 'A moderator reviewed something of yours', to: null };
  }
}
