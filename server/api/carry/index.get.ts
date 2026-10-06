import { resolveSession } from "../../utils/authSession";
import { listCarry } from "../../utils/carryRepo";
import { setPrivate } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
export default defineEventHandler(async (event) => {
  setPrivate(event);
  await rateLimit(event, "carry-read");
  const user = await resolveSession(event);
  if (!user) throw createError({ statusCode: 401 });
  return { requests: await listCarry(user) };
});
