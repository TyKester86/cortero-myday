import { api } from '../../api';

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Can this browser get push at all (and is it set up on the server)? */
export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Turn on the Feed's notifications on this device: ask once (only when the person taps the button), subscribe
 * this browser, and tell the server. Returns why not, when it can't.
 */
export async function enableFeedPush(): Promise<'on' | 'denied' | 'unsupported' | 'unavailable'> {
  if (!pushSupported()) return 'unsupported';
  const key = await api<{ vapidPublicKey: string | null; configured: boolean }>('/api/feed/push/key');
  if (!key.vapidPublicKey) return 'unavailable';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key.vapidPublicKey) }));
  const j = sub.toJSON();
  await api('/api/feed/push/subscribe', 'POST', { endpoint: j.endpoint, keys: j.keys });
  return 'on';
}

/** The number on the app's home-screen icon (where the phone supports it). */
export function setBadge(n: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (n > 0) void nav.setAppBadge?.(n).catch(() => undefined);
  else void nav.clearAppBadge?.().catch(() => undefined);
}
