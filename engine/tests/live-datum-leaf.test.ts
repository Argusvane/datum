// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { capabilityAnswers } from "../form-engine/render/live/contract.js";
import { createButtonsFeature } from "../form-engine/render/live/buttons.js";
import { datumButton, createDatumButtonGroup } from "../form-engine/render/live/datum/buttons.js";
import { datumHtml, datumImage } from "../form-engine/render/live/datum/content.js";
import { createDatumFileAdapter, datumFile } from "../form-engine/render/live/datum/file.js";
import { datumSignature, participantsOf } from "../form-engine/render/live/datum/signature.js";
import { createFilesFeature } from "../form-engine/render/live/files.js";
import { createTooltipsFeature } from "../form-engine/render/live/tooltips.js";
import { definitionOf, mounted, runtimeOf, settled, unmountAll, wrapper } from "./live-datum-parts-kit.js";

afterEach(unmountAll);

/** The one element matching `selector` in `scope`. */
function one(scope: ParentNode, selector: string): HTMLElement {
  const found = scope.querySelector<HTMLElement>(selector);
  expect(found, selector).not.toBeNull();
  return found as HTMLElement;
}

describe("Datum buttons", () => {
  const button = (id: string, configuration: Record<string, unknown>) => ({ id, type: "button", configuration: { label: id, ...configuration } });

  it("draws every emphasis, size and signature", async () => {
    const definition = definitionOf([
      button("plain", { action: "submit" }),
      button("primary", { action: "submit", variant: "primary", size: "lg", signature: "webauthn" }),
      button("small", { action: "download", variant: "secondary", size: "sm" }),
      button("medium", { action: "pdf", variant: "link", size: "md" }),
      button("idle", {}),
      button("off", { action: "submit", disabled: true })
    ]);
    const m = await mounted(definition, { features: [createButtonsFeature()] });
    const classes = (id: string): string[] => Array.from(one(wrapper(m.root, id), "button").classList);
    expect(classes("plain")).toEqual(expect.arrayContaining(["datum-form__button"]));
    expect(classes("primary")).toEqual(expect.arrayContaining(["datum-form__button--primary", "datum-form__button--lg"]));
    expect(classes("small")).toEqual(expect.arrayContaining(["datum-form__button--secondary", "datum-form__button--sm"]));
    expect(classes("medium")).toEqual(expect.arrayContaining(["datum-form__button--link"]));
    expect(one(wrapper(m.root, "plain"), "button").textContent?.trim()).toBe("plain");
    expect(one(wrapper(m.root, "off"), "button").hasAttribute("disabled")).toBe(true);
    // The wrapper owns the component id and the state hooks; the button carries the action marks the renderer hears.
    expect(wrapper(m.root, "primary").dataset.kind).toBe("button");
    expect(one(wrapper(m.root, "primary"), "button").dataset.buttonSignature).toBe("webauthn");
  });

  it("answers no drawing capability: a button holds no answer", () => {
    expect(datumButton.capabilities).toEqual({});
  });

  it("reports a press as datum-form-action, with the signing provider where there is one", async () => {
    const m = await mounted(definitionOf([button("go", { action: "submit", signature: "webauthn" }), button("plain", { action: "download" }), button("idle", {})]), {
      features: [createButtonsFeature()]
    });
    one(wrapper(m.root, "go"), "button").click();
    one(wrapper(m.root, "plain"), "button").click();
    // A button with no action configured reports nothing.
    one(wrapper(m.root, "idle"), "button").click();
    expect(m.events("datum-form-action").map((event) => event.detail)).toEqual([
      { componentId: "go", action: "submit", signature: "webauthn" },
      { componentId: "plain", action: "download" }
    ]);
  });

  it("reports nothing while the form is read-only, disabled or working, and says so with aria-disabled", async () => {
    const definition = definitionOf([button("go", { action: "submit" })]);
    for (const mode of ["readonly", "disabled"] as const) {
      const m = await mounted(definition, { features: [createButtonsFeature()], mode });
      one(wrapper(m.root, "go"), "button").click();
      expect(m.events("datum-form-action"), mode).toEqual([]);
      unmountAll();
    }
    const m = await mounted(definition, { features: [createButtonsFeature()] });
    const control = one(wrapper(m.root, "go"), "button");
    expect(control.hasAttribute("aria-disabled")).toBe(false);
    m.live().setBusy("submitting", true);
    await settled(m.form);
    expect(control.getAttribute("aria-disabled")).toBe("true");
    // Still focusable (not `disabled`), and the press is dropped.
    expect(control.hasAttribute("disabled")).toBe(false);
    control.click();
    expect(m.events("datum-form-action")).toEqual([]);
    m.live().setBusy("submitting", false);
    await settled(m.form);
    control.click();
    expect(m.events("datum-form-action")).toHaveLength(1);
  });

  it("holds no press for a whole-form check that is running: a click after leaving a field is not lost", async () => {
    const m = await mounted(definitionOf([button("go", { action: "submit" })]), { features: [createButtonsFeature()] });
    m.live().setBusy("validating", true);
    await settled(m.form);
    const control = one(wrapper(m.root, "go"), "button");
    expect(control.hasAttribute("aria-disabled")).toBe(false);
    control.click();
    expect(m.events("datum-form-action")).toHaveLength(1);
  });

  it("draws a button group as a box, or as a list of items where a form asks", async () => {
    const group = { id: "bar", type: "button-group", configuration: {}, children: { content: [button("a", { action: "submit" }), button("b", { action: "download" })] } };
    const definition = definitionOf([group]);
    const plain = await mounted(definition);
    const box = one(plain.root, ".datum-form__button-group");
    expect(box.localName).toBe("div");
    expect(box.querySelectorAll("button")).toHaveLength(2);
    expect(box.querySelector("li")).toBeNull();
    unmountAll();
    const listed = await mounted(definition, { parts: { buttonGroup: "list" } });
    const list = one(listed.root, ".datum-form__button-group");
    expect(list.localName).toBe("ul");
    expect(Array.from(list.children).map((child) => child.localName)).toEqual(["li", "li"]);
    expect(list.querySelectorAll("li.datum-form__button-group-item > .datum-live-field button")).toHaveLength(2);
    expect(createDatumButtonGroup({ buttonGroup: "list" }).name).toBe("datum button list");
  });
});

describe("Datum static content", () => {
  const html = (id: string, configuration: Record<string, unknown>) => ({ id, type: "html", configuration });
  const image = (id: string, configuration: Record<string, unknown>) => ({ id, type: "image", configuration });

  it("draws an html block in the element the author chose", async () => {
    const definition = definitionOf([
      html("a", { content: "<p>Read <b>this</b> first.</p><ul><li>One</li></ul>" }),
      html("b", { content: "Plain words", tag: "section" }),
      html("c", { content: "<h3>Title</h3>", tag: "article" }),
      html("d", { content: "Quote", tag: "blockquote" }),
      html("e", { content: "<a href=\"https://example.com\">link</a>", tag: "nope" })
    ]);
    const m = await mounted(definition);
    expect(wrapper(m.root, "c").firstElementChild?.localName).toBe("article");
    expect(wrapper(m.root, "d").firstElementChild?.localName).toBe("blockquote");
    expect(wrapper(m.root, "b").firstElementChild?.localName).toBe("section");
    expect(wrapper(m.root, "e").firstElementChild?.localName).toBe("div");
    expect(wrapper(m.root, "a").querySelector("b")?.textContent).toBe("this");
  });

  it("draws only what the allowlist keeps of the author's markup", async () => {
    const m = await mounted(
      definitionOf([html("a", { content: '<p onclick="x()">Hi</p><script>alert(1)</script><img src="javascript:alert(1)"><a href="javascript:alert(1)">bad</a>' })])
    );
    const block = one(wrapper(m.root, "a"), ".datum-form__html");
    expect(block.querySelector("script")).toBeNull();
    expect(block.innerHTML).not.toContain("onclick");
    expect(block.innerHTML).not.toContain("javascript:");
    expect(block.textContent).toContain("Hi");
  });

  it("draws a picture, and an empty frame for a missing or unsafe address", async () => {
    const definition = definitionOf([
      image("pic", { src: "https://example.com/a.png", alt: "A map", width: 320, height: 200 }),
      image("bare", { src: "https://example.com/b.png" }),
      image("none", {}),
      image("bad", { src: "javascript:alert(1)", alt: "x" })
    ]);
    const m = await mounted(definition);
    expect(one(wrapper(m.root, "pic"), "img").getAttribute("width")).toBe("320");
    expect(one(wrapper(m.root, "bare"), "img").hasAttribute("alt")).toBe(true);
    expect(one(wrapper(m.root, "pic"), "img").getAttribute("alt")).toBe("A map");
    expect(wrapper(m.root, "none").querySelector(".datum-form__image--empty")?.textContent).toBe("No image URL");
    expect(wrapper(m.root, "bad").querySelector("img")).toBeNull();
  });

  it("words the empty frame from the form's texts", async () => {
    const m = await mounted(definitionOf([image("none", {})]), { texts: { imageEmpty: "Pas d'adresse d'image" } });
    expect(wrapper(m.root, "none").textContent?.trim()).toBe("Pas d'adresse d'image");
  });

  it("answers no capability: neither holds an answer or a label", () => {
    expect(datumHtml.capabilities).toEqual({});
    expect(datumImage.capabilities).toEqual({});
  });
});

/** A file attachment as the field stores it. */
const attachment = (name: string, size: number, storage = "base64") => ({ storage, name, type: "application/pdf", size, ...(storage === "base64" ? { data: "AAAA" } : {}) });

describe("Datum file field", () => {
  const file = (id: string, configuration: Record<string, unknown> = {}) => ({ id, type: "file", configuration: { label: "Report", ...configuration } });
  const features = () => [createFilesFeature(), createTooltipsFeature()];

  it("draws the picker and the list of what it holds", async () => {
    const definition = definitionOf([file("doc", { required: true, multiple: true, accept: [".pdf", "image/*"], description: "Up to 4 MB" }), file("empty")]);
    const runtime = runtimeOf(definition);
    runtime.setValue("doc", [attachment("report.pdf", 2048), attachment("other.pdf", 12, "elsewhere")]);
    const m = await mounted(definition, { runtime, features: features() });
    for (const id of ["doc", "empty"]) {
      expect(one(wrapper(m.root, id), ".datum-form__file"), id).not.toBeNull();
      // A pick is said in the status region: the cleared input no longer names the file.
      expect(one(wrapper(m.root, id), "[data-file-status]").hasAttribute("data-file-announce"), id).toBe(true);
    }
    const names = Array.from(wrapper(m.root, "doc").querySelectorAll(".datum-form__file-name"));
    // An embedded file's name is a download; a file stored elsewhere is plain text.
    expect(names.map((name) => name.localName)).toEqual(["button", "span"]);
    const input = one(wrapper(m.root, "doc"), "input[type=file]") as HTMLInputElement;
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe(".pdf,image/*");
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("doc__description");
    expect(one(wrapper(m.root, "doc"), "label").getAttribute("for")).toBe(input.id);
  });

  it("draws the review: the list alone, or the none line", async () => {
    const definition = definitionOf([file("doc"), file("empty")]);
    const runtime = runtimeOf(definition);
    runtime.setValue("doc", [attachment("report.pdf", 2048)]);
    const m = await mounted(definition, { runtime, mode: "readonly", features: features() });
    expect(m.root.querySelector("input[type=file]")).toBeNull();
    expect(m.root.querySelector(".datum-form__file-remove")).toBeNull();
    expect(wrapper(m.root, "empty").querySelector(".datum-form__file-empty")?.textContent).toBe("No file");
    // A heading with no control to point at is a plain span, not a label.
    expect(wrapper(m.root, "doc").querySelector("label")).toBeNull();
    expect(wrapper(m.root, "doc").querySelector("span.datum-form__label")?.textContent).toContain("Report");
  });

  it("stores a picked file, clears the picker, and lists the file", async () => {
    const definition = definitionOf([file("doc")]);
    const m = await mounted(definition, { features: features() });
    const input = one(wrapper(m.root, "doc"), "input[type=file]") as HTMLInputElement;
    const picked = new File(["hello"], "note.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [picked] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(wrapper(m.root, "doc").querySelector(".datum-form__file-name")?.textContent).toBe("note.txt"));
    expect(wrapper(m.root, "doc").querySelector(".datum-form__file-size")?.textContent).toBe("5 B");
    expect(input.value).toBe("");
    // The cleared picker no longer names the file: the status region says which was picked.
    await vi.waitFor(() => expect(one(wrapper(m.root, "doc"), "[data-file-status]").textContent).toBe("You have selected the file: note.txt"));
  });

  it("removes a file and says so in the status region", async () => {
    const definition = definitionOf([file("doc", { multiple: true })]);
    const runtime = runtimeOf(definition);
    runtime.setValue("doc", [attachment("a.pdf", 10), attachment("b.pdf", 20)]);
    const m = await mounted(definition, { runtime, features: features() });
    const removes = wrapper(m.root, "doc").querySelectorAll<HTMLElement>(".datum-form__file-remove");
    expect(removes[0]?.getAttribute("aria-label")).toBe("Remove a.pdf");
    expect(removes[0]?.textContent).toBe("Remove");
    removes[0]?.click();
    await settled(m.form);
    expect(Array.from(wrapper(m.root, "doc").querySelectorAll(".datum-form__file-name")).map((name) => name.textContent)).toEqual(["b.pdf"]);
    const status = one(wrapper(m.root, "doc"), "[data-file-status]");
    expect(status.textContent).toBe("File removed: a.pdf");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.hasAttribute("data-file-announce")).toBe(true);
  });

  it("hands an embedded file back as a download, also in a review", async () => {
    const definition = definitionOf([file("doc")]);
    const runtime = runtimeOf(definition);
    runtime.setValue("doc", [attachment("a.pdf", 10)]);
    const createObjectURL = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const m = await mounted(definition, { runtime, mode: "readonly", features: features() });
    one(wrapper(m.root, "doc"), "button.datum-form__file-name").click();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("takes no pick and offers no removal on a disabled field", async () => {
    const definition = definitionOf([file("doc", { disabled: true })]);
    const runtime = runtimeOf(definition);
    runtime.setValue("doc", [attachment("a.pdf", 10)]);
    const m = await mounted(definition, { runtime, features: features() });
    expect((one(wrapper(m.root, "doc"), "input[type=file]") as HTMLInputElement).disabled).toBe(true);
    expect(wrapper(m.root, "doc").querySelector(".datum-form__file-remove")).toBeNull();
    expect(wrapper(m.root, "doc").hasAttribute("data-disabled")).toBe(true);
  });

  it("draws the error and the hidden label, and names the picker by the label when a help mark follows it", async () => {
    const definition = definitionOf([file("doc", { required: true, hideLabel: true, tooltip: "PDF only" })]);
    const m = await mounted(definition, { features: features() });
    await m.runtime.validate();
    await settled(m.form);
    const field = wrapper(m.root, "doc");
    expect(field.hasAttribute("data-invalid")).toBe(true);
    const input = one(field, "input[type=file]");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(one(field, ".datum-form__error").getAttribute("role")).toBe("alert");
    expect((input.getAttribute("aria-describedby") ?? "").split(" ")).toEqual(expect.arrayContaining(["doc__error", "doc__tooltip"]));
    expect(input.getAttribute("aria-labelledby")).toBe("doc__label");
    expect(one(field, ".datum-form__label").className).toContain("datum-form__visually-hidden");
    expect(one(field, "[data-tooltip] [data-tooltip-mark]").getAttribute("aria-label")).toBe("Help");
  });

  it("draws everything a file field uses: nothing is reported as unsupported", async () => {
    const m = await mounted(definitionOf([file("doc", { hideLabel: true, tooltip: "PDF only", description: "Hint" })]), { features: features() });
    expect(m.form.unsupported()).toEqual([]);
    expect(m.form.adapterOf("doc")).toEqual({ from: "binding", via: "file", name: "datum file" });
  });

  it("answers its capabilities", () => {
    expect(capabilityAnswers(datumFile, "file")).toEqual({ notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "drawn", hideLabel: "drawn" });
    expect(createDatumFileAdapter().name).toBe("datum file");
  });

  it("follows the field options: the order of the parts and the ARIA states", async () => {
    const definition = definitionOf([file("doc", { required: true, description: "Hint" })]);
    const m = await mounted(definition, { features: features(), parts: { fields: { fieldOrder: ["description", "label", "control", "error"], controls: { ariaStates: "none" } } } });
    const field = one(wrapper(m.root, "doc"), ".datum-form__file");
    expect(Array.from(field.children).slice(0, 2).map((child) => child.className)).toEqual(["datum-form__description", "datum-form__label"]);
    const input = one(field, "input[type=file]");
    expect(input.hasAttribute("aria-required")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("Datum signature component", () => {
  const signature = (configuration: Record<string, unknown> = {}) => ({ id: "sig", type: "signature", configuration: { label: "Signatures", description: "Both must sign", ...configuration } });

  it("names who must sign, in a group the label names", async () => {
    const m = await mounted(definitionOf([signature({ participants: [{ id: "a", role: "Applicant" }, { id: "w", role: "Witness" }, { id: 3, role: "dropped" }, "nope"] })]));
    const field = one(wrapper(m.root, "sig"), ".datum-form__signature");
    expect(wrapper(m.root, "sig").dataset.kind).toBe("signature");
    expect(field.getAttribute("role")).toBe("group");
    expect(field.getAttribute("aria-labelledby")).toBe("sig__label");
    expect(field.getAttribute("aria-describedby")).toBe("sig__description");
    expect(one(field, "#sig__label").textContent).toContain("Signatures");
    expect(Array.from(field.querySelectorAll("li")).map((item) => [item.getAttribute("data-participant"), item.textContent])).toEqual([
      ["a", "Applicant"],
      ["w", "Witness"]
    ]);
    expect(one(field, "#sig__description").textContent).toBe("Both must sign");
  });

  it("draws no list for a component naming nobody, and its error", async () => {
    const m = await mounted(definitionOf([signature({ required: true })]));
    expect(m.root.querySelector(".datum-form__signature-participants")).toBeNull();
    expect(participantsOf({ model: { node: { id: "x", type: "signature", configuration: { participants: "no" } } } } as never)).toEqual([]);
    await m.runtime.validate();
    await settled(m.form);
    const field = one(wrapper(m.root, "sig"), ".datum-form__signature");
    expect(wrapper(m.root, "sig").hasAttribute("data-invalid")).toBe(true);
    expect(one(field, ".datum-form__error").getAttribute("role")).toBe("alert");
    expect(field.getAttribute("aria-describedby")).toBe("sig__description sig__error");
  });

  it("answers its capabilities", () => {
    expect(capabilityAnswers(datumSignature, "signature")).toEqual({ notice: "drawn", workedOut: "drawn", pending: "degraded", tooltip: "drawn", hideLabel: "drawn" });
  });
});

