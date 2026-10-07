import { isBareGroup } from "./weights";
import type { ListData } from "./types";
export function carrySelectionState(
  data: ListData,
  ids: string[],
  id: string,
): "checked" | "mixed" | "clear" {
  const item = data.items.find((i) => i.id === id);
  if (!item) return "clear";
  const selected = new Set(ids);
  if (selected.has(id) || (item.parentId && selected.has(item.parentId)))
    return "checked";
  const children = data.items.filter((i) => i.parentId === id);
  const count = children.filter((i) => selected.has(i.id)).length;
  return count && count === children.length && isBareGroup(item, true)
    ? "checked"
    : count
      ? "mixed"
      : "clear";
}
export function toggleCarrySelection(
  data: ListData,
  ids: string[],
  id: string,
  checked: boolean,
): string[] {
  const selected = new Set(
    ids.filter((id) => data.items.some((i) => i.id === id)),
  );
  for (const item of data.items)
    if (item.parentId && selected.has(item.parentId)) selected.add(item.id);
  const item = data.items.find((i) => i.id === id);
  if (!item) return [...selected];
  const children = data.items.filter((i) => i.parentId === id);
  for (const key of [id, ...children.map((i) => i.id)])
    checked ? selected.add(key) : selected.delete(key);
  if (item.parentId) {
    const siblings = data.items.filter((i) => i.parentId === item.parentId);
    if (siblings.every((i) => selected.has(i.id)) && isBareGroup(data.items.find(i=>i.id===item.parentId)!, true)) selected.add(item.parentId);
    else selected.delete(item.parentId);
  }
  return [...selected];
}
