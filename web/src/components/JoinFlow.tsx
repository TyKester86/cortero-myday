import { useEffect, useState } from 'react';
import type { JoinPreview } from '@myday/shared';
import { api } from '../api';
import { useConfirm } from './Confirm';

/** Preview → (confirm if leaving a household) → join. Used on signup, the invite page and the sign-in prompt. */
export function useJoin(): {
  preview: (token: string) => Promise<JoinPreview>;
  join: (token: string, p: JoinPreview) => Promise<boolean>;
  msg: string | null;
} {
  const confirm = useConfirm();
  const [msg, setMsg] = useState<string | null>(null);
  const preview = (token: string): Promise<JoinPreview> => api<JoinPreview>(token ? `/api/join/preview?token=${encodeURIComponent(token)}` : '/api/join/preview');
  const join = async (token: string, p: JoinPreview): Promise<boolean> => {
    setMsg(null);
    if (p.outcome === 'already_member') {
      setMsg(p.explanation);
      return false;
    }
    if (p.outcome !== 'join') {
      const ok = await confirm({
        title: `Leave ${p.current?.name ?? 'your household'} and join ${p.household}?`,
        body: p.explanation,
        confirmLabel: 'Leave and join',
        danger: p.outcome === 'merge_household',
      });
      if (!ok) return false;
    }
    try {
      const r = await api<{ explanation: string; household: string }>('/api/join', 'POST', { token, leave: p.outcome !== 'join' });
      setMsg(`Welcome to ${r.household}. ${r.explanation}`);
      window.setTimeout(() => (window.location.href = '/'), 1200);
      return true;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not join');
      return false;
    }
  };
  return { preview, join, msg };
}

/** "Were you invited? Join an existing household" — paste the link or code. */
export function JoinBox() {
  const { preview, join, msg } = useJoin();
  const [input, setInput] = useState('');
  const [p, setP] = useState<JoinPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const look = async (): Promise<void> => {
    setErr(null);
    setP(null);
    try {
      setP(await preview(input));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That link didn’t work');
    }
  };
  return (
    <div className="card" data-testid="join-box">
      <h2>Were you invited?</h2>
      <p className="small">Join an existing household instead of starting a new one. Paste the invite link (or the code at the end of it).</p>
      <div className="inline">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://…/join/…" aria-label="Invite link or code" />
        <button className="btn small" disabled={!input.trim()} onClick={() => void look()}>
          Check
        </button>
      </div>
      {err && <p className="error">{err}</p>}
      {p && (
        <div data-testid="join-preview">
          <p className="small">{p.explanation}</p>
          <button className="btn" onClick={() => void join(input, p)}>
            Join {p.household}
          </button>
        </div>
      )}
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}

/** After signing in through an invite to another household: ask before anything moves. */
export function PendingInvitePrompt({ household }: { household: string }) {
  const { preview, join, msg } = useJoin();
  const [p, setP] = useState<JoinPreview | null>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    void preview('').then(setP).catch(() => setOpen(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  return (
    <div className="overlay" role="dialog" aria-modal="true" data-testid="pending-invite">
      <div className="firstrun">
        <h2>You’re invited to {household}</h2>
        <p className="small">{p ? p.explanation : 'Checking…'}</p>
        {msg && <p role="status">{msg}</p>}
        <div className="confirm-actions">
          <button className="btn small ghost" onClick={() => void api('/api/join/dismiss', 'POST').then(() => setOpen(false))}>
            Not now
          </button>
          <button className="btn small" disabled={!p} onClick={() => p && void join('', p)}>
            Leave mine and join
          </button>
        </div>
      </div>
    </div>
  );
}

/** The invite page for someone already signed in. */
export function SignedInJoin({ token }: { token: string }) {
  const { preview, join, msg } = useJoin();
  const [p, setP] = useState<JoinPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    preview(token).then(setP, (e: unknown) => setErr(e instanceof Error ? e.message : 'This invite isn’t valid'));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="landing" data-testid="signed-in-join">
      <h1>Join {p?.household ?? 'a household'}</h1>
      {err && <p className="error">{err}</p>}
      {p && <p>{p.explanation}</p>}
      {p && p.outcome !== 'already_member' && (
        <button className="btn" onClick={() => void join(token, p)}>
          {p.outcome === 'join' ? `Join ${p.household}` : 'Leave mine and join'}
        </button>
      )}
      {msg && <p role="status">{msg}</p>}
      <p>
        <a href="/">Back to MyDay</a>
      </p>
    </div>
  );
}
