import { describe, expect, it } from "vitest";
import { applyOps } from "../shared/ops";
import { memberPlan, mergeMemberPlan, normalizePlan, type TripPlan } from "../shared/plan";
import type { ListState } from "../shared/types";
import { memberOps } from "../server/utils/listMembers";

const stay = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "stay",
  title: "妹妹家",
  start: "2026-11-24T15:00:00+07:00",
  lat: 13.7563,
  lng: 100.5018,
  ...over,
});
const near = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: "Big C",
  stayId: "s1",
  kind: "market",
  has: ["拖鞋", "超市"],
  hasConfirmed: ["超市"],
  ...over,
});

describe("places near a stay", () => {
  it("keeps a stay's coordinates and a place's stayId, kind and tags", () => {
    const plan = normalizePlan({ segments: [stay("s1")], places: [near("p1")] })!;
    expect(plan.segments[0]).toMatchObject({ lat: 13.7563, lng: 100.5018 });
    expect(plan.places[0]).toMatchObject({ stayId: "s1", kind: "market", has: ["拖鞋", "超市"], hasConfirmed: ["超市"] });
  });

  it("drops an unknown kind, out-of-range coordinates, duplicate tags and confirmations not in has", () => {
    const plan = normalizePlan({
      segments: [stay("s1", { lat: 200, lng: "x" })],
      places: [near("p1", { kind: "spa", has: ["拖鞋", " 拖鞋 ", "", 3], hasConfirmed: ["药"] })],
    })!;
    expect(plan.segments[0]!.lat).toBeUndefined();
    expect(plan.segments[0]!.lng).toBeUndefined();
    expect(plan.places[0]!.kind).toBeUndefined();
    expect(plan.places[0]!.has).toEqual(["拖鞋"]);
    expect(plan.places[0]!.hasConfirmed).toBeUndefined();
  });

  it("a place whose stay is gone, or isn't a stay, stays as a place to see", () => {
    const plan = normalizePlan({
      segments: [stay("e1", { kind: "event" })],
      places: [near("p1"), near("p2", { stayId: "e1" })],
    })!;
    expect(plan.places.map((p) => p.stayId)).toEqual([undefined, undefined]);
    expect(plan.places.map((p) => p.has)).toEqual([["拖鞋", "超市"], ["拖鞋", "超市"]]);
  });
});

it("keeps a place's local-script name, and members see it", () => {
  const plan = normalizePlan({ places: [{ id: "p1", name: "Big C", nameEn: "Big C", nameLocal: " บิ๊กซี " }] })!;
  expect(plan.places[0]!.nameLocal).toBe("บิ๊กซี");
  expect(memberPlan(plan)!.places[0]!.nameLocal).toBe("บิ๊กซี");
});

describe("members and nearby places", () => {
  const stored = normalizePlan({
    segments: [stay("s1"), stay("s2", { ownerOnly: true })],
    places: [near("p1"), near("p2", { stayId: "s2" }), near("p3", { ownerOnly: true })],
  })!;

  it("a member sees the stay's coordinates and its places; a hidden stay's places lose the link", () => {
    const view = memberPlan(stored)!;
    expect(view.segments.map((s) => s.id)).toEqual(["s1"]);
    expect(view.segments[0]!.lat).toBe(13.7563);
    expect(view.places.map((p) => [p.id, p.stayId])).toEqual([["p1", "s1"], ["p2", undefined]]);
  });

  it("a member's setPlan round trip keeps the link to the hidden stay", () => {
    const merged = normalizePlan(mergeMemberPlan(memberPlan(stored), stored))!;
    expect(merged.places.find((p) => p.id === "p2")!.stayId).toBe("s2");
    expect(merged.places.find((p) => p.id === "p3")!.ownerOnly).toBe(true);
  });

  it("a member can't confirm a tag on an owner-only place", () => {
    const ops = memberOps(
      [
        { t: "confirmPlaceHas", placeId: "p3", tag: "拖鞋", done: true },
        { t: "confirmPlaceHas", placeId: "p1", tag: "拖鞋", done: true },
      ],
      stored,
    );
    expect(ops).toEqual([{ t: "confirmPlaceHas", placeId: "p1", tag: "拖鞋", done: true }]);
  });
});

describe("confirmPlaceHas", () => {
  const state = (plan: TripPlan) => ({ items: [], folders: [], plan }) as unknown as ListState;

  it("marks a tag checked, and back to a guess, in has order", () => {
    const s = state(normalizePlan({ segments: [stay("s1")], places: [near("p1", { hasConfirmed: [] })] })!);
    applyOps(s, [{ t: "confirmPlaceHas", placeId: "p1", tag: "超市", done: true }]);
    applyOps(s, [{ t: "confirmPlaceHas", placeId: "p1", tag: "拖鞋", done: true }]);
    expect(s.plan!.places[0]!.hasConfirmed).toEqual(["拖鞋", "超市"]);
    applyOps(s, [
      { t: "confirmPlaceHas", placeId: "p1", tag: "拖鞋", done: false },
      { t: "confirmPlaceHas", placeId: "p1", tag: "超市", done: false },
    ]);
    expect(s.plan!.places[0]!.hasConfirmed).toBeUndefined();
  });

  it("ignores a tag the place doesn't have, or a place that isn't there", () => {
    const s = state(normalizePlan({ segments: [stay("s1")], places: [near("p1")] })!);
    applyOps(s, [
      { t: "confirmPlaceHas", placeId: "p1", tag: "药", done: true },
      { t: "confirmPlaceHas", placeId: "nope", tag: "拖鞋", done: true },
    ]);
    expect(s.plan!.places[0]!.hasConfirmed).toEqual(["超市"]);
  });
});
