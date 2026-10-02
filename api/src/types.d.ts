import type { HouseholdMember } from '@myday/shared';

declare global {
  namespace Express {
    interface Request {
      user?: { id: number; email: string; name: string };
      member?: HouseholdMember | null;
    }
  }
}

export {};
