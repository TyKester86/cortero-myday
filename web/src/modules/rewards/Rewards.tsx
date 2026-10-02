import { useState, type FormEvent } from 'react';
import type { NewReward, Redemption, RewardAdminResponse, RewardStore } from '@myday/shared';
import { api, useLoad, withMember } from '../../api';
import { useToast } from '../../components/useToast';
import { useSession } from '../../session';

const STATUS: Record<Redemption['status'], string> = {
  pending: 'Waiting for a grown-up',
  approved: 'Approved ✓',
  denied: 'Not this time (points back)',
};

/** Kids: the store. Grown-ups: approvals + managing rewards. */
export default function Rewards() {
  const { isAdult } = useSession();
  return isAdult ? <RewardsAdmin /> : <RewardStorePage />;
}

function RewardStorePage() {
  const { viewing } = useSession();
  const { data, error, setData } = useLoad<RewardStore>(viewing ? withMember('/api/rewards', viewing.key) : null);
  const { toast, show } = useToast();
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const redeem = async (id: number, name: string): Promise<void> => {
    try {
      setData(await api<RewardStore>(`/api/rewards/${id}/redeem`, 'POST'));
      show(`Asked for ${name} — a grown-up will approve it`);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not send');
    }
  };

  return (
    <section>
      <h1>Rewards</h1>
      <div className="bigscore">
        <b data-testid="bank">{data.bank}</b>
        <small>points to spend</small>
      </div>
      {data.rewards.length === 0 && <p className="muted">No rewards yet — ask a grown-up to add some.</p>}
      <ul className="plain rows">
        {data.rewards.map((r) => (
          <li key={r.id}>
            <span>
              {r.name} <span className="muted">· {r.cost} pts</span>
            </span>
            <button className="btn small" disabled={data.bank < r.cost} onClick={() => void redeem(r.id, r.name)}>
              {data.bank < r.cost ? `${r.cost - data.bank} to go` : 'Get it'}
            </button>
          </li>
        ))}
      </ul>
      {data.redemptions.length > 0 && (
        <>
          <h2>My requests</h2>
          <ul className="plain rows">
            {data.redemptions.map((d) => (
              <li key={d.id}>
                <span>
                  {d.rewardName} <span className="muted">· {d.requestedOn}</span>
                </span>
                <small className={d.status === 'pending' ? 'warn' : 'muted'}>{STATUS[d.status]}</small>
              </li>
            ))}
          </ul>
        </>
      )}
      {toast}
    </section>
  );
}

function RewardsAdmin() {
  const { members } = useSession();
  const kids = members.filter((m) => m.kind === 'kid');
  const { data, error, setData } = useLoad<RewardAdminResponse>('/api/rewards/admin');
  const [name, setName] = useState('');
  const [cost, setCost] = useState(50);
  const [forKid, setForKid] = useState<number | null>(null);
  const { toast, show } = useToast();
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const act = async (p: Promise<RewardAdminResponse>, msg: string): Promise<void> => {
    try {
      setData(await p);
      show(msg);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not save');
    }
  };

  const add = (e: FormEvent): void => {
    e.preventDefault();
    const body: NewReward = { name, cost, memberId: forKid };
    void act(api<RewardAdminResponse>('/api/rewards', 'POST', body), 'Reward added').then(() => setName(''));
  };

  return (
    <section>
      <h1>Rewards</h1>
      <div className="card">
        <h2>Waiting for approval</h2>
        {data.pending.length === 0 && <p className="muted">Nothing waiting.</p>}
        <ul className="plain rows" data-testid="pending">
          {data.pending.map((d) => (
            <li key={d.id}>
              <span>
                <b>{d.memberName}</b>: {d.rewardName} <span className="muted">· {d.cost} pts · {d.requestedOn}</span>
              </span>
              <span>
                <button className="btn small" onClick={() => void act(api(`/api/redemptions/${d.id}/approve`, 'POST'), 'Approved')}>
                  Approve
                </button>{' '}
                <button className="link danger" onClick={() => void act(api(`/api/redemptions/${d.id}/deny`, 'POST'), 'Denied — points returned')}>
                  Deny
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <form className="card form" onSubmit={add}>
        <h2>Add a reward</h2>
        <label>
          Reward
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="30 min extra screen time" required />
        </label>
        <label>
          Cost (points)
          <input type="number" min={1} value={cost} onChange={(e) => setCost(Number(e.target.value))} />
        </label>
        <label>
          For
          <select value={forKid ?? ''} onChange={(e) => setForKid(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Every kid</option>
            {kids.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn">Add reward</button>
      </form>

      <h2>The store</h2>
      <ul className="plain rows">
        {data.rewards.map((r) => (
          <li key={r.id}>
            <span>
              {r.name} <span className="muted">· {r.cost} pts · {r.memberName ?? 'every kid'}</span>
            </span>
            <button className="link danger" onClick={() => void act(api(`/api/rewards/${r.id}`, 'DELETE'), 'Removed')}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {toast}
    </section>
  );
}
