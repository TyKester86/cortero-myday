import { useState } from 'react';
import { api, ApiFail, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { ago } from '../../dates';

/** Settings → Your data: download it, delete your account, or delete the whole household. */
export function YourData({ householdName }: { householdName: string }) {
  const confirm = useConfirm();
  const [typed, setTyped] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);

  const deleteMe = async (): Promise<void> => {
    if (!(await confirm({ title: 'Delete your account?', body: 'Your own check-ins, tasks, health and notes are deleted for good. Shared lists stay with the household.', confirmLabel: 'Delete my account', danger: true }))) return;
    try {
      await api('/api/account?confirm=DELETE', 'DELETE');
      window.location.href = '/';
    } catch (e) {
      setMsg(e instanceof ApiFail && e.code === 'last_adult' ? e.message : e instanceof Error ? e.message : 'Could not delete');
      if (e instanceof ApiFail && e.code === 'last_adult') setShowDelete(true);
    }
  };
  const deleteHousehold = async (): Promise<void> => {
    try {
      await api(`/api/household?confirm=${encodeURIComponent(typed)}`, 'DELETE');
      window.location.href = '/';
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not delete');
    }
  };

  return (
    <div className="card" data-testid="your-data">
      <h2>Your data</h2>
      <p className="small muted">
        It’s yours. Download a copy any time, or delete it. Read the <a href="/privacy">privacy policy</a> and <a href="/terms">terms</a>.
      </p>
      <div className="row">
        <a className="btn small ghost" href="/api/account/export" download data-testid="export-data">
          Download my data
        </a>
        <button className="btn small ghost" onClick={() => void deleteMe()} data-testid="delete-account">
          Delete my account
        </button>
        <button className="link small" onClick={() => setShowDelete(!showDelete)}>
          Delete the whole household…
        </button>
      </div>
      {showDelete && (
        <div className="card warn" data-testid="delete-household">
          <p className="small">
            This deletes <b>{householdName}</b> and everything in it — every person, kid, list, plan, photo and recording — and unlinks any banks. It can’t be undone.
          </p>
          <label className="small">
            Type <b>{householdName}</b> to confirm
            <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Household name to confirm" />
          </label>
          <button className="btn small danger" disabled={typed !== householdName} onClick={() => void deleteHousehold()}>
            Delete everything
          </button>
        </div>
      )}
      {msg && <p className="small warn">{msg}</p>}
    </div>
  );
}

interface ConsentKids {
  kids: Array<{ key: string; name: string; age: number | null; needsConsent: boolean; consentAt: string | null }>;
}

/** A parent turns on the AI helpers (homework helper, lecture notes) for kids under 13. */
export function KidAiConsent() {
  const { data, setData } = useLoad<ConsentKids>('/api/household/ai-consent');
  const confirm = useConfirm();
  const young = data?.kids.filter((k) => k.needsConsent) ?? [];
  if (!young.length) return null;
  const set = async (key: string, consent: boolean): Promise<void> => {
    if (
      consent &&
      !(await confirm({
        title: 'Turn on AI helpers?',
        body: 'The homework helper and lecture notes send what your child types or records to an AI provider (Anthropic; OpenAI for audio) to make the answer or the notes. Recordings are deleted once the notes are made. You can turn this off any time.',
        confirmLabel: 'I’m their parent — turn on',
      }))
    )
      return;
    await api(`/api/household/members/${key}/ai-consent`, 'POST', { consent });
    if (data) setData({ kids: data.kids.map((k) => (k.key === key ? { ...k, consentAt: consent ? new Date().toISOString() : null } : k)) });
  };
  return (
    <div className="card" data-testid="ai-consent">
      <h2>AI helpers for kids under 13</h2>
      <p className="small muted">Off until you say so. The homework helper and lecture notes use an AI provider; younger kids need a parent’s OK first.</p>
      <ul className="plain">
        {young.map((k) => (
          <li key={k.key} className="row small" style={{ alignItems: 'center' }}>
            <span className="grow">
              <b>{k.name}</b>
              {k.age !== null && <span className="muted"> · {k.age}</span>}
              <span className="muted"> · {k.consentAt ? `on since ${ago(k.consentAt)}` : 'off'}</span>
            </span>
            <button className={k.consentAt ? 'btn small ghost' : 'btn small'} onClick={() => void set(k.key, !k.consentAt)} data-testid={`ai-consent-${k.key}`}>
              {k.consentAt ? 'Turn off' : 'Turn on'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
