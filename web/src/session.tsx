import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { HouseholdMember, HouseholdResponse, Me } from '@myday/shared';
import { api, ApiFail } from './api';

interface SessionState {
  me: Me;
  members: HouseholdMember[];
  /** Whose day a grown-up may open: themselves and the kids (never another grown-up). */
  viewable: HouseholdMember[];
  /** Whose day is on screen. Adults can switch to a kid; kids always see their own. */
  viewing: HouseholdMember | null;
  setViewing: (key: string) => void;
  isAdult: boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

const VIEW_KEY = 'myday.viewing';

function readViewing(): string | null {
  try {
    return localStorage.getItem(VIEW_KEY);
  } catch {
    return null;
  }
}

/**
 * Identity comes from the server session (/api/me). Nothing about who you are
 * is stored in the browser — that's what fixes the old "asks my name and
 * role every time" bug.
 */
export function SessionProvider({ signedOut, children }: { signedOut: ReactNode; children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [status, setStatus] = useState<'loading' | 'in' | 'out' | 'error'>('loading');
  const [viewKey, setViewKey] = useState<string | null>(readViewing);

  useEffect(() => {
    api<Me>('/api/me')
      .then(async (m) => {
        setMe(m);
        // Signed in but no household yet → onboarding (nothing to list).
        if (m.household) setMembers((await api<HouseholdResponse>('/api/household')).members);
        setStatus('in');
      })
      .catch((e: unknown) => setStatus(e instanceof ApiFail && e.status === 401 ? 'out' : 'error'));
  }, []);

  if (status === 'loading') return <div className="center muted">Loading…</div>;
  if (status === 'out') return <>{signedOut}</>;
  if (status === 'error' || !me) return <div className="center muted">Could not reach MyDay. Try again in a moment.</div>;

  const isAdult = me.member?.kind === 'adult';
  // A grown-up can open their own day and the kids' — never another grown-up's.
  const viewable = isAdult ? members.filter((m) => m.key === me.member?.key || m.kind === 'kid') : me.member ? [me.member] : [];
  const viewing = (isAdult && viewable.find((m) => m.key === viewKey)) || me.member;
  const setViewing = (key: string): void => {
    setViewKey(key);
    try {
      localStorage.setItem(VIEW_KEY, key);
    } catch {
      /* per-device convenience only */
    }
  };

  return (
    <SessionContext.Provider value={{ me, members, viewable, viewing, setViewing, isAdult }}>{children}</SessionContext.Provider>
  );
}
