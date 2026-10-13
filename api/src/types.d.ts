import type { AuthKind, HouseholdMember } from '@myday/shared';

declare global {
  namespace Express {
    interface Request {
      user?: { id: number; email: string; name: string; auth: AuthKind };
      member?: HouseholdMember | null;
      /** The household this request is pinned to (set by loadUser). */
      householdId?: number;
      /** Set on /api/v1 (The Feed Publishing API) by the bearer check: the app acting, for whom, with which scopes. */
      apiAuth?: { appId: number; appName: string; userId: number; authorizationId: number; tokenId: number; scopes: string[] };
    }
  }
}

export {};
