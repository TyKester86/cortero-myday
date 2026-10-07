/**
 * Phones: when the on-screen keyboard opens, the bottom tab bar hides behind
 * it (standard iOS behavior) instead of riding up above the keyboard, and
 * bars that should ride up (the Ask Hana input) sit directly on top of it.
 *
 * Positions come from the VISUAL viewport only (window.visualViewport): iOS
 * Safari doesn't shrink the layout viewport for the keyboard, and depending on
 * the version reports window.innerHeight as either the full or the shrunken
 * height — so nothing here relies on innerHeight. The visual viewport's bottom
 * edge (offsetTop + height, in layout-viewport coordinates, which is what
 * position:fixed uses) is the top of the keyboard.
 *
 * Sets on <html>:
 *   .kb-open       while a text field is focused on a touch device
 *   --vv-bottom    where the visible area ends (the top of the keyboard)
 *   --kb-inset     how much of the layout the keyboard covers
 *   --tabs-h       the bottom tab bar's height (0 when there isn't one)
 */
import { useEffect } from 'react';

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden']);
export function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) return !NOT_TEXT.has(el.type) && !el.readOnly;
  return el instanceof HTMLElement && el.isContentEditable;
}

/** How long the keyboard takes to slide in or out (iOS ≈ 250–400 ms), tracked frame by frame. */
const ANIMATION_MS = 900;

export function useKeyboardLayout(): void {
  useEffect(() => {
    const root = document.documentElement;
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const vv = window.visualViewport;

    const measure = (): void => {
      // The layout viewport (iOS keeps it full height while the keyboard is up).
      const layoutH = root.clientHeight;
      const bottom = vv ? vv.offsetTop + vv.height : layoutH;
      root.style.setProperty('--vv-bottom', `${Math.round(bottom)}px`);
      root.style.setProperty('--kb-inset', `${Math.max(0, Math.round(layoutH - bottom))}px`);
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
      const until = performance.now() + ANIMATION_MS;
      const step = (): void => {
        measure();
        if (performance.now() < until) follow = requestAnimationFrame(step);
      };
      follow = requestAnimationFrame(step);
    };

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
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    vv?.addEventListener('resize', sync);
    vv?.addEventListener('scroll', sync);
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
      vv?.removeEventListener('resize', sync);
      vv?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync);
      ro?.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf);
      cancelAnimationFrame(follow);
      root.classList.remove('kb-open');
    };
  }, []);
}
