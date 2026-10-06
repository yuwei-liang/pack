import { resolveSession, normalizeEmail } from "../../utils/authSession";
import { createCarry, updateCarry } from "../../utils/carryRepo";
import { requireEditHash } from "../../utils/editAuth";
import { readJsonBodyCapped, setPrivate } from "../../utils/http";
import { rateLimit, rateLimitSubject } from "../../utils/rateLimit";
import { sendCarryNotice } from "../../utils/email";
import { trustedOrigin } from "../../utils/origin";
import { listCarry } from "../../utils/carryRepo";
import { getHeader, getRequestURL } from "h3";
export default defineEventHandler(async (event) => {
  setPrivate(event);
  await rateLimit(event, "mutate");
  const origin = getHeader(event, "origin");
  if (origin && origin !== getRequestURL(event).origin)
    throw createError({ statusCode: 403 });
  const user = await resolveSession(event);
  if (!user || !user.email)
    throw createError({ statusCode: 401, statusMessage: "请用邮箱登录" });
  const body = await readJsonBodyCapped<Record<string, unknown>>(
    event,
    100_000,
  );
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw createError({ statusCode: 400 });
  if (body.action === "create") {
    const email = normalizeEmail(body.email);
    const name = String(body.name ?? "")
      .trim()
      .slice(0, 60);
    if (
      !Number.isInteger(body.listVersion) ||
      !email ||
      !name ||
      !Array.isArray(body.ids) ||
      body.ids.some((i) => typeof i !== "string")
    )
      throw createError({ statusCode: 400 });
    if (body.notify === true) await rateLimitSubject("carry-notify", email);
    const id = await createCarry(user, await requireEditHash(event), {
      email,
      name,
      ids: body.ids as string[],
      note: String(body.note ?? "").slice(0, 1000),
      listVersion: Number(body.listVersion),
    });
    let notification = "not-requested";
    if (body.notify === true) {
      try {
        const request = (await listCarry(user)).find((r) => r.id === id)!;
        await sendCarryNotice(
          email,
          user.displayName || "同行者",
          request.tripTitle,
          new URL("/carry", trustedOrigin(event)).toString(),
        );
        notification = process.env.RESEND_API_KEY ? "sent" : "development";
      } catch {
        notification = "failed";
      }
    }
    return { id, notification };
  }
  if (
    body.destinationCode !== undefined &&
    body.destinationCode !== null &&
    typeof body.destinationCode !== "string"
  )
    throw createError({ statusCode: 400 });
  if (
    typeof body.id !== "string" ||
    !Number.isInteger(body.version) ||
    Number(body.version) < 1 ||
    !["cancel", "reply", "organize"].includes(String(body.action))
  )
    throw createError({ statusCode: 400 });
  await updateCarry(user, body as unknown as Parameters<typeof updateCarry>[1]);
  return { ok: true };
});
