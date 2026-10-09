/**
 * MyDay and the Feed are one web app served on two domains: MyDay's, and the Feed's own (the standalone,
 * installable Feed app). The server says in the page which one this is and where the other lives.
 */
const meta = (name: string): string => (document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? '').replace(/\/$/, '');

/** This page is the standalone Feed app (its own domain). */
export const FEED_APP = meta('myday-app-mode') === 'feed';
/** Where MyDay lives. */
export const APP_URL = meta('myday-app-url');
/** Where the Feed app lives ('' when there is no separate Feed app). */
export const FEED_URL = meta('myday-feed-url');

/** Is that address another site than this page's? */
export function elsewhere(url: string): boolean {
  try {
    return !!url && new URL(url).origin !== window.location.origin;
  } catch {
    return false;
  }
}

/* ---------- Add to Home Screen ---------- */

export interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let installPrompt: InstallPrompt | null = null;
/** The browser offers to install (Chrome, Edge, Android): keep the offer for our own Install button. */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e as InstallPrompt;
  window.dispatchEvent(new Event('feed-install-ready'));
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  window.dispatchEvent(new Event('feed-install-ready'));
});

export const pendingInstall = (): InstallPrompt | null => installPrompt;
export const clearInstall = (): void => {
  installPrompt = null;
};

/** Already running as the installed app (home-screen icon). */
export function standalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone/iPad Safari: no install prompt; people add it from the Share menu. */
export function iosSafari(): boolean {
  const ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}
