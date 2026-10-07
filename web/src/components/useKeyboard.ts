/**
 * Phones: when the on-screen keyboard opens, the bottom tab bar hides behind
 * it (standard iOS behavior) instead of riding up above the keyboard, and
 * full-screen views (Ask Hana) fit exactly into what's still visible.
 *
 * Positions come from the VISUAL viewport only (window.visualViewport): iOS
 * Safari doesn't shrink the layout viewport for the keyboard, pans the visible
 * area instead, and depending on the version reports window.innerHeight as
 * either the full or the shrunken height — so nothing here relies on it.
 *
 * Sets on <html>:
 *   .kb-open       while a text field is focused on a touch device (never left
 *                  stuck: re-checked on every change and after navigation —
 *                  a focused field removed from the page sends no blur on iOS)
 *   --vv-top       how far iOS has panned the visible area down (layout px)
 *   --vv-h         the visible height (above the keyboard)
 *   --vv-bottom    where the visible area ends (the top of the keyboard)
 *   --kb-inset     how much of the layout the keyboard covers
 *   --tabs-h       the bottom tab bar's height (0 when there isn't one)
 */
import { useEffect } from 'react';

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden']);
export function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled && el.isConnected;
  if (el instanceof HTMLInputElement) return !NOT_TEXT.has(el.type) && !el.readOnly && !el.disabled && el.isConnected;
  return el instanceof HTMLElement && el.isContentEditable;
}

/** How long the keyboard takes to slide in or out (iOS ≈ 250–400 ms), tracked frame by frame. */
const ANIMATION_MS = 900;

let trackNow: () => void = () => undefined;
/** Re-measure now and for the next few frames (e.g. after a view with a focused field goes away). */
export function keyboardSync(): void {
  trackNow();
}

export function useKeyboardLayout(): void {
  useEffect(() => {
    const root = document.documentElement;
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const vv = window.visualViewport;

    const measure = (): void => {
      // A field that was focused when its view went away leaves no blur behind (focus falls to the page):
      // never let the flag stick. Focus moving to a button mid-tap is left to onOut, after the tap lands —
      // changing the layout between press and release would swallow the tap.
      const active = document.activeElement;
      if (root.classList.contains('kb-open') && (!active || active === document.body || !active.isConnected)) root.classList.remove('kb-open');
      // The layout viewport (iOS keeps it full height while the keyboard is up).
      const layoutH = root.clientHeight;
      const top = vv ? Math.max(0, vv.offsetTop) : 0;
      const h = vv ? vv.height : layoutH;
      root.style.setProperty('--vv-top', `${Math.round(top)}px`);
      root.style.setProperty('--vv-h', `${Math.round(h)}px`);
      root.style.setProperty('--vv-bottom', `${Math.round(top + h)}px`);
      root.style.setProperty('--kb-inset', `${Math.max(0, Math.round(layoutH - top - h))}px`);
      const tabs = document.querySelector<HTMLElement>('nav.tabs');
      const shown = tabs && getComputedStyle(tabs).display !== 'none' ? tabs.offsetHeight : 0;
      if (!root.classList.contains('kb-open')) root.style.setProperty('--tabs-h', `${shown}px`);
    };

    let raf = 0;
    const sync = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    // Follow the keyboard every frame while it slides (resize events alone arrive late on iOS).
    let follow = 0;
    const track = (): void => {
      cancelAnimationFrame(follow);
      measure();
      const until = performance.now() + ANIMATION_MS;
      const step = (): void => {
        measure();
        if (performance.now() < until) follow = requestAnimationFrame(step);
      };
      follow = requestAnimationFrame(step);
    };
    trackNow = track;

    const onIn = (e: FocusEvent): void => {
      if (touch && isTextField(e.target as Element)) root.classList.add('kb-open');
      track();
    };
    const onOut = (): void => {
      // Focus may be moving to another field: check after it settles.
      window.setTimeout(() => {
        if (!isTextField(document.activeElement)) {
          root.classList.remove('kb-open');
          track();
        }
      }, 120);
    };
    // Back/forward (including iOS's edge swipe) swaps the view: re-check once it has.
    const onNav = (): void => {
      window.setTimeout(track, 0);
      window.setTimeout(track, 200);
    };
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    window.addEventListener('popstate', onNav);
    window.addEventListener('pageshow', onNav);
    // The visible area changing (keyboard sliding, iOS panning): apply it right away, in the same frame — a frame late is a visible jiggle.
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    const watchTabs = (): void => {
      const tabs = document.querySelector('nav.tabs');
      if (tabs && ro) ro.observe(tabs);
    };
    watchTabs();
    const mo = new MutationObserver(() => {
      watchTabs();
      sync();
    });
    mo.observe(document.body, { childList: true, subtree: false });
    sync();
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('pageshow', onNav);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync);
      ro?.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf);
      cancelAnimationFrame(follow);
      trackNow = () => undefined;
      root.classList.remove('kb-open');
    };
  }, []);
}
