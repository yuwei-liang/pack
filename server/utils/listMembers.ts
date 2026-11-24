// Trip MEMBERS: accounts a list's owner lets into one trip.
//
// "Owner" here is an account holding a CLAIM on the list (claimRepo.ts): it took the
// list with the edit link, and the list is its own. A member is GIVEN the list by an
// owner, by email, and gets less:
//
//   - the app's doors on that one list (sync, packed, rows, items, ops) and nothing
//     else: not the web editor, not MCP, no lifecycle action, and nothing else of the
//     owner's (other lists, My Gear) — a member's token is its own account's token;
//   - the plan without its ownerOnly entries (shared/plan.ts memberPlan), and a
//     member's setPlan can neither see, overwrite nor mark one (mergeMemberPlan).
//
// The rows, bags, people and ticks are the trip's and are shared whole. A member is
// matched by an account that already exists (the email it signs in with); there are
// no pending invitations.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { listClaims, listMembers, lists, users } from "../db/schema";
import type { Db } from "./db";
import { claimedEditHash } from "./claimRepo";
import { getPlanByEditHash } from "./listRepo";
import { normalizeEmail } from "./authSession";
import { normalizeShareCode } from "../../shared/links";
import { mergeMemberPlan, type TripPlan } from "../../shared/plan";
import type { Op } from "../../shared/ops";

export const MAX_LIST_MEMBERS = 20;

export type ListRole = "owner" | "member";

/**
 * The ops an app door will apply for this role: an owner's as sent; a member's with
 * every setPlan folded onto the stored plan (read here, only when there is one).
 */
export async function opsForRole(role: ListRole, hash: string, ops: Op[]): Promise<Op[]> {
  if (role === "owner" || !ops.some((o) => o.t === "setPlan" || o.t === "checkPlanStep" || o.t === "confirmPlaceHas")) return ops;
  return memberOps(ops, (await getPlanByEditHash(hash)) ?? undefined);
}

/**
 * The list's edit hash and this account's role on it, or null (no claim, no
 * membership, not live, no such code: all the same null, so it can't probe). A claim
 * wins over a membership.
 */
export async function appListAccess(
  db: Db,
  userId: number,
  shareCode: string,
): Promise<{ hash: string; role: ListRole } | null> {
  const owned = await claimedEditHash(db, userId, shareCode);
  if (owned) return { hash: owned, role: "owner" };
  const code = normalizeShareCode(shareCode);
  if (!code) return null;
  const rows = await db
    .select({ editTokenHash: lists.editTokenHash })
    .from(lists)
    .innerJoin(listMembers, eq(listMembers.listId, lists.id))
    .where(and(eq(lists.shareCode, code), eq(listMembers.userId, userId), eq(lists.status, "active"), isNull(lists.deletedAt)))
    .limit(1);
  const hash = rows[0]?.editTokenHash;
  return hash ? { hash, role: "member" } : null;
}

/**
 * A member's ops, made safe to apply: each setPlan is folded onto the stored plan so
 * the owner-only entries survive it untouched. Every other op is the trip's and goes
 * through as it is.
 */
export function memberOps(ops: Op[], storedPlan: TripPlan | undefined): Op[] {
  let stored = storedPlan;
  return ops.flatMap((op): Op[] => {
    // a tick on a doc the member can't see doesn't land
    if (op.t === "checkPlanStep") return stored?.docs.some((d) => d.id === op.docId && d.ownerOnly) ? [] : [op];
    if (op.t === "confirmPlaceHas") return stored?.places.some((p) => p.id === op.placeId && p.ownerOnly) ? [] : [op];
    if (op.t !== "setPlan") return [op];
    const plan = mergeMemberPlan(op.plan, stored);
    stored = plan ?? undefined;
    return [{ t: "setPlan", plan }];
  });
}

async function ownedListId(db: Db, ownerId: number, shareCode: string): Promise<number | null> {
  const code = normalizeShareCode(shareCode);
  if (!code) return null;
  const rows = await db
    .select({ id: lists.id })
    .from(lists)
    .innerJoin(listClaims, eq(listClaims.listId, lists.id))
    .where(and(eq(lists.shareCode, code), eq(listClaims.userId, ownerId), eq(lists.status, "active"), isNull(lists.deletedAt)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export type AddMemberResult = "added" | "already" | "not-owner" | "no-account" | "self" | "full" | "bad-email";

/** The owner lets the account signed in as `email` into the list. */
export async function addListMember(db: Db, ownerId: number, shareCode: string, rawEmail: unknown): Promise<AddMemberResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return "bad-email";
  const listId = await ownedListId(db, ownerId, shareCode);
  if (listId == null) return "not-owner";
  const found = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  const userId = found[0]?.id;
  if (userId == null) return "no-account";
  if (userId === ownerId) return "self";
  const current = await db.select({ userId: listMembers.userId }).from(listMembers).where(eq(listMembers.listId, listId));
  if (current.some((m) => m.userId === userId)) return "already";
  if (current.length >= MAX_LIST_MEMBERS) return "full";
  await db.insert(listMembers).values({ listId, userId, addedBy: ownerId }).onConflictDoNothing();
  return "added";
}

/** The owner takes an account back out. false: not the owner, or not a member. */
export async function removeListMember(db: Db, ownerId: number, shareCode: string, rawEmail: unknown): Promise<boolean | "not-owner"> {
  const email = normalizeEmail(rawEmail);
  const listId = await ownedListId(db, ownerId, shareCode);
  if (listId == null) return "not-owner";
  if (!email) return false;
  const done = await db
    .delete(listMembers)
    .where(and(eq(listMembers.listId, listId), inArray(listMembers.userId, db.select({ id: users.id }).from(users).where(eq(users.email, email)))))
    .returning();
  return done.length > 0;
}

/** The members' emails, for the owner only; null when this account isn't an owner. */
export async function listMemberEmails(db: Db, ownerId: number, shareCode: string): Promise<string[] | null> {
  const listId = await ownedListId(db, ownerId, shareCode);
  if (listId == null) return null;
  const rows = await db
    .select({ email: users.email })
    .from(listMembers)
    .innerJoin(users, eq(users.id, listMembers.userId))
    .where(eq(listMembers.listId, listId))
    .orderBy(listMembers.createdAt);
  return rows.map((r) => r.email);
}
