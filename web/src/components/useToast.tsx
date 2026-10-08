import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { EarnResult } from '@myday/shared';
import { count } from '../format';

interface Toast {
  toast: ReactElement | null;
  show: (msg: string) => void;
  earned: (e: EarnResult, pts: number) => void;
}

/** Brief bottom toast; level-ups get a louder message. */
export function useToast(): Toast {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 2400);
  }, []);

  const earned = useCallback(
    (e: EarnResult, pts: number) => {
      if (e.leveledUp) show(`Level up! Lv ${e.xp.level} · ${e.xp.title} 🎉`);
      else if (pts > 0) show(`+${count(pts, 'point')}`);
    },
    [show],
  );

  return { toast: msg ? <div className="toast">{msg}</div> : null, show, earned };
}
