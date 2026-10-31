/**
 * JP2: messaging — consent first. A grown-up connects their own Messages to Hana (off by
 * default; theirs alone). Kids: safety alerts to the parents only — never their messages —
 * set by the parents, shown to the kid, off by default.
 */
import type { KidMessageSafety, MessageItem } from '@myday/shared';
import { api, useLoad } from '../../api';

interface View {
  connected: boolean;
  inbox: MessageItem[];
  kids: KidMessageSafety[];
  mine: KidMessageSafety | null;
}

export function MessagingCard() {
  const { data, reload } = useLoad<View>('/api/messages/hana');
  if (!data) return null;
  if (data.mine) {
    const m = data.mine;
    return (
      <div className="card" data-testid="messaging-card">
        <h2>Message safety</h2>
        <p className="small" data-testid="msg-safety-mine">
          {m.signalsOn
            ? `Safety alerts are on${m.setBy ? ` (set by ${m.setBy})` : ''}: if something in your messages looks unsafe, your grown-ups get a heads-up. They don’t read your messages.`
            : 'Safety alerts are off. Nobody gets alerts about your messages.'}
        </p>
      </div>
    );
  }
  return (
    <div className="card" data-testid="messaging-card">
      <h2>Messages & Hana</h2>
      <label className="row">
        <input type="checkbox" checked={data.connected} onChange={(e) => void api('/api/messages/hana', 'PUT', { connected: e.target.checked }).then(reload)} aria-label="Connect my Messages to Hana" data-testid="msg-connect" /> Let
        Hana read my Messages for me
      </label>
      <p className="muted small">
        She’ll warn you about scams, keep track of what people ask of you, and draft replies you approve. Only yours — nobody else in the family sees them. Turning it off forgets her copies.
      </p>
      {data.kids.map((k) => (
        <label key={k.memberId} className="row small">
          <input type="checkbox" checked={k.signalsOn} onChange={(e) => void api(`/api/messages/kid-safety/${k.memberId}`, 'PUT', { on: e.target.checked }).then(reload)} aria-label={`Safety alerts for ${k.member}`} /> Safety alerts for {k.member}’s
          messages — alerts only, never their words. {k.member} sees this setting and is told when it changes.
        </label>
      ))}
      {data.kids.length > 0 && <p className="muted small">MyDay doesn’t have messaging for kids yet, so there’s nothing to alert on today — this is ready for when it does.</p>}
    </div>
  );
}
