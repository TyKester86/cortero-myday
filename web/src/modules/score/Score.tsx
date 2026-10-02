import type { ScoreSource, ScoreSummary } from '@myday/shared';
import { useLoad, withMember } from '../../api';
import { XpBar } from '../../components/XpBar';
import { useSession } from '../../session';

const SOURCE_LABEL: Record<ScoreSource, string> = {
  chore: 'Chore',
  homework: 'Homework',
  perfect_week: 'Perfect week',
  bonus: 'Bonus',
  habit: 'Habit',
};

export default function Score() {
  const { viewing } = useSession();
  const { data, error } = useLoad<ScoreSummary>(viewing ? withMember('/api/score', viewing.key) : null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const pw = data.perfectWeek;

  return (
    <section>
      <h1>{data.member.name}'s points</h1>
      <div className="bigscore">
        <b data-testid="score-total">{data.totalPoints}</b>
        <small>points earned</small>
      </div>
      <XpBar xp={data.xp} />
      <div className="stats">
        <div className="stat">
          <b>{data.todayPoints}</b>
          <small>today</small>
        </div>
        <div className="stat">
          <b>{data.weekPoints}</b>
          <small>this week</small>
        </div>
        <div className="stat">
          <b data-testid="bank">{data.bank}</b>
          <small>to spend</small>
        </div>
      </div>

      <div className="card">
        <h2>Perfect Week</h2>
        {pw.alreadyAwarded ? (
          <p>Earned this week: +{pw.bonus} 🎉</p>
        ) : pw.clean ? (
          <p>Perfect week so far. Keep every chore done through Sunday and the week's points double.</p>
        ) : (
          <p className="muted">Every scheduled chore Mon–Sun plus no hanging homework doubles the week. Next week is a fresh start.</p>
        )}
      </div>

      {data.streak && (
        <div className="card">
          <h2>Streak</h2>
          <div className="stats">
            <div className="stat">
              <b>{data.streak.current}</b>
              <small>current</small>
            </div>
            <div className="stat">
              <b>{data.streak.longest}</b>
              <small>longest</small>
            </div>
            <div className="stat">
              <b>{data.streak.shields}</b>
              <small>shields</small>
            </div>
          </div>
        </div>
      )}

      {data.daily && (
        <div className="card">
          <div className="ex-head">
            <h2>Today's score</h2>
            <b>{data.daily.total}/100</b>
          </div>
          {data.dailyHistory.length > 1 && (
            <div className="spark" aria-label="Last 30 days">
              {data.dailyHistory.map((h) => (
                <i key={h.date} title={`${h.date}: ${h.total}`} style={{ height: `${Math.max(4, h.total)}%` }} className={h.total === 100 ? 'hot' : ''} />
              ))}
            </div>
          )}
        </div>
      )}

      {data.achievements.length > 0 && (
        <div className="card" data-testid="achievements">
          <h2>
            Achievements{' '}
            <small className="muted">
              {data.achievements.filter((a) => a.unlocked).length}/{data.achievements.length}
            </small>
          </h2>
          {data.newlyUnlocked.length > 0 && <p className="good">New: {data.newlyUnlocked.join(', ')} 🎉</p>}
          <ul className="achievements">
            {data.achievements.map((a) => (
              <li key={a.name} className={a.unlocked ? 'on' : ''} title={a.desc}>
                <b>{a.name}</b>
                <small>
                  {a.desc}
                  {a.xp > 0 && ` · +${a.xp} XP`}
                  {a.date && ` · ${a.date}`}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>Recent</h2>
      {data.recent.length === 0 ? (
        <p className="muted">No points yet — check off a chore to start.</p>
      ) : (
        <ul className="plain rows">
          {data.recent.map((r) => (
            <li key={r.id}>
              <span>
                {r.note || SOURCE_LABEL[r.source]} <span className="muted">· {r.date}</span>
              </span>
              <b>+{r.points}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
