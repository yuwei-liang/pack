import type { ListData } from "./types";

export type CarryDecision = "pending" | "accepted" | "declined";
export interface CarryGear {
  id: string;
  name: string;
  parentId: string | null;
  weightMg: number;
  qty: number;
  note: string;
}
export interface CarryUnit {
  rootId: string;
  includeChildren?: boolean;
  gear: CarryGear[];
  decision: CarryDecision;
  signature: string;
  acceptedSignature?: string;
  groups: Record<string, string>;
  packed: Record<string, boolean>;
  order: string[];
  positions?: Record<string, number>;
  unavailable?: boolean;
  needsReview?: boolean;
}
export interface CarryRequest {
  id: string;
  senderName: string;
  recipientEmail: string;
  recipientName: string;
  tripTitle: string;
  note: string;
  reply: string;
  createdAt: string;
  cancelled: boolean;
  units: CarryUnit[];
  outgoing: boolean;
  version: number;
  sourceCode?: string;
  destinationCode?: string;
}

/** A selected parent grants only its kit; a selected child never grants siblings. */
export function selectedCarryRoots(
  data: ListData,
  selected: string[],
): string[] {
  const wanted = new Set(selected);
  return data.items
    .filter((i) => wanted.has(i.id) && !(i.parentId && wanted.has(i.parentId)))
    .map((i) => i.id);
}
export function carryGear(
  data: ListData,
  rootId: string,
  includeChildren = true,
): CarryGear[] {
  const root = data.items.find((i) => i.id === rootId);
  if (!root) return [];
  return [
    root,
    ...data.items.filter((i) => includeChildren && i.parentId === rootId),
  ].map((i) => ({
    id: i.id,
    name: [i.brand, i.name, i.variant].filter(Boolean).join(" "),
    parentId: i.id === rootId ? null : (i.parentId ?? null),
    weightMg: i.unitWeightMg,
    qty: i.qty,
    note: i.description ?? "",
  }));
}
/** Identity, contents and quantities need consent again; weight corrections stay live. */
export function carrySignature(gear: CarryGear[]): string {
  return JSON.stringify(
    gear
      .map((i) => [i.id, i.name, i.parentId, i.qty])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
export function carryWeight(gear: CarryGear[]): number {
  return gear.reduce((n, i) => n + i.weightMg * i.qty, 0);
}
export function liveCarryUnit(unit: CarryUnit, data: ListData): CarryUnit {
  const gear = carryGear(data, unit.rootId, unit.includeChildren ?? true);
  const signature = carrySignature(gear);
  return {
    ...unit,
    gear,
    signature,
    unavailable: !gear.length,
    needsReview:
      unit.decision === "accepted" && signature !== unit.acceptedSignature,
  };
}
export function acceptedCarryUnit(unit: CarryUnit): boolean {
  return unit.decision === "accepted" && !unit.unavailable && !unit.needsReview;
}
