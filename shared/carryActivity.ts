import { acceptedCarryUnit, type CarryRequest } from "./carry";
export interface CarryActivity {
  recipient: string;
  status: "pending" | "accepted";
  name: string;
}
export function carryActivity(
  requests: CarryRequest[],
  code?: string | null,
): Map<string, CarryActivity> {
  const map = new Map<string, CarryActivity>();
  for (const r of requests)
    if (r.outgoing && r.sourceCode === code && !r.cancelled)
      for (const u of r.units)
        if (!u.unavailable && u.decision !== "declined")
          for (const g of u.gear)
            map.set(g.id, {
              recipient: r.recipientName,
              status: acceptedCarryUnit(u) ? "accepted" : "pending",
              name: g.name,
            });
  return map;
}
export function carrySummary(r: CarryRequest): string {
  if (r.cancelled) return "已撤回";
  const counts = new Map<string, number>();
  for (const u of r.units) {
    const state = u.unavailable
      ? "已删除"
      : u.needsReview
        ? "需重新确认"
        : { pending: "待确认", accepted: "已接手", declined: "已婉拒" }[
            u.decision
          ];
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].map(([state, n]) => `${n} 件／套${state}`).join(" · ");
}
