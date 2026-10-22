# Kits in My Gear — design

Status: proposal, not implemented. Written 2026-10-22 against `origin/main` plus PR #7
(`mcp-create-list-claims-account`, unmerged). Line numbers are from `main`. PR #7 changes only
`server/utils/mcp.ts` among the files cited here, and the doc notes where it does.

The repo had no `docs/` or ADR convention before this file. `docs/design/` is new.

## 1. The problem, in the owner's data

In 摄影, My Gear holds the pieces: X-S20 body 424 g (id 337), SmallRig cage 140 g (424),
NP-W235 battery 72 g (425), two quick-release plates at 14 g each (445, 446), and the XF 16-55 II
at 453 g (4146). It also held a row typed by hand, "X-S20 + XF 16-55 II 拍摄套装" (id 4149). Its
1,117 g is that sum, typed in by hand. A second such row, "X-S20 + XF 18-55…（旧组合）" (id 68,
801 g, `times_used` 9), uses a lens that has since been sold, and nobody wrote down which
accessories it included. Both rows now sit in a stopgap folder, "摄影 · 套装".

## 2. Current model, and why each problem happens

**My Gear is flat.** `vault_items` (`server/db/schema.ts:328-379`, DDL in
`server/utils/vaultSchema.ts`) has one row per piece of gear. Its identity is `norm_key`, made
from brand + name + variant (`shared/vault.ts:163-171`). A row has one `folder_id` and nothing
that points at another row. A kit can only be another row with a typed weight.

**Lists can nest, one level deep.** A list `Item.parentId` (`shared/types.ts:49-55`) puts a row
under a parent. The reducer keeps nesting one level deep and acyclic, and a child always moves
with its parent's folder (`shared/ops.ts:582-587`, `630-650`). Deleting a parent deletes its
children (`ops.ts:621-622`). Totals add up each row's own line exactly once
(`shared/weights.ts:546-549`). A parent's weight column shows its own weight plus its children's
(`groupLineMg`, `weights.ts:260-268`). Carry selection already treats a parent as a kit
(`shared/carrySelection.ts`, `shared/carry.ts:43`).

**Capture ignores parents.** `isVaultWorthy` rejects any row that has children: "'Cook kit' is a
container, not gear" (`shared/vault.ts:173-193`, used by `captureFromList` at `268-286`). Vault
import makes the same exclusion (`shared/vaultImport.ts`, `vaultImportFromCsv`). So a group in a
list never reaches My Gear. Only its children do.

Why each of the four problems happens:

1. **You can't see what a kit contains.** No column relates one vault row to another, and
   `/gear` renders one flat row per entry inside each folder section (`app/pages/gear.vue:741-823`).
2. **Folder totals count twice.** `groupVaultRows` adds `weightMg` across every entry in a
   folder (`shared/vaultView.ts:133-140`), and the header prints that sum
   (`gear.vue:787-789`). The page total does the same over every visible row (`gear.vue:135`).
   The kit row is just another entry, so it is counted on top of its parts.
3. **A kit's weight doesn't follow its parts.** `weight_mg` is a stored number. Nothing
   recomputes it, and an edit pins it (`vaultRepo.ts` `editVaultItem`, `1049-1071`).
4. **The only guard is a note.** Adding gear to a list (`useGearList.ts:1291-1329`
   `addVaultItem`, `ItemInput.vue:314-334` `selectVault`) copies one row. The pane's "already
   in this list" check matches `norm_key` (`VaultPane.vue:244-256`). The kit and its parts have
   different keys, so nothing links them. The Categories tab adds a whole folder flat
   (`useGearList.ts:1102-1126`), so adding "摄影 · 套装" would add both kits as single rows.

**MCP.** `list_my_gear`, `add_my_gear`, `update_my_gear` and `remove_my_gear` (`mcp.ts:547-603`)
describe a gear row through `GEAR_ROW` (`322-339`) and `describeGear` (`1382-1401`), with no
relations. The list write tools take `ITEM_SCHEMA` (`mcp.ts:99-117`), which has no nesting, so an
assistant can read nested rows (`ROW`, `186-194`) but cannot write them.

## 3. Proposed model

**A kit is a vault row that points to its parts. The parts are not copied into it.**

- Add `vault_items.kind text NOT NULL DEFAULT 'piece'`, with a CHECK that it is `piece` or `kit`.
  A kit keeps everything a row already has: an id, a name and `norm_key`, a folder, the
  tombstone, search, export and pins. Existing rows all become `piece`, so nothing changes for
  them.
- Add a new table,
  `vault_kit_parts (kit_id, part_id, qty int NOT NULL DEFAULT 1, sort_order int, PRIMARY KEY (kit_id, part_id))`,
  added in `VAULT_DDL` the same idempotent way the other tables were. The repo enforces three
  rules: both rows are in the same vault, `part_id` points to a `piece`, and
  `kit_id ≠ part_id`. That gives one level of nesting, the same rule lists follow, so a kit
  always maps onto a list group.
- **A piece can belong to several kits.** It is a join table, so the same battery can be in a
  photo kit and a video kit. `qty` covers "two batteries".
- **Weight is derived.** A kit's `weight_mg` means its own weight, such as a pouch or a strap,
  and defaults to 0. The kit's weight = own + Σ(part weight × qty) over the parts that are not
  removed. It is computed at read time in `listVaultItems`/`toEntry`, which is cheap because a
  vault is at most 2,000 rows (`VAULT_ITEMS_MAX`). `VaultEntry` gains `kind`, `ownWeightMg`
  and `parts: {id, qty}[]`, and pieces gain `inKits: number[]`.
- **Re-weighing a part** changes every kit that contains it the next time it is read. If the
  battery goes from 72 to 83 g, the kit goes from 1,117 to 1,128 g. Lists already made don't
  change, because a list row is a copy (`addVaultItem` sets `weightOverridden`). That is
  today's rule too.
- **Removing a part.** A part that is put away keeps its membership and stays listed under the
  kit, marked "removed", and it **stops counting** toward the kit's weight. The kit row shows
  "1 part removed". Restoring the part brings it back with its old qty. When the reaper purges
  a vault, the purge also deletes its `vault_kit_parts` rows. Removing a kit removes only the
  kit. The pieces stay.
- **Kits are inert to capture.** Background capture fills a weight of 0
  (`vaultRepo.ts:321`). Many lists still hold the old single kit row, so without a guard the
  first capture would write 801 g or 1,117 g into a kit's own weight and count the parts twice
  again. The upsert gets `CASE WHEN kind = 'kit' THEN weight_mg …` on weight. Usage counters
  still update.

## 4. Totals without counting twice

Rule: **each piece counts once, where it is filed. A kit adds only its own weight to any total.**

- Page total (`gear.vue:135`): the sum of live pieces plus the sum of kits' own weights.
- A folder's header (`vaultView.ts:133-140`): it adds the pieces filed in that folder and the
  own weight of any kits filed there. Its count reads "6 件 · 1 套装". A folder that holds only
  kits shows no weight figure. Its tooltip says the parts are counted in their own folders.
- A kit row shows its derived weight (1,117 g) in the row, with an "=" to mark it as a sum, not
  a stored number. The heaviest/lightest sorts use the derived weight. Totals never do.

## 5. Adding a kit to a list

This reuses list nesting as it already exists. `addVaultKit(kit, folderId)` dispatches a parent
`Item` named after the kit with `unitWeightMg` = its own weight, then one child per live part,
with `parentId`, the part's qty and the part's values copied the way `addVaultItem` copies them.
The parent then shows the group total (`weights.ts:271+`). Totals stay correct
(`weights.ts:546-549`). Capture skips the parent and folds the children back onto the existing
pieces by `norm_key` (`vault.ts:188-193`), so no new rows appear.

Catching a kit and its own part in the same list:

- The pane already marks a piece "already in this list" when any row has its `norm_key`
  (`VaultPane.vue:244-256`). Child rows count too, so once the kit is in the list you can't
  add its battery again. This is today's behaviour.
- **A kit whose part is already in the list.** Adding it opens a short sheet, for example
  "NP-W235 电池 is already in this list (×1, 摄影)." It offers **Move it into the kit**
  (`moveItem` with the new `parentId`; this is the default) or **Leave it, skip that part**.
  Nothing is ever duplicated without asking. The same sheet covers a second kit that shares a
  battery with the first.
- A list row that was the old single kit row can't be detected, because nothing relates it to
  the pieces. The migration (section 8) is what fixes that.
- The autocomplete (`ItemInput.vue` `selectVault`) fills one row. Picking a kit there makes
  the row the parent and appends its parts. That needs a new `NameCommit` path, which is
  phase 3.

## 6. /gear UI (phone first, 375 px)

```
摄影                          ▾   6 件 · 1,117 g
  Fujifilm X-S20 机身            424 g   在 1 套装
  Smallrig xs20 cage             140 g   在 1 套装
  …
摄影 · 套装                   ▾   1 套装
  ▸ X-S20 + XF 16-55 II 拍摄套装  = 1,117 g   6 件
     (tap ▸)
  ▾ X-S20 + XF 16-55 II 拍摄套装  = 1,117 g
       X-S20 机身                  424
       Smallrig cage               140
       NP-W235 电池          ×1     72
       peakdesign 快拆板            14
       ulanzi 快拆板                14
       XF 16-55 II                 453
       自重 (pouch)                  0   ← only shown if > 0
```

- A kit row is collapsed by default. Its chevron state is kept per device, the same way a
  folder's is (`usePersistedCollapse`, `gear.vue:177`). Expanded, the parts are indented and
  dimmed, at 14 px text, and still fit in one line at 375 px. Tapping a part opens the part's
  own editor (`VaultItemModal`), because the part lives in its own folder. Parts are not
  moved into the kit's folder.
- A piece shows a small "在 N 套装" chip. Tapping it lists the kits it belongs to.
- **Making a kit.** Add a **Select** mode to the page's ⋯ menu. In it, each row grows a
  checkbox, the same pattern as the list's "选择物品请人背". A bottom bar then reads
  "已选 6 件 · 1,117 g · [组成套装]". Pressing it asks for a name, a folder (defaulting to the
  most common folder of the parts) and an optional own weight. A kit's editor has a "Parts"
  section: change a qty, remove a part, or "+ 添加部件", which uses the search the pane
  already has.
- **Converting a typed kit row** (⋯ on the row → "转成套装"). Pick the parts, then see a
  preview: "Typed 1,117 g · parts 1,117 g · difference 0". If the two differ, you choose:
  keep the difference as the kit's own weight, or drop it. Nothing changes until you press
  confirm.
- Flat views (search, sorts) list a kit as one row with its "=" weight. The Unfiled filter
  treats kits like any other row.

## 7. MCP

All changes add fields. Clients that ignore them keep working.

- `GEAR_ROW` gains `kind: "piece" | "kit"`. A kit's `weight_g` is **its derived total**, so an
  old client that reads `weight_g` gets the true 1,117 g. A kit also carries
  `own_weight_g` and `parts: [{id, display_name, qty, weight_g, removed}]`. A piece carries
  `in_kits: [{id, display_name}]`, which is empty when the piece belongs to no kit. The
  `list_my_gear` description gets one sentence: "A kit's weight is its parts' plus its own;
  don't add a kit and its parts to the same list."
- `add_my_gear` takes an optional `parts: [{id, qty?}]` on an item, which makes it a kit.
  `update_my_gear` takes `parts` to replace the set, and `own_weight_g`. No new tool is needed:
  the existing "Needs a read-and-write token" gate and the `already_have` dedupe still apply.
- **The hazard an old client can trip.** `update_my_gear {id: kit, weight_g: 1128}` would set
  the own weight and count the parts twice. On a kit, `weight_g` is refused with an error:
  "This is a kit; its weight is its parts'. Change a part, or set own_weight_g."
- `remove_my_gear` on a part: the result adds `in_kits` so the assistant can say which kits
  just got lighter.
- Phase 4: `ITEM_SCHEMA` (`add_items`/`create_list`) gains nested `items` (one level, mapped to
  `parentId`), and an optional `my_gear_id` (when the account has a token) that expands a kit
  the way `addVaultKit` does.

## 8. Migration (no number changes without an explicit confirm)

No automatic conversion. A row whose name contains "+" or "组合" is a hint, not proof.

- **4149 "X-S20 + XF 16-55 II 拍摄套装".** Convert it **in place**: the same id, `norm_key`
  and folder, with `kind` set to `kit`, parts 337, 424, 445, 446, 425 ×1 and 4146, and own
  weight 0. The parts add up to 1,117 g, so the number on screen doesn't change. Keeping the
  `norm_key` means a list that still holds the old single row lands on the kit row when
  captured, and the guard in §3 stops it writing a weight. The note's "不要同时加进同一份清单"
  becomes enforced and can be shortened by hand.
- **68 "旧组合".** **Don't convert it.** Its parts weren't recorded and its lens has been sold,
  so any set of parts would be invented. Leave it as a piece with its measured 801 g, and
  either keep it in "摄影 · 套装" or move it to a "已退役" folder. Its nine lists keep their
  rows, because lists are copies.
- The conversion is done through the "转成套装" flow (phase 2), or by an assistant calling
  `update_my_gear {id: 4149, parts: […]}` once phase 1 ships. Both show typed vs. sum first.
- After 4149 is converted, the 摄影 header drops from 5,729 g (counted twice) to the true sum
  of its pieces. That number changes once. The cause is the double count being removed, not
  any weight changing, and the changelog entry says so.

## 9. Interaction with PR #7's backfill

`saveToAccount` (PR #7 branch, `mcp.ts:1212-1235`) calls `backfillVaultFromClaims`
(`claimRepo.ts:208-249`), which runs `captureFromList` over every claimed list.

- **It does not create kit duplicates.** A kit in a list is a parent with children, and
  capture drops parents (`vault.ts:190`). The children upsert onto the existing pieces by
  `norm_key`.
- **It does not flatten kits.** The backfill only upserts `vault_items`. It never reads or
  writes `vault_kit_parts`.
- **Risks, and what covers them:**
  1. A list holding the old *single* kit row reaches the kit row by `norm_key`. Without the
     §3 guard, `vaultRepo.ts:321` would fill an own weight of 0. The guard is required in
     phase 1.
  2. A part renamed inside a list captures as a new piece that no kit includes. That is the
     right result, and it is visible on /gear.
  3. A part that is put away stays put away (`vaultRepo.ts` tombstone rule), so the kit keeps
     excluding it.
  4. Unrelated to kits, but noticed: the backfill calls `captureFromList(items)` with no
     folders (`claimRepo.ts:224`). Gear that is new to the account therefore arrives
     unfiled, while live editing files it by folder name.

## 10. Alternatives considered

| Option | Fixes | Doesn't fix / cost |
|---|---|---|
| **A. Convention**: a "· 套装" folder plus notes (today) | nothing structurally | Problems 2 to 4 remain. The page total still counts twice (`gear.vue:135`), and Categories adds the kit folder as single rows. |
| **B. A `kind` flag only**, kits left out of totals | 2 | No contents (1), a weight that doesn't follow (3), no guard (4). |
| **C. One parent per piece** (`parent_id` on `vault_items`, like lists) | 1, 2, 3, 4 | A battery can be in only one kit. Following the list rule, a child moves into its kit's folder, so the body leaves 摄影. Simplest schema. |
| **D. Kits as template lists** (a nested list you copy from) | 1, 4 inside a list | Copies don't follow a re-weigh (3), it lives outside /gear, and it still counts twice wherever the template's gear is shown. |
| **E. `kind` + `vault_kit_parts` (recommended)** | 1, 2, 3, 4, shared parts | One table and one guard. Totals need the "each piece once" rule, and the UI needs the "在 N 套装" chip. |

C is the fallback if the owner says shared parts don't matter. It is about one phase smaller.

## 11. Phases

**P1 — model, correct totals, read-only display, MCP (≈ M, ~400 lines + tests).** The DDL;
the repo functions (`setKitParts`, derived weight in `toEntry`, the capture guard, purge
cascade); `/api/vault/items` ops `{t:"kit", …}`; `groupVaultRows` and the page total follow the
§4 rule; /gear shows a kit collapsed and expandable with "=" weight, plus the "在 N 套装" chip;
the MCP fields from §7, the `parts` input and the `weight_g` refusal. After P1, an assistant
can convert 4149 in place.
Tests: `vault.test.ts` (derived weight; a removed part excluded; qty), `vaultView.test.ts`
(folder and page totals don't count twice), `vaultBackfill.test.ts` (a list holding the single
kit row doesn't write weight into the kit; membership survives a backfill), `mcpGear.test.ts`
(kind and parts output, an old-style `weight_g` on a kit refused, parts in another vault
refused), `gearPage.nuxt.test.ts` (kit row renders and expands).
Changelog:
`--added "Group gear in My Gear into kits: a kit lists its parts, and its weight is their sum, so re-weighing a part updates every kit it's in."`
`--fixed "A folder in My Gear no longer counts a kit's weight on top of the parts it's made of."`

**P2 — making and editing kits on /gear (≈ M).** Select mode, "组成套装", the kit editor's
Parts section, and "转成套装" with the typed-vs-sum preview.
Tests: `gearPage.nuxt.test.ts` (the select-then-make flow; a convert that shows the
difference and changes nothing on cancel).
Changelog: `--added "Select gear on My Gear and make it a kit, or turn a kit you typed by hand into one whose weight follows its parts."`

**P3 — kits into lists (≈ M).** `addVaultKit` for the pane, a kit in the Categories tab, and
the autocomplete commit path; the "already in this list" sheet.
Tests: `gearList.nuxt.test.ts` (parent plus children, qty, own weight; part already present →
move; skip), `vault.test.ts` (an added kit captures no new rows).
Changelog: `--added "Adding a kit to a list brings its parts along, nested under it, and points out a part the list already has instead of adding it twice."`

**P4 — connector writes and backups (≈ S–M).** Nested `items` and `my_gear_id` in
`add_items`/`create_list`; kits in the vault JSON export/import (`shared/exporters/vault.ts`,
`shared/vaultImport.ts`). A CSV still restores kits as pieces, and that is documented.
Tests: `mcp.test.ts`, `vaultExport.test.ts`, `vaultImport.test.ts`.
Changelog: `--added "An AI assistant can add a kit from My Gear to a list, parts and all."` and
`--changed "My Gear's JSON backup keeps your kits."`

## 12. Open questions for the owner

1. Do you need the same piece in more than one kit (E), or is one kit per piece enough (C,
   simpler, but parts move into the kit's folder)?
2. When a part is put away, should the kit stop counting it (proposed) or keep counting it
   until you edit the kit?
3. Should the old 18-55 kit (id 68) stay as a plain 801 g piece, move to "已退役 · 摄影", or be
   removed?
4. Other rows look like kits: "相机充电器+2块NP-W126S备用电池" (244 g) and "Fujifilm X100VI +
   背带" (546 g) overlap the NP-W126S battery row. Convert them too, or leave them?
5. After converting, keep the "摄影 · 套装" folder, or file each kit next to its parts in 摄影?
6. On a list, should a kit's parts be tickable one by one in packing mode (today's nested
   behaviour), or should the kit count as one tick?
7. The NP-W235 battery is listed at 72 g against a spec of 83 ± 5 g. Weigh it before
   converting, so the one visible change is the real weight and not the conversion?

### Owner's answers (2026-10-22)

1. Yes: the same piece can be in several kits. Go with option E.
2. A put-away part stops counting toward its kit.
3. Kit 68 (old 18-55, 801 g) is moved to "已退役 · 摄影" as a plain piece. Done by hand.
4. Convert "相机充电器+2块NP-W126S备用电池" (17) and "Fujifilm X100VI + 背带" (15) to kits as well.
5. Keep the "摄影 · 套装" folder for kits.
6. In packing mode, tick a kit's parts one by one (today's nested behaviour).
7. The NP-W235 (425) was weighed at 81 g. Its row and kit 4149 (now 1126 g) are already updated,
   so converting 4149 changes no numbers.
