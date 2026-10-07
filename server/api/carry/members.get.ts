import { requireAccount } from "../../utils/authSession";
import { listCarryMembers } from "../../utils/carryMembers";
export default defineEventHandler(async (event) => {
  const { user } = await requireAccount(event, "carry-read");
  return { members: await listCarryMembers(user.id) };
});
