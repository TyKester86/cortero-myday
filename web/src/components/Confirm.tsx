import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * In-page confirmation (replaces native confirm(), which is clumsy on phones
 * and silently auto-dismissed by automated browsers).
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Remove "Dishes"?', confirmLabel: 'Remove', danger: true }))) return;
 */
export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type Ask = (o: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask | null>(null);

export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error('useConfirm outside ConfirmProvider');
  return ask;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  const ask = useCallback<Ask>((o) => new Promise<boolean>((resolve) => setPending({ ...o, resolve })), []);

  const close = useCallback(
    (ok: boolean) => {
      pending?.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  useEffect(() => {
    if (!pending) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, close]);

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {pending && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && close(false)}>
          <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" data-testid="confirm">
            <h2 id="confirm-title">{pending.title}</h2>
            {pending.body && <p className="muted">{pending.body}</p>}
            <div className="confirm-actions">
              <button className="btn ghost" onClick={() => close(false)} data-testid="confirm-cancel">
                {pending.cancelLabel ?? 'Cancel'}
              </button>
              <button
                ref={okRef}
                className={pending.danger ? 'btn danger' : 'btn'}
                onClick={() => close(true)}
                data-testid="confirm-ok"
              >
                {pending.confirmLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
