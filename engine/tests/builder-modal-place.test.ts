// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { MODAL_INSET, followModalBox, modalBox, placeModal } from "../form-engine/builder/web-component/modal-place.js";

/**
 * The builder's modal dialogs sit over the builder's own box, not the window (modal-place.ts):
 * a builder embedded in a page keeps its prompts, and their dimming, to itself.
 */

// The package folder is where its tests run from; under jsdom import.meta.url is no file address.
const BUILDER_DIR = join(process.cwd(), "form-engine", "builder");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sources(path);
    }
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

/** jsdom lays nothing out: the window's size and the shell's box are given by hand. */
function viewport(width: number, height: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: height });
}

function rectOf(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

/** A shell with its box, a panel inside it, and the panel's dialog two shadow roots down. */
function mountShell(box: DOMRect): { shell: HTMLElement; wrap: HTMLElement; dialog: HTMLDialogElement; setBox: (next: DOMRect) => void } {
  const shell = document.createElement("datum-builder");
  const shellRoot = shell.attachShadow({ mode: "open" });
  const wrap = document.createElement("div");
  wrap.setAttribute("data-shell", "wrap");
  const panel = document.createElement("datum-builder-properties");
  wrap.append(panel);
  shellRoot.append(wrap);
  const dialog = document.createElement("dialog");
  panel.attachShadow({ mode: "open" }).append(dialog);
  document.body.append(shell);
  let current = box;
  wrap.getBoundingClientRect = () => current;
  return { shell, wrap, dialog, setBox: (next) => (current = next) };
}

/** What the dialog was told: the four insets (top, right, bottom, left, as `inset` takes them) and the box's size. */
const vars = (dialog: HTMLElement): { inset: string; w: string; h: string } => ({
  inset: dialog.style.getPropertyValue("--db-modal-inset"),
  w: dialog.style.getPropertyValue("--db-modal-w"),
  h: dialog.style.getPropertyValue("--db-modal-h")
});
const top = (dialog: HTMLElement): string => vars(dialog).inset.split(" ")[0] ?? "";

afterEach(() => {
  document.body.replaceChildren();
});

describe("builder modal placement", () => {
  it("writes the builder's box onto the dialog as insets from the window and a size", () => {
    viewport(1440, 900);
    const { dialog } = mountShell(rectOf(100, 200, 1000, 600));
    placeModal(dialog);
    expect(vars(dialog)).toEqual({ inset: "200px 340px 100px 100px", w: "1000px", h: "600px" });
    expect(modalBox(dialog)).toEqual({ left: 100, top: 200, width: 1000, height: 600 });
  });

  it("keeps to the part of the builder that is in view", () => {
    viewport(1440, 900);
    // Scrolled so the builder starts above the window's top edge and ends below its bottom edge.
    const { dialog } = mountShell(rectOf(100, -150, 1000, 1400));
    placeModal(dialog);
    expect(vars(dialog)).toEqual({ inset: "0px 340px 0px 100px", w: "1000px", h: "900px" });
  });

  it("falls back to the window when too little of the builder is in view, clearing what it wrote", () => {
    viewport(1440, 900);
    const { dialog, setBox } = mountShell(rectOf(100, 200, 1000, 600));
    placeModal(dialog);
    expect(top(dialog)).toBe("200px");
    // Only a 100px strip of the builder is left at the window's bottom edge.
    setBox(rectOf(100, 800, 1000, 600));
    placeModal(dialog);
    expect(vars(dialog)).toEqual({ inset: "", w: "", h: "" });
    expect(modalBox(dialog)).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
  });

  it("leaves a dialog outside any builder to the window", () => {
    viewport(1440, 900);
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    placeModal(dialog);
    expect(dialog.getAttribute("style")).toBeNull();
    expect(modalBox(dialog)).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
  });

  it("uses the outermost host where there is no shell (a designer on its own)", () => {
    viewport(1440, 900);
    const designer = document.createElement("datum-form-builder");
    const dialog = document.createElement("dialog");
    designer.attachShadow({ mode: "open" }).append(dialog);
    document.body.append(designer);
    designer.getBoundingClientRect = () => rectOf(40, 60, 800, 500);
    placeModal(dialog);
    expect(vars(dialog)).toEqual({ inset: "60px 600px 340px 40px", w: "800px", h: "500px" });
  });

  it("follows the builder while the dialog is open, and stops when it closes", async () => {
    viewport(1440, 900);
    const { dialog, setBox } = mountShell(rectOf(100, 200, 1000, 600));
    dialog.setAttribute("open", "");
    followModalBox(dialog);
    expect(top(dialog)).toBe("200px");
    const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

    // The page scrolls under the modal dialog: the builder moves up, and the dialog with it.
    setBox(rectOf(100, 50, 1000, 600));
    window.dispatchEvent(new Event("scroll"));
    await frame();
    expect(top(dialog)).toBe("50px");

    setBox(rectOf(100, 120, 900, 600));
    window.dispatchEvent(new Event("resize"));
    await frame();
    expect(vars(dialog)).toMatchObject({ inset: "120px 440px 180px 100px", w: "900px" });

    // Closed: nothing follows any more.
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
    setBox(rectOf(100, 300, 1000, 600));
    window.dispatchEvent(new Event("scroll"));
    await frame();
    expect(top(dialog)).toBe("120px");
  });

  it("stops following a dialog a repaint took off the page", async () => {
    viewport(1440, 900);
    const { dialog, setBox } = mountShell(rectOf(100, 200, 1000, 600));
    dialog.setAttribute("open", "");
    followModalBox(dialog);
    dialog.remove();
    setBox(rectOf(100, 50, 1000, 600));
    window.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(top(dialog)).toBe("200px");
  });

  it("is the one place a builder dialog is opened modally", () => {
    // A dialog opened with a bare showModal() would sit in the middle of the window again.
    const bare = sources(BUILDER_DIR)
      .filter((path) => !path.endsWith("modal-place.ts"))
      .filter((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .some((line) => /\.showModal\(\)/.test(line) && !/^\s*(\*|\/\/|\/\*)/.test(line))
      )
      .map((path) => relative(BUILDER_DIR, path));
    expect(bare).toEqual([]);
  });

  it("has every dialog's styles read the builder's box", () => {
    // Each sheet that styles a <dialog> places it by the shared inset, and no rule of a dialog
    // (or of the two boxes inside one that are sized against it) sizes by the bare window.
    const sheets = sources(BUILDER_DIR).filter((path) => /^\s*(:host\(\[data-phone\]\) )?dialog\.[\w-]+ \{/m.test(readFileSync(path, "utf8")));
    expect(sheets.length).toBeGreaterThanOrEqual(5);
    for (const path of sheets) {
      const text = readFileSync(path, "utf8");
      const name = relative(BUILDER_DIR, path);
      expect(text.includes("${MODAL_INSET}"), `${name} places its dialog by MODAL_INSET`).toBe(true);
      const rules = text.match(/^[^\n{}]*(?:dialog\.|\.palette-box|\.ex-table-wrap)[^\n{}]*\{[^}]*\}/gm) ?? [];
      const windowSized = rules.filter((rule) => /\b100d?v[wh]\b|\b\d+v[wh]\b/.test(rule.replace(/var\(--db-modal-[hw], 100d?v[hw]\)/g, "")));
      expect(windowSized, `${name} sizes a dialog by the window`).toEqual([]);
    }
    expect(MODAL_INSET).toContain("--db-modal-inset");
  });
});
