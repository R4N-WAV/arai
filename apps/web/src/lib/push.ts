/** Phone/desktop notifications for this device (Web Push, opt-in). */
import { api } from './api';

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(): Promise<void> {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('permission_denied');
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api<{ key: string }>('GET', '/push/key');
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource }));
  await api('POST', '/push/subscriptions', { endpoint: sub.endpoint });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('DELETE', '/push/subscriptions', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

/** Keeps the app icon badge in step with unread activity and messages. */
export function setBadge(n: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (n > 0) void nav.setAppBadge?.(n).catch(() => undefined);
  else void nav.clearAppBadge?.().catch(() => undefined);
}
