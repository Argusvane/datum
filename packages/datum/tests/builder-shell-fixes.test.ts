import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The shell's seams with its lazy surfaces: a host naming a panel asks the leave guard before it moves the workspace, a save lets Print write
 * what is still waiting, the Languages table is not rebuilt for a feed that changed nothing, and a
 * catalog the host swaps reaches the table. The reconnect case lives in builder-reconnect.test.ts.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const surface = (element: DatumFormBuilderElement): ShadowRoot | null => shell(element).querySelector("datum-builder-languages")?.shadowRoot ?? null;

async function mount(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("features", "-pdf");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

async function languages(element: DatumFormBuilderElement): Promise<ShadowRoot> {
  element.builder!.setWorkspace("languages");
  await until(() => surface(element)?.querySelector("[data-languages-row]"));
  return surface(element)!;
}

const cell = (root: ShadowRoot, key: string, locale: string): HTMLInputElement =>
  root.querySelector<HTMLInputElement>(`input[data-languages-cell="${key}"][data-languages-locale="${locale}"]`)!;

function type(input: HTMLInputElement, text: string): void {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

describe("a host naming a panel while Languages holds typed cells", () => {
  it("asks the leave guard instead of moving the workspace behind the surface's prompt", async () => {
    const element = await mount();
    const root = await languages(element);
    type(cell(root, "components/country/label", "fr-CA"), "Pays");
    await until(() => (shell(element).querySelector("datum-builder-languages") as unknown as { pendingCount: number }).pendingCount === 1);

    element.builder!.panel = "outline";
    // Held: still Languages, the panel unchanged, the prompt drawn in the surface that is on the page.
    expect(element.builder!.workspace).toBe("languages");
    expect(element.builder!.panel).not.toBe("outline");
    expect(shell(element).querySelector<HTMLElement>("[data-languages-host]")!.hidden).toBe(false);
    await until(() => surface(element)?.querySelector("dialog[data-prompt]"));

    // Discard lets the move run: the workspace and the panel both follow.
    surface(element)!.querySelector<HTMLButtonElement>("[data-unsaved-discard]")!.click();
    await until(() => element.builder!.panel === "outline");
    expect(element.builder!.workspace).toBe("form");
  });

  it("moves at once when nothing is held", async () => {
    const element = await mount();
    await languages(element);
    element.builder!.panel = "outline";
    expect(element.builder!.workspace).toBe("form");
    expect(element.builder!.panel).toBe("outline");
  });
});

describe("a save while Print still holds a typed value", () => {
  it("hands the host the form with the value in it", async () => {
    const element = await mount();
    let saved: string | undefined;
    element.fileActions = {
      save: () => {
        saved = ((element.definition.root.configuration as { print?: { header?: { end?: string } } } | undefined)?.print?.header ?? {}).end;
      }
    };
    element.builder!.setWorkspace("print");
    await until(() => shell(element).querySelector("datum-builder-print")?.shadowRoot?.querySelector('[data-print-slot="header.end"]'));
    const box = shell(element).querySelector("datum-builder-print")!.shadowRoot!.querySelector<HTMLInputElement>('[data-print-slot="header.end"]')!;
    type(box, "Typed just now");
    // The write waits a moment; the key does not.
    element.builder!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, composed: true, cancelable: true }));
    expect(saved).toBe("Typed just now");
  });
});

describe("the Languages table across a feed that changes nothing", () => {
  it("does no work for applyWorkspace: no texts are computed, nothing is rewritten", async () => {
    const element = await mount();
    const root = await languages(element);
    const main = root.querySelector("[data-languages-main]")!;
    // Counted as work, not as rewrites: the surface compares what it was handed before it paints, so
    // a feed that rebuilt nothing could still have recomputed the whole table once per setter.
    const computeTexts = vi.spyOn(shell(element).querySelector("datum-builder-languages") as unknown as { computeTexts(): unknown }, "computeTexts");
    let rewrites = 0;
    const watch = new MutationObserver((records) => {
      rewrites += records.filter((record) => record.type === "childList").length;
    });
    watch.observe(main, { childList: true });
    const inner = element.builder as unknown as { applyWorkspace(): void };
    inner.applyWorkspace();
    inner.applyWorkspace();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(computeTexts).not.toHaveBeenCalled();
    expect(rewrites).toBe(0);

    watch.disconnect();
  });
});

describe("a Languages chunk that arrives after the workspace moved on", () => {
  it("connects hidden, and draws once the author is back", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.setWorkspace("languages");
    builder.setWorkspace("form");
    await until(() => shell(element).querySelector("datum-builder-languages"));
    const surfaceEl = shell(element).querySelector("datum-builder-languages") as unknown as HTMLElement & { shown: boolean };
    expect(surfaceEl.shown).toBe(false);
    expect(shell(element).querySelector<HTMLElement>("[data-languages-host]")!.hidden).toBe(true);

    builder.setWorkspace("languages");
    await until(() => surface(element)?.querySelector("[data-languages-row]"));
    expect(surfaceEl.shown).toBe(true);
  });
});

describe("the host takes away the workspace the author is in while it holds typed cells", () => {
  const tab = (element: DatumFormBuilderElement): HTMLElement => shell(element).querySelector<HTMLElement>('[data-workspace-tab="languages"]')!;

  it.each([
    ["hidden-workspaces", (element: DatumFormBuilderElement) => (element.builder!.hiddenWorkspaces = ["languages"])],
    ["features", (element: DatumFormBuilderElement) => (element.builder!.features = "-languages")]
  ])("%s: discards them and leaves at once, with no prompt and no selected tab", async (_name, take) => {
    const element = await mount();
    const root = await languages(element);
    const surfaceEl = shell(element).querySelector("datum-builder-languages") as unknown as { pendingCount: number };
    type(cell(root, "components/country/label", "fr-CA"), "Pays");
    await until(() => surfaceEl.pendingCount === 1);

    take(element);

    expect(element.builder!.workspace).toBe("form");
    expect(surfaceEl.pendingCount).toBe(0);
    expect(element.controller!.unsavedChangesPrompt()).toBeUndefined();
    expect(element.controller!.hasPendingLeaveGuard()).toBe(false);
    expect(tab(element).hidden).toBe(true);
    expect(tab(element).getAttribute("aria-selected")).toBe("false");
    // Nothing was written: the typed cell was discarded, not applied.
    expect(JSON.stringify(element.definition)).not.toContain("Pays");
  });

  it("Logic: a leave question held for the open rule goes with the workspace", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.setWorkspace("logic");
    await until(() => shell(element).querySelector("datum-builder-logic")?.shadowRoot?.querySelector('[data-logic-rule="form:email:visibleWhen"]'));
    const logicRoot = shell(element).querySelector("datum-builder-logic")!.shadowRoot!;
    // Dirty the rule the way the logic tests do: a radio change, then ask to leave so the prompt is held.
    logicRoot.querySelector<HTMLButtonElement>('[data-logic-rule="form:email:visibleWhen"]')!.click();
    const clear = logicRoot.querySelector<HTMLInputElement>('[data-logic-hidden][value="clear"]')!;
    clear.checked = true;
    clear.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    builder.setWorkspace("form");
    expect(builder.workspace).toBe("logic");
    expect(element.controller!.unsavedChangesPrompt()?.external?.id).toBe("logic-rule");

    builder.features = "-logic";

    expect(builder.workspace).toBe("form");
    expect(element.controller!.unsavedChangesPrompt()).toBeUndefined();
    expect(element.controller!.hasPendingLeaveGuard()).toBe(false);
  });

  it("Languages: a leave question held for typed cells goes with the workspace", async () => {
    const element = await mount();
    const root = await languages(element);
    const surfaceEl = shell(element).querySelector("datum-builder-languages") as unknown as { pendingCount: number };
    type(cell(root, "components/country/label", "fr-CA"), "Pays");
    await until(() => surfaceEl.pendingCount === 1);
    element.builder!.setWorkspace("form");
    expect(element.builder!.workspace).toBe("languages");
    expect(element.controller!.unsavedChangesPrompt()?.external?.id).toBe("languages-texts");

    element.builder!.features = "-languages";

    expect(element.builder!.workspace).toBe("form");
    expect(element.controller!.unsavedChangesPrompt()).toBeUndefined();
    expect(element.controller!.hasPendingLeaveGuard()).toBe(false);
    expect(surfaceEl.pendingCount).toBe(0);
  });

  it("leaves a dirty Tests-panel scenario alone: only the removed workspace's own edits go", async () => {
    const element = await mount();
    const builder = element.builder!;
    builder.setWorkspace("logic");
    await until(() => builder.workspace === "logic");
    // The Tests panel stacks its own guard over the workspace's slot while a scenario is being edited;
    // the panel stays open in Form, so its work is not the removed workspace's to throw away.
    let discarded = 0;
    const off = element.controller!.pushLeaveGuard({
      pending: () => true,
      subject: () => ({ id: "tests-panel", label: "Scenario", blocked: false }),
      save: () => true,
      discard: () => {
        discarded += 1;
      }
    });

    builder.features = "-logic";

    expect(builder.workspace).toBe("form");
    expect(discarded).toBe(0);
    expect(element.controller!.hasPendingLeaveGuard()).toBe(true);
    expect(element.controller!.leaveGuardSubject()).toBe("tests-panel");
    off();
  });

  it("never draws a tab the host removed as the selected one, even when the move could not be made", async () => {
    const element = await mount();
    await languages(element);
    const inner = element.builder as unknown as { hiddenWorkspacesValue: string[]; applyWorkspace(): void };
    // The state a stalled move would leave: the workspace is no longer offered, the author still in it.
    inner.hiddenWorkspacesValue = ["languages"];
    inner.applyWorkspace();
    expect(element.builder!.workspace).toBe("languages");
    expect(tab(element).hidden).toBe(true);
    expect(tab(element).getAttribute("aria-selected")).toBe("false");
  });
});

describe("the inspector's On paper group follows the print feature", () => {
  const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;

  it("is drawn with print, and gone without it", async () => {
    const element = await mount();
    element.builder!.controller.select("fullName");
    await until(() => inspector(element).querySelector("[data-inspector-title]"));
    expect(inspector(element).querySelector('details[data-inspector-section="print"]')).not.toBeNull();

    element.builder!.features = "-print";
    await until(() => inspector(element).querySelector('details[data-inspector-section="print"]') === null);
    expect(inspector(element).querySelector('details[data-inspector-section="content"]')).not.toBeNull();

    element.builder!.features = undefined;
    await until(() => inspector(element).querySelector('details[data-inspector-section="print"]'));
  });
});

describe("Undo and Redo keys inside the lazy surfaces", () => {
  it("Print and Languages are given the same historyStep function the outline, fields and canvas have", async () => {
    const element = await mount();
    const builder = element.builder!;
    await languages(element);
    builder.setWorkspace("print");
    await until(() => shell(element).querySelector("datum-builder-print"));
    type HistoryOwner = HTMLElement & { historyStep?: (controller: unknown, direction: "undo" | "redo") => void };
    const owners = ["datum-builder-print", "datum-builder-languages", "datum-builder-outline", "datum-builder-canvas"].map(
      (tag) => shell(element).querySelector(tag) as HistoryOwner
    );
    const step = owners[0]!.historyStep;
    expect(step).toBeTypeOf("function");
    for (const owner of owners) {
      expect(owner.historyStep).toBe(step);
    }
    // It is the shell's one Undo: the mode on the page, the controller it is handed.
    const spy = vi.spyOn(builder, "historyStep");
    step!(element.controller, "redo");
    expect(spy).toHaveBeenCalledWith("redo", element.controller);
  });
});

describe("a translations source the host swaps while Languages is open", () => {
  it("shows the new catalog's entries, and none once the source is removed", async () => {
    const element = await mount();
    const builder = element.builder!;
    const catalog = (label: string) => ({ catalog: { "fr-CA": { components: { country: { label } } } } });
    builder.translationsSource = () => catalog("Pays (page A)");
    const root = await languages(element);
    const country = (): HTMLInputElement => cell(root, "components/country/label", "fr-CA");
    expect(country().value).toBe("Pays (page A)");
    expect(country().readOnly).toBe(true);

    builder.translationsSource = () => catalog("Pays (page B)");
    await until(() => country().value === "Pays (page B)");

    builder.translationsSource = undefined;
    await until(() => country().readOnly === false);
    expect(country().value).not.toContain("page");
  });
});
