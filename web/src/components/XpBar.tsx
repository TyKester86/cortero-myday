import type { XpStatus } from '@myday/shared';

export function XpBar({ xp }: { xp: XpStatus }) {
  return (
    <div className="xp">
      <div className="xp-head">
        <b data-testid="xp-level">
          Lv {xp.level} · {xp.title}
        </b>
        <small className="muted">
          {xp.total} XP{xp.next ? ` · ${xp.next.at - xp.total} to ${xp.next.title}` : ' · max level 🏆'}
        </small>
      </div>
      <div className="xpbar">
        <div className="xpfill" style={{ width: `${xp.pct}%` }} />
      </div>
    </div>
  );
}
