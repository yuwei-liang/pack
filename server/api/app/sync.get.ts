import { defineEventHandler } from "h3";
import { requireAppAccess } from "../../utils/appSync";
import { useVaultDb } from "../../utils/db";
import { exportClaimedLists } from "../../utils/listRepo";
import { touchVaultByUser } from "../../utils/vaultAuth";
import { listVaultFolders, listVaultItems } from "../../utils/vaultRepo";
import { listExportObject } from "../../../shared/exporters/everything";
import { vaultExportObject } from "../../../shared/exporters/vault";

// GET /api/app/sync — everything the owner's native app needs offline, for any live
// access token of the account (read or write; see appSync.ts for why the app, and
// only the app, reaches claimed lists).
//
// The shapes are the takeout's (shared/exporters/everything.ts), so there is one
// list shape and one gear shape wherever this app's data is written out:
//
//   { format: "mahonia-app-sync", version: 1, syncedAt,
//     lists: [ { shareCode, version, updatedAt, ...meta, folders, items, days,
//                waypoints, people, bags, plan? } ],
//     gear:  { folders, items } }
//
// A list's handle is `shareCode`: it is stable for the list's life (rotating the edit
// link changes the edit hash, never the share code), it is what POST /api/app/packed
// takes back, and it is not a secret. `version` rides along beside it (the takeout
// leaves it out) so the app can tell a list changed without diffing it.
//
// UNITS: every weight is integer MILLIGRAMS, exactly as stored — a list item's
// `unitWeightMg` (one unit; the line is × qty), a bag's `limitMg`, a gear entry's
// `weightMg` (on a kit, the derived total; `ownWeightMg` is the kit's own). Distances
// are metres (`trailDistanceM`, `alongM`), money is `priceCents`, food is whole
// `kcal` per unit. `displayUnit` / an item's `entryUnit` say only how to SHOW a
// weight. Ids: list items, folders, bags, people and days carry string ids (client
// generated, unique within their list); gear entries and gear folders carry integer
// ids. An item's `packed` is the row's tick; `placements: [{ bagId, qty, packed }]`
// are its shares in bags, each ticked on its own.
//
// `plan` (shared/plan.ts) is the trip's flights, stays, documents and places, present
// only when the list has one. It is owner-only: no share link carries it.
//
// A fresh account that has never captured gear has no vault row: an empty gear half,
// not an error, the same reading /gear makes.
export default defineEventHandler(async (event) => {
  const { db, userId } = await requireAppAccess(event, "read", "app-sync");
  await useVaultDb(); // the vault tables are ensured separately, see db.ts
  const vaultId = await touchVaultByUser(db, userId);
  const [lists, items, folders] = await Promise.all([
    exportClaimedLists(db, userId),
    vaultId == null ? Promise.resolve([]) : listVaultItems(db, vaultId),
    vaultId == null ? Promise.resolve([]) : listVaultFolders(db, vaultId),
  ]);
  return {
    format: "mahonia-app-sync" as const,
    version: 1 as const,
    syncedAt: new Date().toISOString(),
    lists: lists.map((l) => ({ ...listExportObject(l), version: l.version })),
    gear: vaultExportObject({ items, folders }),
  };
});
