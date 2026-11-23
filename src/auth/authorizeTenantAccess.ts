export type Role = "OWNER" | "STAFF";

export type Membership = {
  userId: string;
  tenantId: string;
  role: Role;
  status: "ACTIVE" | "INACTIVE";
};

export type MembershipRepository = {
  find(userId: string, tenantId: string): Membership | undefined;
};

export function authorizeTenantAccess(
  deps: { memberships: MembershipRepository },
  request: { userId: string; tenantId: string },
): { role: Role } {
  if (
    typeof request.userId !== "string" ||
    request.userId.trim() === ""
  ) {
    throw new Error("UNAUTHENTICATED");
  }
  const membership = deps.memberships.find(request.userId, request.tenantId);
  if (!membership || membership.status !== "ACTIVE") {
    throw new Error("FORBIDDEN");
  }
  return { role: membership.role };
}
