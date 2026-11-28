// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileStorageResolver, type FileStorage } from "../form-engine/render/core/file-storage.js";
import type { Base64FileAttachment } from "../form-engine/core/schema/file-upload.js";
import type { FileFieldState } from "../form-engine/render/live/contract.js";
import { createFilesFeature, FILE_STATUS_CLEAR_MS, fileItemId } from "../form-engine/render/live/files.js";
import { cleanUp, definitionOf, handed, mounted, quiet, settled, wrapper } from "./live-extras-kit.js";

/*
 * File fields in the live renderer (render/live/files.ts): the adapter's on.files / on.remove /
 * on.download, the status and drop regions the adapter marks, and the drag-and-drop the wrapper
 * owns. jsdom lacks createObjectURL; the download case stubs it in the test.
 */

afterEach(cleanUp);

const file = (name: string, text = "hello", type = "text/plain"): File => new File([text], name, { type });

const single = () => definitionOf([{ id: "doc", type: "file", configuration: { label: "Document" } }]);
const several = () => definitionOf([{ id: "doc", type: "file", configuration: { label: "Documents", multiple: true, accept: ".pdf" } }]);

/** Waits for a store (a FileReader) and the draw that follows it. */
async function stored(form: Parameters<typeof settled>[0]): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await settled(form);
  }
}

function drag(target: Element, type: string, init: { files?: File[]; types?: string[]; related?: Node | null } = {}): Event {
  const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: init.files ?? [], types: init.types ?? ["Files"] } });
  if (init.related !== undefined) {
    Object.defineProperty(event, "relatedTarget", { value: init.related });
  }
  target.dispatchEvent(event);
  return event;
}

describe("live files: state", () => {
  it("gives the adapter the attachments, whether the field takes several, and what it accepts", async () => {
    const { root, runtime, form } = await mounted(several(), { features: [createFilesFeature()] });
    runtime.setValue("doc", [{ storage: "base64", name: "a.pdf", type: "application/pdf", size: 3, data: "YWJj" }, { storage: "s3", name: "b.pdf", type: "", size: 9 }]);
    await settled(form);
    const items = wrapper(root, "doc").querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]?.querySelector("button.download")?.textContent).toBe("a.pdf");
    // Only an embedded file can be handed back as a download.
    expect(items[1]?.querySelector("button.download")).toBeNull();
    const picker = wrapper(root, "doc").querySelector("input[type=file]") as HTMLInputElement;
    expect(picker.multiple).toBe(true);
    expect(picker.getAttribute("accept")).toBe(".pdf");
    // An item's id is made from the attachment, not its place in the list.
    expect(items[1]?.getAttribute("data-file")).toBe(fileItemId("doc", { storage: "s3", name: "b.pdf", type: "", size: 9 }));
  });
});

describe("live files: picking", () => {
  it("stores a pick through the base64 storage and says which file was picked where the field asks for it", async () => {
    const { root, runtime, form } = await mounted(single(), { features: [createFilesFeature()] });
    handed.get("doc")?.files?.([file("a.txt", "abc"), file("b.txt")]);
    await stored(form);
    // A single-file field stores the first file alone.
    const value = runtime.state().values["doc"] as Base64FileAttachment;
    expect(value).toMatchObject({ storage: "base64", name: "a.txt", size: 3, data: "YWJj" });
    expect(wrapper(root, "doc").querySelector(".status")?.textContent).toBe("You have selected the file: a.txt");
    expect(wrapper(root, "doc").querySelectorAll("li")).toHaveLength(1);
  });

  it("appends to what a multi-file field holds and counts the files in the announcement", async () => {
    const { root, runtime, form } = await mounted(several(), { features: [createFilesFeature()] });
    handed.get("doc")?.files?.([file("a.pdf")]);
    await stored(form);
    handed.get("doc")?.files?.([file("b.pdf"), file("c.pdf")]);
    await stored(form);
    expect((runtime.state().values["doc"] as Array<{ name: string }>).map((entry) => entry.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(wrapper(root, "doc").querySelector(".status")?.textContent).toBe("You have selected 2 files: b.pdf, c.pdf");
  });

  it("says nothing about a pick where the field's face does not ask for it", async () => {
    const { root, form } = await mounted(single(), { features: [createFilesFeature()] });
    wrapper(root, "doc").querySelector(".status")?.removeAttribute("data-file-announce");
    handed.get("doc")?.files?.([file("a.txt")]);
    await stored(form);
    expect(wrapper(root, "doc").querySelector(".status")?.textContent).toBe("");
  });

  it("goes through the storage the component names, and leaves the field alone when it rejects", async () => {
    quiet();
    const calls: string[] = [];
    const bucket: FileStorage = {
      kind: "bucket",
      store: async (picked, context) => {
        calls.push(`${context.componentId}:${context.valuePath}:${context.configuration.storage}`);
        return { storage: "bucket", name: picked.name, type: picked.type, size: picked.size };
      }
    };
    const { runtime, form, errors } = await mounted(definitionOf([{ id: "doc", type: "file", configuration: { label: "Doc", storage: "bucket" } }]), {
      features: [createFilesFeature({ storage: createFileStorageResolver([bucket]) })]
    });
    handed.get("doc")?.files?.([file("a.txt")]);
    await stored(form);
    expect(calls).toEqual(["doc:doc:bucket"]);
    expect(runtime.state().values["doc"]).toMatchObject({ storage: "bucket", name: "a.txt" });

    const failing: FileStorage = { kind: "bucket", store: async () => Promise.reject(new Error("offline")) };
    const second = await mounted(definitionOf([{ id: "doc", type: "file", configuration: { label: "Doc", storage: "bucket" } }]), {
      features: [createFilesFeature({ storage: () => createFileStorageResolver([failing]) })]
    });
    handed.get("doc")?.files?.([file("a.txt")]);
    await stored(second.form);
    expect(second.runtime.state().values["doc"]).toBeUndefined();
    expect(second.errors.map((error) => error.hook)).toEqual(["files"]);
    expect(second.errors[0]?.message).toContain("offline");
    expect(errors).toEqual([]);
  });

  it("reports a storage kind nothing registered, and stores nothing", async () => {
    quiet();
    const { runtime, form, errors } = await mounted(definitionOf([{ id: "doc", type: "file", configuration: { label: "Doc", storage: "vault" } }]), { features: [createFilesFeature()] });
    handed.get("doc")?.files?.([file("a.txt")]);
    await stored(form);
    expect(runtime.state().values["doc"]).toBeUndefined();
    expect(errors[0]).toMatchObject({ hook: "files", id: "doc" });
    expect(errors[0]?.message).toContain('"vault"');
  });

  it("drops a pick on a read-only field", async () => {
    const { runtime, form } = await mounted(definitionOf([{ id: "doc", type: "file", configuration: { label: "Doc", readOnly: true } }]), { features: [createFilesFeature()] });
    handed.get("doc")?.files?.([file("a.txt")]);
    await stored(form);
    expect(runtime.state().values["doc"]).toBeUndefined();
  });
});

describe("live files: removing and downloading", () => {
  const embedded: Base64FileAttachment = { storage: "base64", name: "a.txt", type: "text/plain", size: 3, data: "YWJj" };

  it("drops one attachment and says which went; a single-file field goes back to holding nothing", async () => {
    const { root, runtime, form } = await mounted(several(), { features: [createFilesFeature()] });
    runtime.setValue("doc", [embedded, { ...embedded, name: "b.txt" }]);
    await settled(form);
    (wrapper(root, "doc").querySelectorAll("button.remove")[0] as HTMLButtonElement).click();
    await stored(form);
    expect((runtime.state().values["doc"] as Array<{ name: string }>).map((entry) => entry.name)).toEqual(["b.txt"]);
    expect(wrapper(root, "doc").querySelector(".status")?.textContent).toBe("File removed: a.txt");

    const alone = await mounted(single(), { features: [createFilesFeature()] });
    alone.runtime.setValue("doc", embedded);
    await settled(alone.form);
    (wrapper(alone.root, "doc").querySelector("button.remove") as HTMLButtonElement).click();
    await stored(alone.form);
    expect(alone.runtime.state().values["doc"]).toBeUndefined();
  });

  it("refuses a removal on a read-only field but allows the download", async () => {
    const created: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (blob: Blob) => (created.push(blob), "blob:test"), revokeObjectURL: () => undefined }));
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    const { root, runtime, form } = await mounted(definitionOf([{ id: "doc", type: "file", configuration: { label: "Doc", readOnly: true } }]), { features: [createFilesFeature()] });
    runtime.setValue("doc", embedded);
    await settled(form);
    (wrapper(root, "doc").querySelector("button.remove") as HTMLButtonElement).click();
    await stored(form);
    expect(runtime.state().values["doc"]).toMatchObject({ name: "a.txt" });
    (wrapper(root, "doc").querySelector("button.download") as HTMLButtonElement).click();
    expect(clicked).toEqual(["a.txt"]);
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("text/plain");
    expect(created[0]?.size).toBe(3);
  });

  it("keeps focus in the field when the pressed Remove button leaves with its row", async () => {
    const { root, runtime, form } = await mounted(several(), { features: [createFilesFeature()] });
    runtime.setValue("doc", [embedded, { ...embedded, name: "b.txt" }]);
    await settled(form);
    const remove = wrapper(root, "doc").querySelectorAll<HTMLButtonElement>("button.remove")[1] as HTMLButtonElement;
    remove.focus();
    expect(root.activeElement).toBe(remove);
    remove.click();
    await stored(form);
    expect(remove.isConnected).toBe(false);
    expect(root.activeElement).not.toBeNull();
    expect(wrapper(root, "doc").contains(root.activeElement)).toBe(true);
  });

  it("clears the status line a while after it is said, unless newer words replaced it", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { root, runtime, form } = await mounted(several(), { features: [createFilesFeature()] });
    runtime.setValue("doc", [embedded, { ...embedded, name: "b.txt" }, { ...embedded, name: "c.txt" }]);
    await settled(form);
    const clears = (): Array<() => void> => timers.mock.calls.filter((call) => call[1] === FILE_STATUS_CLEAR_MS).map((call) => call[0] as () => void);
    const status = (): string | null | undefined => wrapper(root, "doc").querySelector(".status")?.textContent;
    (wrapper(root, "doc").querySelectorAll("button.remove")[0] as HTMLButtonElement).click();
    await stored(form);
    expect(status()).toBe("File removed: a.txt");
    (wrapper(root, "doc").querySelectorAll("button.remove")[0] as HTMLButtonElement).click();
    await stored(form);
    expect(status()).toBe("File removed: b.txt");
    expect(clears()).toHaveLength(2);
    // The first line's clear finds newer words: they stay. The second's clears them.
    clears()[0]?.();
    expect(status()).toBe("File removed: b.txt");
    clears()[1]?.();
    expect(status()).toBe("");
  });

  it("ignores an id it does not know", async () => {
    const { runtime, form } = await mounted(single(), { features: [createFilesFeature()] });
    runtime.setValue("doc", embedded);
    await settled(form);
    handed.get("doc")?.remove?.("doc__file_7");
    handed.get("doc")?.download?.("nope");
    await stored(form);
    expect(runtime.state().values["doc"]).toMatchObject({ name: "a.txt" });
  });
});

describe("live files: drag and drop belong to the wrapper", () => {
  it("marks the wrapper while a file is dragged over it, says so in the drop region, and clears both marks as the drag leaves", async () => {
    const { root, form } = await mounted(single(), {
      features: [createFilesFeature()],
      texts: { fileDropEntered: "Entered drop zone", fileDropLeft: "Left drop zone" }
    });
    await settled(form);
    const box = wrapper(root, "doc");
    const over = drag(box.querySelector(".face") as Element, "dragenter");
    expect(box.hasAttribute("data-file-drag")).toBe(true);
    expect(over.defaultPrevented).toBe(true);
    expect(box.querySelector(".drop")?.textContent).toBe("Entered drop zone");
    // Moving on inside the field is not leaving it.
    drag(box.querySelector(".face") as Element, "dragleave", { related: box.querySelector("ul") });
    expect(box.hasAttribute("data-file-drag")).toBe(true);
    drag(box.querySelector(".face") as Element, "dragleave", { related: null });
    expect(box.hasAttribute("data-file-drag")).toBe(false);
    expect(box.querySelector(".drop")?.textContent).toBe("Left drop zone");
  });

  it("says nothing in the drop region when no text words the drag", async () => {
    const { root, form } = await mounted(single(), { features: [createFilesFeature()] });
    await settled(form);
    const box = wrapper(root, "doc");
    drag(box, "dragenter");
    expect(box.hasAttribute("data-file-drag")).toBe(true);
    expect(box.querySelector(".drop")?.textContent).toBe("");
  });

  it("does not mark a drag of something that is no file, nor a read-only or disabled field", async () => {
    const { root, form } = await mounted(
      definitionOf([
        { id: "doc", type: "file", configuration: { label: "Doc" } },
        { id: "kept", type: "file", configuration: { label: "Kept", readOnly: true } },
        { id: "off", type: "file", configuration: { label: "Off", disabled: true } }
      ]),
      { features: [createFilesFeature()] }
    );
    await settled(form);
    drag(wrapper(root, "doc"), "dragenter", { types: ["text/plain"] });
    expect(wrapper(root, "doc").hasAttribute("data-file-drag")).toBe(false);
    for (const id of ["kept", "off"]) {
      const event = drag(wrapper(root, id), "dragenter");
      expect(wrapper(root, id).hasAttribute("data-file-drag"), id).toBe(false);
      expect(event.defaultPrevented, id).toBe(false);
    }
  });

  it("stores a file dropped outside the adapter's input like a pick, and leaves a drop on the input to the input", async () => {
    const { root, runtime, form } = await mounted(several(), { features: [createFilesFeature()] });
    await settled(form);
    const box = wrapper(root, "doc");
    drag(box, "dragenter");
    const dropped = drag(box.querySelector(".face") as Element, "drop", { files: [file("a.pdf")] });
    expect(dropped.defaultPrevented).toBe(true);
    expect(box.hasAttribute("data-file-drag")).toBe(false);
    await stored(form);
    expect((runtime.state().values["doc"] as Array<{ name: string }>).map((entry) => entry.name)).toEqual(["a.pdf"]);

    const native = drag(box.querySelector("input[type=file]") as Element, "drop", { files: [file("b.pdf")] });
    expect(native.defaultPrevented).toBe(false);
    await stored(form);
    expect(runtime.state().values["doc"] as unknown[]).toHaveLength(1);
  });

  it("refuses a drop on a read-only field", async () => {
    const { root, runtime, form } = await mounted(definitionOf([{ id: "doc", type: "file", configuration: { label: "Doc", readOnly: true } }]), { features: [createFilesFeature()] });
    await settled(form);
    drag(wrapper(root, "doc"), "drop", { files: [file("a.pdf")] });
    await stored(form);
    expect(runtime.state().values["doc"]).toBeUndefined();
  });

  it("marks a press that starts inside the face's button until it ends", async () => {
    const { root, form } = await mounted(single(), { features: [createFilesFeature()] });
    await settled(form);
    const box = wrapper(root, "doc");
    const button = box.querySelector("[data-file-button]") as HTMLElement;
    button.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 40, width: 100, height: 40, x: 0, y: 0, toJSON: () => ({}) });
    const picker = box.querySelector("input[type=file]") as HTMLInputElement;
    const press = (x: number, y: number): void => {
      const event = new Event("pointerdown", { bubbles: true, composed: true });
      Object.assign(event, { clientX: x, clientY: y });
      picker.dispatchEvent(event);
    };
    press(300, 10);
    expect(box.hasAttribute("data-file-press")).toBe(false);
    press(10, 10);
    expect(box.hasAttribute("data-file-press")).toBe(true);
    window.dispatchEvent(new Event("pointerup"));
    expect(box.hasAttribute("data-file-press")).toBe(false);
  });

  it("stops listening when the form unmounts", async () => {
    const { root, form } = await mounted(single(), { features: [createFilesFeature()] });
    await settled(form);
    const box = wrapper(root, "doc");
    form.unmount();
    expect(root.querySelector(".datum-live-field")).toBeNull();
    const event = drag(box, "dragenter");
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("live files: the state an adapter is typed for", () => {
  it("keeps a state another module already built", async () => {
    const seen: FileFieldState[] = [];
    const { form } = await mounted(single(), {
      features: [
        {
          id: "earlier",
          fieldState: (state, node) => (node.model.file ? ({ ...state, files: [], multiple: true } as FileFieldState) : undefined)
        },
        createFilesFeature(),
        { id: "after", fieldState: (state, node) => (node.model.file ? (seen.push(state as FileFieldState), undefined) : undefined) }
      ]
    });
    await settled(form);
    expect(seen.at(-1)?.multiple).toBe(true);
  });
});
