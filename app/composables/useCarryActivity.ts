import type { InjectionKey, Ref } from "vue";
import type { CarryActivity } from "~~/shared/carryActivity";
export const CARRY_ACTIVITY: InjectionKey<{
  activity: Readonly<Ref<Map<string, CarryActivity>>>;
  skipped: Ref<Set<string>>;
}> = Symbol("carryActivity");
