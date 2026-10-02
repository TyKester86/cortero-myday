import type { AuthKind, HouseholdMember } from '@myday/shared';

declare global {
  namespace Express {
    interface Request {
      user?: { id: number; email: string; name: string; auth: AuthKind };
      member?: HouseholdMember | null;
      /** The household this request is pinned to (set by loadUser). */
      householdId?: number;
    }
  }
}

export {};
