/**
 * Rewards store. Port of apiRewards / apiRedeem: a kid spends points on a
 * reward, which creates a PENDING redemption. Pending points are reserved
 * (as in the script, pending counts as spent, denied doesn't), and nothing
 * pays out until a grown-up approves. Denying refunds the points.
 */
import { Router, type Request } from 'express';
import type {
  HouseholdMember,
  Redemption,
  RedemptionStatus,
  Reward,
  RewardAdminResponse,
  RewardStore,
} from '@myday/shared';
import { pool, tx, type Db } from '../db.js';
import { today } from '../lib/dates.js';
import { HttpError, idParam, int, str } from '../lib/http.js';
import { memberById, requireAdult, self, targetMember } from '../lib/members.js';

export const rewardsRouter = Router();

/** Spendable points: everything earned minus pending + approved redemptions. */
export async function bankFor(memberId: number, db: Db = pool): Promise<number> {
  const { rows } = await db.query<{ bank: number }>(
    `SELECT (COALESCE((SELECT SUM(points) FROM scores WHERE member_id = $1), 0)
           - COALESCE((SELECT SUM(cost) FROM redemptions WHERE member_id = $1 AND status IN ('pending', 'approved')), 0))::int AS bank`,
    [memberId],
  );
  return rows[0]?.bank ?? 0;
}

interface RewardRow {
  id: number;
  name: string;
  cost: number;
  member_id: number | null;
  member_name: string | null;
}

const toReward = (r: RewardRow): Reward => ({
  id: r.id,
  name: r.name,
  cost: r.cost,
  memberId: r.member_id,
  memberName: r.member_name,
});

interface RedemptionRow {
  id: number;
  member_id: number;
  member_name: string;
  reward_name: string;
  cost: number;
  status: RedemptionStatus;
  requested_on: string;
}

const toRedemption = (r: RedemptionRow): Redemption => ({
  id: r.id,
  memberId: r.member_id,
  memberName: r.member_name,
  rewardName: r.reward_name,
  cost: r.cost,
  status: r.status,
  requestedOn: r.requested_on,
});

const REDEMPTION_SELECT = `SELECT d.id, d.member_id, m.name AS member_name, d.reward_name, d.cost, d.status, d.requested_on
  FROM redemptions d JOIN household_members m ON m.id = d.member_id`;

async function storeFor(member: HouseholdMember): Promise<RewardStore> {
  // Same filter as the script: active, and either for everyone or for this kid.
  const { rows: rewards } = await pool.query<RewardRow>(
    `SELECT r.id, r.name, r.cost, r.member_id, m.name AS member_name
       FROM rewards r LEFT JOIN household_members m ON m.id = r.member_id
      WHERE r.active AND (r.member_id IS NULL OR r.member_id = $1)
      ORDER BY r.cost, r.id`,
    [member.id],
  );
  const { rows: reds } = await pool.query<RedemptionRow>(
    `${REDEMPTION_SELECT} WHERE d.member_id = $1 ORDER BY d.id DESC LIMIT 20`,
    [member.id],
  );
  return {
    member,
    bank: await bankFor(member.id),
    rewards: rewards.map(toReward),
    redemptions: reds.map(toRedemption),
  };
}

rewardsRouter.get('/api/rewards', async (req, res) => {
  res.json(await storeFor(await targetMember(req)));
});

/** A kid asks for a reward. Points are reserved until a grown-up decides. */
rewardsRouter.post('/api/rewards/:id/redeem', async (req, res) => {
  const me = self(req);
  if (me.kind !== 'kid') throw new HttpError(403, 'The rewards store is for kids');
  const rewardId = idParam(req.params.id);
  await tx(async (c) => {
    // Serialize redemptions per kid so two quick taps can't overspend.
    await c.query('SELECT id FROM household_members WHERE id = $1 FOR UPDATE', [me.id]);
    const { rows } = await c.query<{ name: string; cost: number }>(
      'SELECT name, cost FROM rewards WHERE id = $1 AND active AND (member_id IS NULL OR member_id = $2)',
      [rewardId, me.id],
    );
    const reward = rows[0];
    if (!reward) throw new HttpError(404, 'Reward not found');
    if ((await bankFor(me.id, c)) < reward.cost) throw new HttpError(409, 'Not enough points yet');
    await c.query(
      `INSERT INTO redemptions (member_id, reward_id, reward_name, cost, requested_on) VALUES ($1, $2, $3, $4, $5)`,
      [me.id, rewardId, reward.name, reward.cost, today()],
    );
  });
  res.status(201).json(await storeFor(me));
});

/* ---------- grown-ups: manage rewards, approve / deny ---------- */

async function adminView(): Promise<RewardAdminResponse> {
  const { rows: rewards } = await pool.query<RewardRow>(
    `SELECT r.id, r.name, r.cost, r.member_id, m.name AS member_name
       FROM rewards r LEFT JOIN household_members m ON m.id = r.member_id
      WHERE r.active ORDER BY r.cost, r.id`,
  );
  const { rows: pending } = await pool.query<RedemptionRow>(
    `${REDEMPTION_SELECT} WHERE d.status = 'pending' ORDER BY d.id`,
  );
  return { rewards: rewards.map(toReward), pending: pending.map(toRedemption) };
}

rewardsRouter.get('/api/rewards/admin', async (req, res) => {
  requireAdult(req);
  res.json(await adminView());
});

rewardsRouter.post('/api/rewards', async (req, res) => {
  requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const memberId = b.memberId === null || b.memberId === undefined ? null : idParam(b.memberId);
  if (memberId !== null) {
    const m = await memberById(memberId);
    if (!m || m.kind !== 'kid') throw new HttpError(400, 'Rewards are for kids');
  }
  await pool.query('INSERT INTO rewards (name, cost, member_id) VALUES ($1, $2, $3)', [
    str(b.name, 'name', 80, true),
    int(b.cost, 'cost', 1, 100_000),
    memberId,
  ]);
  res.status(201).json(await adminView());
});

rewardsRouter.delete('/api/rewards/:id', async (req, res) => {
  requireAdult(req);
  await pool.query('UPDATE rewards SET active = false WHERE id = $1', [idParam(req.params.id)]);
  res.json(await adminView());
});

async function decide(req: Request, status: 'approved' | 'denied'): Promise<RewardAdminResponse> {
  requireAdult(req);
  const r = await pool.query(
    `UPDATE redemptions SET status = $2, decided_by = $3, decided_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [idParam(req.params.id), status, req.user?.id ?? null],
  );
  if (!r.rowCount) throw new HttpError(409, 'That request was already decided');
  return adminView();
}

rewardsRouter.post('/api/redemptions/:id/approve', async (req, res) => {
  res.json(await decide(req, 'approved'));
});

rewardsRouter.post('/api/redemptions/:id/deny', async (req, res) => {
  res.json(await decide(req, 'denied'));
});
