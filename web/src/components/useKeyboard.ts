/**
 * Phones: when the on-screen keyboard opens, the bottom tab bar hides behind
 * it (standard iOS behavior) instead of riding up above the keyboard, and
 * bars that should ride up (the Ask Hana input) can sit on top of it.
 *
 * Sets on <html>:
 *   .kb-open       while a text field is focused on a touch device
 *   --kb-inset     how much of the layout the keyboard covers (visualViewport)
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

export function useKeyboardLayout(): void {
  useEffect(() => {
    const root = document.documentElement;
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const vv = window.visualViewport;
    let raf = 0;
    const sync = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const inset = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
        root.style.setProperty('--kb-inset', `${inset}px`);
        const tabs = document.querySelector<HTMLElement>('nav.tabs');
        const shown = tabs && getComputedStyle(tabs).display !== 'none' ? tabs.offsetHeight : 0;
        if (!root.classList.contains('kb-open')) root.style.setProperty('--tabs-h', `${shown}px`);
      });
    };
    const onIn = (e: FocusEvent): void => {
      if (touch && isTextField(e.target as Element)) root.classList.add('kb-open');
      sync();
    };
    const onOut = (): void => {
      // Focus may be moving to another field: check after it settles.
      window.setTimeout(() => {
        if (!isTextField(document.activeElement)) {
          root.classList.remove('kb-open');
          sync();
        }
      }, 120);
    };
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    vv?.addEventListener('resize', sync);
    vv?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
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
      ro?.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf);
      root.classList.remove('kb-open');
    };
  }, []);
}
