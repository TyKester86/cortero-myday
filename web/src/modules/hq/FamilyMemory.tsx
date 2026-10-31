/**
 * C9 in Family HQ: everything Hana keeps about the family — the household memory and each kid's
 * own — for a parent to see whole, correct, and forget. Another grown-up's own memory isn't here.
 */
import { useState, type FormEvent } from 'react';
import { FAMILY_MEMORY_KINDS, type FamilyMemory, type FamilyMemoryKind, type FamilyMemoryView } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';

const kindLabel = new Map(FAMILY_MEMORY_KINDS.map((k) => [k.kind, k.label]));
const day = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function provenance(m: FamilyMemory): string {
  const kept = `${m.via === 'hana' ? 'kept from a chat with' : 'added by'} ${m.addedBy ?? 'someone'}, ${day(m.at)}`;
  return m.correctedAt ? `${kept} · corrected by ${m.correctedBy ?? 'someone'}, ${day(m.correctedAt)}` : kept;
}

function Row({ m, onChange }: { m: FamilyMemory; onChange: (p: Promise<unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editing?.trim()) return;
    await onChange(api(`/api/hana/family-memory/${m.id}`, 'PATCH', { fact: editing.trim() }));
    setEditing(null);
  };
  return (
    <li data-testid="family-memory">
      {editing !== null ? (
        <form className="inline mem-edit" onSubmit={(e) => void save(e)}>
          <input value={editing} onChange={(e) => setEditing(e.target.value)} maxLength={300} aria-label="Correct what Hana keeps" autoFocus />
          <button className="btn small" data-testid="family-memory-save">
            Save
          </button>
          <button type="button" className="link small" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          <span>
            {m.shared && <span className="mem-kind">{kindLabel.get(m.kind)}</span>} {m.fact}
            <small className="muted"> · {provenance(m)}</small>
          </span>
          <span className="mem-tools">
            <button className="link small" onClick={() => setEditing(m.fact)} data-testid="family-memory-edit">
              Correct
            </button>
            <button className="link danger small" onClick={() => void onChange(api(`/api/hana/family-memory/${m.id}`, 'DELETE'))} data-testid="family-memory-forget">
              Forget
            </button>
          </span>
        </>
      )}
    </li>
  );
}

export function FamilyMemoryCard() {
  const { members } = useSession();
  const { data, reload } = useLoad<FamilyMemoryView>('/api/hana/family-memory');
  const [fact, setFact] = useState('');
  const [kind, setKind] = useState<FamilyMemoryKind>('preference');
  const [about, setAbout] = useState('');
  const [wiping, setWiping] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!data) return null;
  const run = async (p: Promise<unknown>): Promise<void> => {
    setErr(null);
    try {
      await p;
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t save');
    }
  };
  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!fact.trim()) return;
    await run(api('/api/hana/family-memory', 'POST', { fact: fact.trim(), kind, aboutId: about ? Number(about) : null }));
    setFact('');
  };
  const people = members;
  // Grouped by who it's about: the whole family first, then each person in roster order.
  const groups = [{ id: null as number | null, name: 'The whole family' }, ...people.map((p) => ({ id: p.id as number | null, name: p.name }))]
    .map((g) => ({ ...g, items: data.household.filter((m) => m.aboutId === g.id) }))
    .filter((g) => g.items.length);
  const total = data.household.length + data.kids.reduce((n, k) => n + k.memories.length, 0);
  return (
    <div className="card family-memory" data-testid="hq-memory">
      <h2>What Hana keeps ({total})</h2>
      <p className="muted small">
        The family memory she works from — sizes, likes, teachers and doctors, school facts, medical basics, what worked. Fix anything wrong or out of date, or forget it. It never
        leaves this family. Each grown-up’s own memory stays theirs, on their Ask Hana page.
      </p>
      {!total && <p className="muted">Nothing yet. Tell her in chat (“Avery wears a youth medium”) or add it here.</p>}
      {groups.map((g) => (
        <div key={g.id ?? 'family'} data-testid="family-memory-group">
          <h3 className="ing-head">{g.name}</h3>
          <ul className="plain rows">
            {g.items.map((m) => (
              <Row key={m.id} m={m} onChange={run} />
            ))}
          </ul>
        </div>
      ))}
      {data.kids
        .filter((k) => k.memories.length)
        .map((k) => (
          <div key={k.id} data-testid="family-memory-kid">
            <h3 className="ing-head">What {k.name} told Hana</h3>
            <ul className="plain rows">
              {k.memories.map((m) => (
                <Row key={m.id} m={m} onChange={run} />
              ))}
            </ul>
          </div>
        ))}
      <form className="inline wrap" onSubmit={(e) => void add(e)}>
        <input value={fact} onChange={(e) => setFact(e.target.value)} maxLength={300} placeholder="Something the family relies on…" aria-label="Add to the family memory" />
        <select value={kind} onChange={(e) => setKind(e.target.value as FamilyMemoryKind)} aria-label="Kind">
          {FAMILY_MEMORY_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        <select value={about} onChange={(e) => setAbout(e.target.value)} aria-label="About">
          <option value="">The whole family</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn small ghost" disabled={!fact.trim()} data-testid="family-memory-add">
          Keep
        </button>
      </form>
      <div className="mem-wipe">
        {wiping === null ? (
          <select value="" onChange={(e) => e.target.value && setWiping(Number(e.target.value))} aria-label="Forget everything about someone" data-testid="family-memory-wipe">
            <option value="">Forget everything about…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="small">
            Forget everything the family memory holds about {people.find((p) => p.id === wiping)?.name}
            {people.find((p) => p.id === wiping)?.kind === 'kid' ? ', and what they told Hana themselves' : ''}?{' '}
            <button
              className="btn small danger"
              data-testid="family-memory-wipe-yes"
              onClick={() => {
                const id = wiping;
                setWiping(null);
                void run(api(`/api/hana/family-memory/forget-about/${id}`, 'POST'));
              }}
            >
              Forget it all
            </button>{' '}
            <button className="link small" onClick={() => setWiping(null)}>
              Keep it
            </button>
          </p>
        )}
      </div>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}
