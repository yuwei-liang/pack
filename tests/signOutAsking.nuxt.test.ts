// @vitest-environment nuxt
//
// Sign-out and the lists this browser holds edit links for. Those outlive the
// session by design (a list needs no account), so the sign-out asks whether to
// clear them too: never asked with nothing held, cancelling keeps you signed in,
// and the lists go only when the box is ticked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import { stubLocalStorage } from "./helpers/storage";
import type { MyListEntry } from "~~/shared/types";

const storage = stubLocalStorage();

let signOuts = 0;
registerEndpoint("/api/auth/signout", { method: "POST", handler: () => (signOuts++, { ok: true }) });

const held = (code: string): MyListEntry =>
  ({ editToken: `tok-${code}`, shareCode: code, slug: code, title: code, totalMg: 0, version: 1, lastOpened: 1 }) as MyListEntry;

beforeEach(() => {
  storage.clear();
  signOuts = 0;
  useMyLists().entries.value = [];
  useClaimedLists().lists.value = [];
  useDialogs().settleConfirm(false);
});

// answer the dialog the sign-out opens, once it has opened
async function answer(ok: boolean, tick = false) {
  const d = useDialogs();
  await vi.waitFor(() => expect(d.confirmState.open).toBe(true));
  d.confirmState.checked = tick;
  d.settleConfirm(ok);
}

describe("signOutAsking", () => {
  it("signs straight out when this device holds no list", async () => {
    const res = await signOutAsking();
    expect(res).toEqual({ signedOut: true, cleared: true });
    expect(useDialogs().confirmState.open).toBe(false);
    expect(signOuts).toBe(1);
  });

  it("stays signed in when the question is cancelled", async () => {
    useMyLists().entries.value = [held("AAAA00000001")];
    const res = signOutAsking();
    await answer(false);
    expect(await res).toEqual({ signedOut: false, cleared: false });
    expect(signOuts).toBe(0);
    expect(useMyLists().entries.value).toHaveLength(1);
  });

  it("keeps the lists unless the box is ticked", async () => {
    useMyLists().entries.value = [held("AAAA00000001")];
    const res = signOutAsking();
    await answer(true);
    expect(await res).toEqual({ signedOut: true, cleared: false });
    expect(signOuts).toBe(1);
    expect(useMyLists().entries.value).toHaveLength(1);
  });

  it("clears them when it is, and says which ones the account lacks", async () => {
    useMyLists().entries.value = [held("AAAA00000001"), held("BBBB00000002")];
    useClaimedLists().lists.value = [{ shareCode: "AAAA00000001", slug: "a", title: "a" } as never];
    const res = signOutAsking();
    const d = useDialogs();
    await vi.waitFor(() => expect(d.confirmState.open).toBe(true));
    expect(d.confirmState.checkboxHint).toContain("其中 1 份不在你的账号里");
    d.confirmState.checked = true;
    d.settleConfirm(true);
    expect(await res).toEqual({ signedOut: true, cleared: true });
    expect(useMyLists().entries.value).toEqual([]);
  });
});
