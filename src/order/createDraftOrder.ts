export type OrderLine = {
  bookId: string;
  quantity: number;
  unitPriceKrw: string;
};

export type Order = {
  id: string;
  tenantId: string;
  status: "DRAFT" | "CONFIRMED";
  version: number;
  createdAt: string;
  lines: OrderLine[];
  totalKrw?: string;
  displayNumber?: number;
};

export function createDraftOrder(input: {
  tenantId: string;
  now?: () => Date;
}): Order {
  if (input.tenantId.trim() === "") {
    throw new Error("tenantId is required");
  }
  return {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    status: "DRAFT",
    version: 1,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    lines: [],
  };
}
