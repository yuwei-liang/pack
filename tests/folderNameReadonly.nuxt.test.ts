// @vitest-environment nuxt
//
// THE FOLDER NAME when it can't be edited. Packing mode used to keep the editor's
// <input> and disable it; it is plain text there now, the way the share views render
// it, and edit mode keeps the input. (The clipped "）" Safari showed was the root's
// hanging-punctuation, fixed in CSS — atoms/folder.scss + reset.scss; jsdom does no
// layout, so this file pins only the markup.)
import { afterEach, describe, expect, it } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import FolderSection from "~/components/FolderSection.vue";
import ReadonlyFolderSection from "~/components/ReadonlyFolderSection.vue";
import type { Folder, ListSnapshot } from "~~/shared/types";
import { blankList } from "./helpers/list";
import { gearListStub } from "./helpers/gearList";

const folder: Folder = { id: "f1", name: "证件 & 钱（随身）", defaultClassification: "base", sortOrder: 0 } as Folder;
const snapshot = ref<ListSnapshot>(blankList({ folders: [folder] }));

mockNuxtImport("useGearList", () => () => gearListStub({ snapshot }));

enableAutoUnmount(afterEach);

// The rows are a separate render boundary (FolderRows) and not what this is about.
const stubs = { FolderRows: true };

describe("folder name, read-only vs editable", () => {
  it("packing mode renders the name as text, not a disabled input", () => {
    const w = mount(FolderSection, {
      props: { list: snapshot.value, folder, items: [], packed: true },
      global: { stubs },
    });
    const name = w.find(".folder__name");
    expect(name.element.tagName).toBe("SPAN");
    // the whole name, last full-width glyph included
    expect(name.text()).toBe("证件 & 钱（随身）");
    expect(w.find("input.folder__name").exists()).toBe(false);
    expect(w.find("input:disabled").exists()).toBe(false);
  });

  it("edit mode keeps the editable input", async () => {
    const w = mount(FolderSection, {
      props: { list: snapshot.value, folder, items: [], packed: false },
      global: { stubs },
    });
    const input = w.find("input.folder__name");
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).disabled).toBe(false);
    expect((input.element as HTMLInputElement).value).toBe("证件 & 钱（随身）");
    expect(input.attributes("aria-label")).toBe("Folder name");
  });

  it("switching into packing swaps the input for text, and back", async () => {
    const w = mount(FolderSection, {
      props: { list: snapshot.value, folder, items: [], packed: false },
      global: { stubs },
    });
    await w.setProps({ packed: true });
    expect(w.find(".folder__name").element.tagName).toBe("SPAN");
    await w.setProps({ packed: false });
    expect(w.find(".folder__name").element.tagName).toBe("INPUT");
  });

  it("the share views' folder name is text too", () => {
    const w = mount(ReadonlyFolderSection, {
      props: { list: snapshot.value, folder, items: [], childrenByParent: new Map() },
    });
    expect(w.find(".folder__name").element.tagName).toBe("SPAN");
    expect(w.find("input").exists()).toBe(false);
  });
});
