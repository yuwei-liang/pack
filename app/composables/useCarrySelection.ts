import type { InjectionKey, Ref } from "vue";

export const CARRY_SELECTION: InjectionKey<{
  active: Readonly<Ref<boolean>>;
  ids: Ref<string[]>;
}> = Symbol("carrySelection");
