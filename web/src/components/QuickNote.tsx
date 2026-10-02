import { useState, type FormEvent } from 'react';
import { api } from '../api';

/** Quick-note capture: one line into the brain dump, from anywhere. */
export default function QuickNote({ autoFocus = false }: { autoFocus?: boolean }) {
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const text = note.trim();
    if (!text) return;
    try {
      await api('/api/dump', 'POST', { note: text });
      setNote('');
      setMsg('Captured ✓');
    } catch (e2) {
      setMsg(e2 instanceof Error ? e2.message : 'Could not save');
      if ((e2 as { queued?: boolean }).queued) setNote('');
    }
    window.setTimeout(() => setMsg(null), 2500);
  };
  return (
    <form className="quicknote" onSubmit={(e) => void save(e)} data-testid="quick-note">
      <input id="quick-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Quick note…" maxLength={500} autoFocus={autoFocus} aria-label="Quick note" />
      <button className="btn small">Save</button>
      {msg && (
        <span className="muted small" role="status">
          {msg}
        </span>
      )}
    </form>
  );
}
