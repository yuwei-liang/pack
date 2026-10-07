import { getHeader, getRequestURL } from "h3";
import { requireAccount } from "../../utils/authSession";
import { readJsonBodyCapped } from "../../utils/http";
import { saveCarryMember, removeCarryMember } from "../../utils/carryMembers";
export default defineEventHandler(async (event) => {
  const { user } = await requireAccount(event, "mutate");
  const origin = getHeader(event, "origin");
  if (origin && origin !== getRequestURL(event).origin)
    throw createError({ statusCode: 403 });
  const body = await readJsonBodyCapped<Record<string, unknown>>(event, 5000);
  if (body?.action === "save")
    await saveCarryMember(user.id, { name: body.name, email: body.email });
  else if (body?.action === "remove")
    await removeCarryMember(user.id, body.email);
  else throw createError({ statusCode: 400 });
  return { ok: true };
});
