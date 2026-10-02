import type { AuthKind, HouseholdMember } from '@myday/shared';

declare global {
  namespace Express {
    interface Request {
      user?: { id: number; email: string; name: string; auth: AuthKind };
      member?: HouseholdMember | null;
    }
  }
}

export {};
