import { api } from './api';

/** Sign out on this device: end the session and don't leave this person's cached data behind. */
export async function signOut(): Promise<void> {
  await api('/api/auth/logout', 'POST').catch(() => undefined);
  navigator.serviceWorker?.controller?.postMessage('clear-api');
  try {
    localStorage.removeItem('myday.offline-queue');
  } catch {
    /* ignore */
  }
  window.location.href = '/';
}
