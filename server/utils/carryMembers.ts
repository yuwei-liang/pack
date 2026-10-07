import { sql } from "drizzle-orm";
import { createError } from "h3";
import { carryDb } from "./carryRepo";
import { normalizeEmail } from "./authSession";
export interface CarryMember {
  name: string;
  email: string;
}
export const CARRY_MEMBERS_DDL = `CREATE TABLE IF NOT EXISTS carry_members (
 user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 email text NOT NULL, name text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,email))`;
async function dbForMembers() {
  const db = await carryDb();
  await db.execute(sql.raw(CARRY_MEMBERS_DDL));
  return db;
}
export async function listCarryMembers(userId: number): Promise<CarryMember[]> {
  const db = await dbForMembers();
  const result = await db.execute(
    sql`SELECT name,email FROM carry_members WHERE user_id=${userId} ORDER BY updated_at DESC`,
  );
  return result.rows as unknown as CarryMember[];
}
export async function saveCarryMember(
  userId: number,
  input: { name: unknown; email: unknown },
) {
  const email = normalizeEmail(input.email),
    name = typeof input.name === "string" ? input.name.trim() : "";
  if (!email || !name || name.length > 60)
    throw createError({
      statusCode: 400,
      statusMessage: "请填写成员姓名和有效邮箱",
    });
  const db = await dbForMembers();
  await db.execute(
    sql`INSERT INTO carry_members(user_id,email,name) VALUES(${userId},${email},${name}) ON CONFLICT(user_id,email) DO UPDATE SET name=EXCLUDED.name, updated_at=now()`,
  );
}
export async function removeCarryMember(userId: number, email: unknown) {
  const valid = normalizeEmail(email);
  if (!valid) throw createError({ statusCode: 400 });
  const db = await dbForMembers();
  await db.execute(
    sql`DELETE FROM carry_members WHERE user_id=${userId} AND email=${valid}`,
  );
}
