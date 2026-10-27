import { useState } from 'react';
import type { HanaBrief as Brief, HanaBriefItem, HanaBriefKind, HanaItemOutcome } from '@myday/shared';
import { api, useLoad } from '../../api';
import { HanaFace } from '../../components/NavIcon';

const asOf = (iso: string): string => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** One item: what Hana saw, where it came from, and three quiet buttons (her needle learns from them). */
function Item({ item, onMark }: { item: HanaBriefItem; onMark: (o: HanaItemOutcome) => void }) {
  return (
    <li className={`hana-item${item.headsUp ? ' heads-up' : ''}${item.outcome ? ` is-${item.outcome}` : ''}`} data-testid={`hana-item-${item.category}`}>
      <span className="hana-item-text">{item.text}</span>
      {item.check && (
        <small className="hana-check" data-testid="hana-check">
          Check: {item.check}
        </small>
      )}
      <small className="muted hana-source">
        {item.source} · as of {asOf(item.asOf)}
      </small>
      {item.outcome ? (
        <small className="muted">{item.outcome === 'acted' ? 'Done ✓' : item.outcome === 'dismissed' ? 'Not now' : 'Marked wrong — thanks, that goes in the family report'}</small>
      ) : (
        <span className="hana-item-actions">
          <button type="button" className="link" onClick={() => onMark('acted')} data-testid="hana-acted">
            Done
          </button>
          <button type="button" className="link" onClick={() => onMark('dismissed')} data-testid="hana-dismissed">
            Not now
          </button>
          <button type="button" className="link" onClick={() => onMark('wrong')} data-testid="hana-wrong">
            That’s wrong
          </button>
        </span>
      )}
    </li>
  );
}

const KIND_LABEL: Record<HanaBriefKind, string> = { morning: 'Morning', evening: 'Evening look-ahead', weekly: 'This week' };

/** Hana's brief for whoever is signed in (parents: the family board; a kid: their own day). */
export function HanaBriefCard({ kinds = ['morning', 'evening', 'weekly'], compact = false }: { kinds?: HanaBriefKind[]; compact?: boolean }) {
  const [kind, setKind] = useState<HanaBriefKind | null>(null);
  const { data, error, setData } = useLoad<Brief>(`/api/hana/brief${kind ? `?kind=${kind}` : ''}`);
  if (error) return null;
  if (!data) return <div className="card muted">Hana is putting your day together…</div>;
  const mark = async (id: number, outcome: HanaItemOutcome): Promise<void> => {
    await api(`/api/hana/items/${id}/outcome`, 'POST', { outcome });
    setData({ ...data, sections: data.sections.map((s) => ({ ...s, items: s.items.map((i) => (i.id === id ? { ...i, outcome } : i)) })) });
  };
  const sections = compact ? data.sections.slice(0, 3) : data.sections;
  return (
    <div className="card hana-brief" data-testid="hana-brief" data-view={data.view}>
      <div className="hana-brief-head">
        <HanaFace size={36} />
        <div>
          <b>{data.greeting}</b>
          <small className="muted"> {KIND_LABEL[data.kind]}</small>
        </div>
      </div>
      {kinds.length > 1 && (
        <div className="chips" role="group" aria-label="Which brief">
          {kinds.map((k) => (
            <button key={k} type="button" className={data.kind === k ? 'chip on' : 'chip'} aria-pressed={data.kind === k} onClick={() => setKind(k)} data-testid={`hana-kind-${k}`}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}
      {sections.length === 0 ? (
        <p className="muted">Nothing needs you right now. Enjoy it.</p>
      ) : (
        sections.map((s) => (
          <section key={s.title} className="hana-section">
            <h3>{s.title}</h3>
            <ul className="hana-items">
              {s.items.map((i) => (
                <Item key={i.id} item={i} onMark={(o) => void mark(i.id, o)} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
