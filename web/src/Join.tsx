import type { InvitePreview, Me } from '@myday/shared';
import { useLoad } from './api';
import { SignedInJoin } from './components/JoinFlow';

/** Landing page for an invite link: greet them, then Google sign-in with the invited email. */
export default function Join({ token }: { token: string }) {
  const me = useLoad<Me>('/api/me');
  const { data, error } = useLoad<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`);
  // Already signed in (maybe with a household of your own): join in the app, with a confirm if leaving one.
  if (me.data) return <SignedInJoin token={token} />;
  if (me.loading) return <div className="center muted">Loading…</div>;
  return (
    <div className="login">
      <img src="/icons/myday-icon-192.png" alt="" width={96} height={96} />
      <h1>MyDay</h1>
      {error && <p className="error-light">{error}</p>}
      {data && (
        <>
          <p>Hi {data.name} — you're invited to your family's MyDay.</p>
          <p className="muted">Sign in with the Google account {data.email}.</p>
          {/* Carry the invite through Google sign-in — without it, people landed on "Set up your household". */}
          <a className="btn" href={`/api/auth/google?invite=${encodeURIComponent(token)}`}>
            Sign in with Google
          </a>
        </>
      )}
    </div>
  );
}
