/**
 * Append-only product events (launch cohorts later). Every module calls
 * logEvent(); it never throws and never blocks the user's action.
 */
import { pool } from '../db.js';

export type EventName =
  | 'signup'
  | 'household_created'
  | 'onboarding_step'
  | 'signin'
  | 'kid_onboarded'
  | 'kid_signin'
  | 'invite_sent'
  | 'invite_accepted'
  | 'module_used'
  | 'hana_asked'
  | 'hana_action'
  | 'chore_done'
  | 'homework_done'
  | 'reward_redeemed'
  | 'lecture_recorded'
  | 'build_chosen'
  | 'bank_linked'
  | 'push_subscribed'
  | 'offline_synced'
  | 'focus_done'
  | 'quest_claimed'
  | 'hana_action_confirmed'
  | 'notification_sent'
  | 'quick_note'
  | 'billing_change'
  | 'household_deleted'
  | 'circle_post'
  | 'circle_moderation';

export async function logEvent(
  name: EventName,
  props: Record<string, string | number | boolean | null> = {},
  memberId: number | null = null,
  householdId?: number | null,
): Promise<void> {
  try {
    if (householdId === undefined) {
      await pool.query('INSERT INTO events (name, props, member_id) VALUES ($1, $2, $3)', [name, JSON.stringify(props), memberId]);
    } else {
      await pool.query('INSERT INTO events (name, props, member_id, household_id) VALUES ($1, $2, $3, $4)', [
        name,
        JSON.stringify(props),
        memberId,
        householdId,
      ]);
    }
  } catch (e) {
    console.error('logEvent failed', name, e instanceof Error ? e.message : e);
  }
}
