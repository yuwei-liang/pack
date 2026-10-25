// Signing out, with the one question it has to ask.
//
// Sign-out ends the account's half of "your lists" (useClaimedLists clears it), but
// not this browser's: the registry holds the edit links it was given, and those work
// signed out — that is how a list without an account works at all. Left unsaid, that
// read as a sign-out that hadn't happened ("why can I still see this trip?"). So when
// the registry holds any list, the sign-out says so and offers to clear it too —
// unticked by default, because a list that isn't in the account is gone for good
// once its link is forgotten here, unless you saved the link yourself.
//
// One function for both ways out (the account menu and the account view), so the
// question can't be asked in one and skipped in the other.
export async function signOutAsking(): Promise<{ signedOut: boolean; cleared: boolean }> {
  const my = useMyLists();
  const held = my.entries.value.filter((e) => e.editToken);
  let cleared = false;
  if (held.length) {
    const inAccount = new Set(useClaimedLists().lists.value.map((l) => l.shareCode));
    const onlyHere = held.filter((e) => !e.shareCode || !inAccount.has(e.shareCode)).length;
    const dialogs = useDialogs();
    const ok = await dialogs.confirm({
      title: "退出登录",
      message: `这台设备上记着 ${held.length} 份清单。退出后它们还会留在这里，不登录也能打开和编辑。`,
      confirmLabel: "退出登录",
      cancelLabel: "取消",
      checkbox: {
        label: `也从这台设备上清除这 ${held.length} 份清单`,
        hint: onlyHere
          ? `其中 ${onlyHere} 份不在你的账号里，清除后只能靠你自己存下的编辑链接找回。`
          : "它们都在你的账号里，登录后还能找回。",
      },
    });
    if (!ok) return { signedOut: false, cleared: false };
    cleared = dialogs.confirmState.checked;
  }
  await useSession().signOut(); // drops the per-account memos itself — see useSession
  // forget() also drops each list's on-device copy (useLocalListStore)
  if (cleared) for (const e of held) my.forget(e.editToken);
  return { signedOut: true, cleared: cleared || !held.length };
}
