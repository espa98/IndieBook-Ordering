import type { Membership } from "../../src/auth/authorizeTenantAccess";

export function createInMemoryMembershipRepository(initial: Membership[] = []) {
  const members = new Map<string, Membership>();
  for (const m of initial) members.set(`${m.tenantId}:${m.userId}`, m);

  return {
    find(userId: string, tenantId: string): Membership | undefined {
      return members.get(`${tenantId}:${userId}`);
    },
  };
}
