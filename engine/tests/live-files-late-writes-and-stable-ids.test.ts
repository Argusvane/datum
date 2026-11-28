// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { createFileStorageResolver, type FileStorage } from "../form-engine/render/core/file-storage.js";
import { createDataGridFeature } from "../form-engine/render/live/data-grid.js";
import { createDatumBinding, createDatumFeatures } from "../form-engine/render/live/datum/options.js";
import { createFilesFeature } from "../form-engine/render/live/files.js";
import { cleanUp, definitionOf, handed, mounted, quiet, runtimeOf, settled, wrapper } from "./live-extras-kit.js";

/*
 * A file field's writes that land after the pick (render/live/files.ts): the storage answers
 * later, so the write guard is asked again then, and a field in a data grid row writes to its
 * own row wherever it has moved. And an attachment's id names the attachment, not its place, so
 * a Remove pressed twice removes one file.
 */

afterEach(cleanUp);

const file = (name: string): File => new File(["x"], name, { type: "text/plain" });

/** A storage that answers when the test says so, in the order the files came. */
function slowStorage(): { storage: FileStorage; answer(): void } {
  const waiting: Array<() => void> = [];
  const storage: FileStorage = {
    kind: "bucket",
    store: (picked) =>
      new Promise((done) => {
        waiting.push(() => done({ storage: "bucket", name: picked.name, type: picked.type, size: picked.size }));
      })
  };
  return { storage, answer: () => waiting.shift()?.() };
}

async function drained(form: Parameters<typeof settled>[0]): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await settled(form);
  }
}

function drop(target: Element, files: File[]): Event {
  const event = new Event("drop", { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
  target.dispatchEvent(event);
  return event;
}

describe("live files: the write guard is asked again when the storage answers", () => {
  const single = (extra: Partial<ComponentNode> = {}) =>
    definitionOf([
      { id: "lock", type: "text", configuration: { label: "Lock" } },
      { id: "doc", type: "file", configuration: { label: "Doc", storage: "bucket" }, ...extra }
    ]);

  it("writes nothing when a submission started while the file was being stored, and says so", async () => {
    quiet();
    const slow = slowStorage();
    const { runtime, form, errors } = await mounted(single(), { features: [createFilesFeature({ storage: createFileStorageResolver([slow.storage]) })] });
    handed.get("doc")?.files?.([file("a.txt")]);
    await settled(form);
    form.setBusy("submitting", true);
    await settled(form);
    slow.answer();
    await drained(form);
    expect(runtime.state().values["doc"]).toBeUndefined();
    expect(errors.some((error) => error.hook === "files" && error.id === "doc")).toBe(true);
  });

  it("writes nothing when the field became read-only while the file was being stored", async () => {
    quiet();
    const slow = slowStorage();
    const definition = single({ rules: { readonlyWhen: 'lock = "yes"' } });
    const { runtime, form, errors } = await mounted(definition, { runtime: runtimeOf(definition), features: [createFilesFeature({ storage: createFileStorageResolver([slow.storage]) })] });
    handed.get("doc")?.files?.([file("a.txt")]);
    await settled(form);
    runtime.setValue("lock", "yes");
    await settled(form);
    slow.answer();
    await drained(form);
    expect(runtime.state().values["doc"]).toBeUndefined();
    expect(errors.some((error) => error.hook === "files" && error.id === "doc")).toBe(true);
  });

  it("takes no drop while a submission is in flight", async () => {
    const { runtime, root, form } = await mounted(definitionOf([{ id: "doc", type: "file", configuration: { label: "Doc" } }]), { features: [createFilesFeature()] });
    form.setBusy("submitting", true);
    await settled(form);
    const event = drop(wrapper(root, "doc").querySelector(".face") as Element, [file("d.txt")]);
    await drained(form);
    expect(event.defaultPrevented).toBe(false);
    expect(runtime.state().values["doc"]).toBeUndefined();
  });

  it("still writes a pick that lands while the form takes answers", async () => {
    const slow = slowStorage();
    const { runtime, form } = await mounted(single(), { features: [createFilesFeature({ storage: createFileStorageResolver([slow.storage]) })] });
    handed.get("doc")?.files?.([file("a.txt")]);
    await settled(form);
    slow.answer();
    await drained(form);
    expect(runtime.state().values["doc"]).toMatchObject({ name: "a.txt" });
  });
});

describe("live files: a file field in a data grid row writes to its own row", () => {
  const grid = () =>
    definitionOf([
      {
        id: "items",
        type: "dataGrid",
        configuration: { label: "Items", initialRows: 0, canReorder: true },
        collection: { collectionPath: "items" },
        children: {
          content: [
            { id: "who", type: "text", configuration: { label: "Who" } },
            { id: "doc", type: "file", configuration: { label: "Doc", storage: "bucket" } }
          ]
        }
      } as ComponentNode
    ]);

  async function pickInRowB() {
    quiet();
    const slow = slowStorage();
    const definition = grid();
    const runtime = runtimeOf(definition);
    runtime.addRows("items", [{ who: "A" }, { who: "B" }, { who: "C" }]);
    const m = await mounted(definition, { runtime, features: [createDataGridFeature(), createFilesFeature({ storage: createFileStorageResolver([slow.storage]) })] });
    await settled(m.form);
    const keyB = [...handed.keys()].find((key) => m.root.querySelector(`[data-instance="${CSS.escape(key)}"]`)?.getAttribute("data-value-path") === "items[1].doc");
    expect(keyB).toBeDefined();
    handed.get(keyB as string)?.files?.([file("B-passport.txt")]);
    await settled(m.form);
    const rows = () => (runtime.rows("items") as Array<{ who?: string; doc?: { name: string } }>).map((entry) => ({ who: entry.who, doc: entry.doc?.name }));
    return { ...m, runtime, slow, rows };
  }

  it("lands in the row it was picked in when a row above it is removed meanwhile", async () => {
    const { runtime, form, slow, rows } = await pickInRowB();
    runtime.removeRow("items", 0);
    await settled(form);
    slow.answer();
    await drained(form);
    expect(rows()).toEqual([
      { who: "B", doc: "B-passport.txt" },
      { who: "C", doc: undefined }
    ]);
  });

  it("follows its row when the rows are reordered meanwhile", async () => {
    const { runtime, form, slow, rows } = await pickInRowB();
    runtime.reorderRow("items", 1, 2);
    await settled(form);
    slow.answer();
    await drained(form);
    expect(rows()).toEqual([
      { who: "A", doc: undefined },
      { who: "C", doc: undefined },
      { who: "B", doc: "B-passport.txt" }
    ]);
  });

  it("writes nothing, and makes no row, when its own row is removed meanwhile", async () => {
    const { runtime, form, slow, rows } = await pickInRowB();
    runtime.removeRow("items", 1);
    await settled(form);
    slow.answer();
    await drained(form);
    expect(rows()).toEqual([
      { who: "A", doc: undefined },
      { who: "C", doc: undefined }
    ]);
  });
});

describe("live files: an attachment's Remove is bound to that file", () => {
  const attachment = (name: string) => ({ storage: "base64", name, type: "text/plain", size: 1, data: "YQ==" });

  it("removes one file when the same Remove is pressed twice, its row leaving with it and focus going to the picker", async () => {
    quiet();
    const definition = definitionOf([{ id: "f", type: "file", configuration: { label: "Files", multiple: true } }]);
    const runtime = runtimeOf(definition);
    const binding = createDatumBinding();
    const { root, form } = await mounted(definition, { runtime, binding, datum: binding, features: createDatumFeatures() });
    runtime.setValue("f", [attachment("A.txt"), attachment("B.txt"), attachment("C.txt")]);
    await settled(form);
    const names = (): string[] => Array.from(root.querySelectorAll(".datum-form__file-name"), (name) => name.textContent ?? "");
    const rowB = root.querySelectorAll(".datum-form__file-item")[1];
    const button = root.querySelector<HTMLButtonElement>(".datum-form__file-remove") as HTMLButtonElement;
    button.focus();
    button.click();
    button.click();
    await settled(form);
    expect((runtime.state().values["f"] as Array<{ name: string }>).map((entry) => entry.name)).toEqual(["B.txt", "C.txt"]);
    expect(names()).toEqual(["B.txt", "C.txt"]);
    // The row went with its file; the rows after it kept their elements.
    expect(button.isConnected).toBe(false);
    expect(root.querySelectorAll(".datum-form__file-item")[0]).toBe(rowB);
    expect(root.activeElement).toBe(root.querySelector('input[type="file"]'));
  });

  it("gives an attachment the same id wherever it stands in the list", async () => {
    const definition = definitionOf([{ id: "f", type: "file", configuration: { label: "Files", multiple: true } }]);
    const runtime = runtimeOf(definition);
    const { root, form } = await mounted(definition, { runtime, features: [createFilesFeature()] });
    runtime.setValue("f", [attachment("A.txt"), attachment("B.txt")]);
    await settled(form);
    const idOfB = wrapper(root, "f").querySelectorAll("li")[1]?.getAttribute("data-file");
    runtime.setValue("f", [attachment("B.txt")]);
    await settled(form);
    expect(wrapper(root, "f").querySelectorAll("li")[0]?.getAttribute("data-file")).toBe(idOfB);
  });
});
