import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { createError } from "h3";
import { randomUUID } from "node:crypto";
import { lists, listClaims, users } from "../db/schema";
import { useAccountDb, isUniqueViolation, type Db } from "./db";
import { memoized } from "./memoize";
import {
  carryGear,
  liveCarryUnit,
  selectedCarryRoots,
  type CarryRequest,
  type CarryUnit,
} from "../../shared/carry";

export const CARRY_DDL = [
  `CREATE TABLE IF NOT EXISTS carry_requests (
 id text PRIMARY KEY, sender_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, recipient_email text NOT NULL,
 source_list_id integer NOT NULL REFERENCES lists(id) ON DELETE CASCADE, recipient_name text NOT NULL,
 trip_title text NOT NULL, note text NOT NULL DEFAULT '', reply text NOT NULL DEFAULT '',
 units jsonb NOT NULL, cancelled boolean NOT NULL DEFAULT false, destination_list_id integer REFERENCES lists(id) ON DELETE SET NULL,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS carry_reservations (source_list_id integer NOT NULL REFERENCES lists(id) ON DELETE CASCADE, item_id text NOT NULL,
 request_id text NOT NULL REFERENCES carry_requests(id) ON DELETE CASCADE, PRIMARY KEY(source_list_id,item_id))`,
  `CREATE INDEX IF NOT EXISTS carry_inbox ON carry_requests(recipient_email, created_at DESC)`,
];
const ensure = memoized(async (db: Db) => {
  for (const stmt of CARRY_DDL) await db.execute(sql.raw(stmt));
});
export async function carryDb() {
  const db = await useAccountDb();
  await ensure(db);
  return db;
}
type Row = {
  id: string;
  sender_id: number;
  recipient_email: string;
  source_list_id: number;
  destination_list_id: number | null;
  recipient_name: string;
  trip_title: string;
  note: string;
  reply: string;
  units: CarryUnit[];
  cancelled: boolean;
  version: number;
  created_at: Date | string;
};
function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? result) as T[];
}
export async function carryRow(db: Db, id: string): Promise<Row | null> {
  return (
    rows<Row>(
      await db.execute(sql`SELECT * FROM carry_requests WHERE id=${id}`),
    )[0] ?? null
  );
}
async function source(db: Db, id: number) {
  return (
    await db
      .select()
      .from(lists)
      .where(and(eq(lists.id, id), isNull(lists.deletedAt)))
  )[0];
}
async function requireIdentity(
  db: Db,
  user: { id: number; email: string | null },
) {
  const identity = (
    await db
      .select({ verified: users.emailVerified, email: users.email })
      .from(users)
      .where(eq(users.id, user.id))
  )[0];
  if (!identity?.verified || !user.email || identity.email !== user.email)
    throw createError({
      statusCode: 403,
      statusMessage: "请先使用邮箱中的登录链接验证账户",
    });
}
export async function listCarry(user: { id: number; email: string | null }) {
  const db = await carryDb();
  await requireIdentity(db, user);
  const rs = rows<Row>(
    await db.execute(
      sql`SELECT * FROM carry_requests WHERE sender_id=${user.id} OR recipient_email=${user.email ?? ""} ORDER BY created_at DESC`,
    ),
  );
  if (!rs.length) return [];
  const sourceIds = [
    ...new Set(
      rs.flatMap((r) => [
        r.source_list_id,
        ...(r.destination_list_id ? [r.destination_list_id] : []),
      ]),
    ),
  ];
  const sources = await db
    .select()
    .from(lists)
    .where(and(inArray(lists.id, sourceIds), isNull(lists.deletedAt)));
  const senders = await db
    .select({ id: users.id, name: users.displayName })
    .from(users)
    .where(inArray(users.id, [...new Set(rs.map((r) => r.sender_id))]));
  const bySource = new Map(sources.map((s) => [s.id, s]));
  const bySender = new Map(senders.map((s) => [s.id, s.name]));
  return rs.map((r) => {
    const src = bySource.get(r.source_list_id);
    const outgoing = r.sender_id === user.id;
    // Recipients never receive the source code, capability, or unselected gear.
    // Senders never receive the recipient's own list code either.
    return {
      id: r.id,
      senderName: bySender.get(r.sender_id) || "同行者",
      recipientEmail: r.recipient_email,
      recipientName: r.recipient_name,
      tripTitle: r.trip_title,
      note: r.note,
      reply: r.reply,
      createdAt: new Date(r.created_at).toISOString(),
      cancelled: r.cancelled,
      sourceCode: outgoing ? src?.shareCode : undefined,
      destinationCode: outgoing
        ? undefined
        : bySource.get(r.destination_list_id ?? -1)?.shareCode,
      units: r.units.map((u) => {
        const live = liveCarryUnit(
          u,
          !outgoing && r.cancelled
            ? { folders: [], items: [] }
            : (src?.data ?? { folders: [], items: [] }),
        );
        return outgoing
          ? { ...live, groups: {}, packed: {}, order: [], positions: undefined }
          : live;
      }),
      outgoing,
      version: r.version,
    } satisfies CarryRequest;
  });
}
export async function createCarry(
  user: { id: number; email: string | null },
  hash: string,
  input: {
    email: string;
    name: string;
    ids: string[];
    note: string;
    listVersion?: number;
  },
) {
  const db = await carryDb();
  await requireIdentity(db, user);
  const src = (
    await db
      .select()
      .from(lists)
      .where(and(eq(lists.editTokenHash, hash), isNull(lists.deletedAt)))
  )[0];
  if (!src) throw createError({ statusCode: 404 });
  if (input.listVersion !== undefined && input.listVersion !== src.version)
    throw createError({
      statusCode: 409,
      statusMessage: "清单有更新，请刷新后重试",
    });
  if (input.ids.some((id) => !src.data.items.some((i) => i.id === id)))
    throw createError({
      statusCode: 400,
      statusMessage: "部分装备尚未保存，请稍后重试",
    });
  if (input.email === user.email)
    throw createError({ statusCode: 400, statusMessage: "不能向自己请求背负" });
  const ids = selectedCarryRoots(src.data, input.ids);
  if (!ids.length || ids.length > 100)
    throw createError({ statusCode: 400, statusMessage: "请选择装备" });
  const selected = [
    ...new Set(ids.flatMap((id) => carryGear(src.data, id).map((i) => i.id))),
  ];
  const units = ids.map(
    (rootId) =>
      ({
        rootId,
        includeChildren: src.data.items.some((i) => i.parentId === rootId),
        gear: [],
        decision: "pending",
        signature: "",
        groups: {},
        packed: {},
        order: [],
      }) as CarryUnit,
  );
  const id = randomUUID();
  try {
    // One statement: a conflicting unique reservation rolls back the request too.
    const inserted = rows<{ id: string }>(
      await db.execute(sql`WITH request AS (
   INSERT INTO carry_requests(id,sender_id,recipient_email,source_list_id,recipient_name,trip_title,note,units)
   SELECT ${id},${user.id},${input.email},${src.id},${input.name},${src.title},${input.note},${JSON.stringify(units)}::jsonb
   FROM lists WHERE id=${src.id} AND version=${src.version} AND deleted_at IS NULL RETURNING id
  ), reserved AS (
   INSERT INTO carry_reservations(source_list_id,item_id,request_id)
   SELECT ${src.id},value,request.id FROM request CROSS JOIN jsonb_array_elements_text(${JSON.stringify(selected)}::jsonb)
   RETURNING request_id
  ) SELECT id FROM request`),
    );
    if (!inserted.length)
      throw createError({
        statusCode: 409,
        statusMessage: "清单有更新，请刷新后重试",
      });
  } catch (e) {
    if (isUniqueViolation(e))
      throw createError({
        statusCode: 409,
        statusMessage: "部分装备已有背负请求，请先取消原请求",
      });
    throw e;
  }
  return id;
}
export interface CarryUpdate {
  id: string;
  version: number;
  action: string;
  destinationCode?: string | null;
  units?: Array<{
    rootId: string;
    decision: string;
    signature: string;
    groups: Record<string, string>;
    packed: Record<string, boolean>;
    order: string[];
    positions?: Record<string, number>;
  }>;
  reply?: string;
}
export async function updateCarry(
  user: { id: number; email: string | null },
  input: CarryUpdate,
) {
  const db = await carryDb();
  await requireIdentity(db, user);
  const r = await carryRow(db, input.id);
  if (
    !r ||
    (r.sender_id !== user.id &&
      (!user.email || r.recipient_email !== user.email))
  )
    throw createError({ statusCode: 404 });
  if (input.version !== r.version)
    throw createError({
      statusCode: 409,
      statusMessage: "请求已被更新，请刷新",
    });
  if (r.cancelled)
    throw createError({ statusCode: 409, statusMessage: "请求已取消" });
  const src = await source(db, r.source_list_id);
  if (!src && input.action !== "cancel")
    throw createError({ statusCode: 409, statusMessage: "来源清单已删除" });
  let units = r.units;
  let cancelled = false;
  let reply = r.reply;
  let destination = r.destination_list_id;
  const sender = r.sender_id === user.id;
  if (input.action === "cancel") {
    if (!sender) throw createError({ statusCode: 403 });
    cancelled = true;
  } else {
    if (sender) throw createError({ statusCode: 403 });
    if (input.action !== "reply" && input.action !== "organize")
      throw createError({ statusCode: 400 });
    if (
      !Array.isArray(input.units) ||
      input.units.some(
        (u) => !u || typeof u !== "object" || typeof u.rootId !== "string",
      ) ||
      input.units.length !== r.units.length ||
      new Set(input.units.map((u) => u.rootId)).size !== r.units.length
    )
      throw createError({ statusCode: 400 });
    units = r.units.map((u) => {
      const change = input.units!.find((v) => v.rootId === u.rootId);
      const live = liveCarryUnit(u, src!.data);
      if (!change || typeof change !== "object")
        throw createError({ statusCode: 400 });
      if (
        input.action === "reply" &&
        (!["pending", "accepted", "declined"].includes(change.decision) ||
          (change.decision === "accepted" &&
            (change.signature !== live.signature || live.unavailable)))
      )
        throw createError({
          statusCode: 409,
          statusMessage: "装备有更新，请刷新后确认",
        });
      const allowed = new Set(live.gear.map((i) => i.id));
      const groups: Record<string, string> = {};
      const packed: Record<string, boolean> = {};
      for (const [id, g] of Object.entries(change.groups ?? {}))
        if (allowed.has(id) && typeof g === "string")
          groups[id] = g.trim().slice(0, 60) || "替别人背";
      for (const [id, p] of Object.entries(change.packed ?? {}))
        if (allowed.has(id) && typeof p === "boolean") packed[id] = p;
      const order = Array.isArray(change.order)
        ? [...new Set(change.order.filter((id) => allowed.has(id)))]
        : [];
      const positions = Object.fromEntries(
        Object.entries(change.positions ?? {}).filter(
          ([id, n]) =>
            allowed.has(id) &&
            typeof n === "number" &&
            Number.isFinite(n) &&
            Math.abs(n) < Number.MAX_SAFE_INTEGER,
        ),
      );
      return {
        ...u,
        positions,
        decision:
          input.action === "reply"
            ? (change.decision as CarryUnit["decision"])
            : u.decision,
        acceptedSignature:
          input.action === "reply" && change.decision === "accepted"
            ? live.signature
            : u.acceptedSignature,
        groups,
        packed,
        order,
      };
    });
    if (input.action === "reply")
      reply = String(input.reply ?? "")
        .trim()
        .slice(0, 1000);
    if (input.destinationCode !== undefined) {
      if (input.destinationCode === null) destination = null;
      else {
        const owned = (
          await db
            .select({ id: lists.id })
            .from(lists)
            .innerJoin(listClaims, eq(listClaims.listId, lists.id))
            .where(
              and(
                eq(listClaims.userId, user.id),
                eq(lists.shareCode, input.destinationCode),
                isNull(lists.deletedAt),
              ),
            )
        )[0];
        if (!owned)
          throw createError({
            statusCode: 403,
            statusMessage: "请选择自己账户中的清单",
          });
        if (owned.id === r.source_list_id)
          throw createError({
            statusCode: 400,
            statusMessage: "不能加入来源清单",
          });
        destination = owned.id;
      }
    }
  }
  const keep = cancelled
    ? []
    : [
        ...new Set(
          units
            .filter((u) => u.decision !== "declined")
            .flatMap((u) =>
              carryGear(src!.data, u.rootId, u.includeChildren ?? true).map(
                (i) => i.id,
              ),
            ),
        ),
      ];
  try {
    // CAS, releasing declined items, and reserving newly confirmed kit contents are atomic.
    const changed = rows<{ id: string }>(
      await db.execute(sql`WITH updated AS (
   UPDATE carry_requests SET units=${JSON.stringify(units)}::jsonb,reply=${reply},cancelled=${cancelled},destination_list_id=${destination},version=version+1
   WHERE id=${r.id} AND version=${input.version} ${src ? sql`AND EXISTS(SELECT 1 FROM lists WHERE id=${src.id} AND version=${src.version} AND deleted_at IS NULL)` : sql``} RETURNING id
  ), released AS (
   DELETE FROM carry_reservations WHERE request_id IN(SELECT id FROM updated) AND NOT(item_id IN(SELECT jsonb_array_elements_text(${JSON.stringify(keep)}::jsonb))) RETURNING item_id
  ), reserved AS (
   INSERT INTO carry_reservations(source_list_id,item_id,request_id)
   SELECT ${r.source_list_id},value,updated.id FROM updated CROSS JOIN jsonb_array_elements_text(${JSON.stringify(keep)}::jsonb)
   ON CONFLICT(source_list_id,item_id) DO UPDATE SET request_id=CASE WHEN carry_reservations.request_id=excluded.request_id THEN excluded.request_id ELSE NULL END RETURNING item_id
  ) SELECT id, (SELECT count(*) FROM reserved) AS reserved_count FROM updated`),
    );
    if (!changed.length)
      throw createError({
        statusCode: 409,
        statusMessage: "请求或装备已被更新，请刷新",
      });
  } catch (e) {
    if (
      isUniqueViolation(e) ||
      (e as { cause?: { code?: string } })?.cause?.code === "23502"
    )
      throw createError({
        statusCode: 409,
        statusMessage: "新增装备已在其他背负请求中，请联系装备主人",
      });
    throw e;
  }
}
