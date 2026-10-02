import type { InvitePreview } from '@myday/shared';
import { useLoad } from './api';

/** Landing page for an invite link: greet them, then Google sign-in with the invited email. */
export default function Join({ token }: { token: string }) {
  const { data, error } = useLoad<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`);
  return (
    <div className="login">
      <img src="/icons/myday-icon-192.png" alt="" width={96} height={96} />
      <h1>MyDay</h1>
      {error && <p className="error-light">{error}</p>}
      {data && (
        <>
          <p>Hi {data.name} — you're invited to your family's MyDay.</p>
          <p className="muted">Sign in with the Google account {data.email}.</p>
          <a className="btn" href="/api/auth/google">
            Sign in with Google
          </a>
        </>
      )}
    </div>
  );
}
