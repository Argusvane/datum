import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { languagesController } from "./fixtures/builder-languages.js";

/**
 * Language edits join the undo history: an add, a removal, a rename, a new
 * default and a host's direct write are each an entry of their own, and Undo and Redo move
 * them like any edit. One linear history, so a Form-canvas Undo steps back through them in
 * the order they were made, never skipping one and never undoing a component edit with one.
 */

const TWO = { supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }], defaultLocale: "en" };

const codes = (ctrl: BuilderController): string[] => (ctrl.localization()?.supportedLocales ?? []).map((entry) => (typeof entry === "string" ? entry : entry.code));

/** What the Languages workspace does for Add and Remove: one committed action per language that differs from `next`. */
function apply(ctrl: BuilderController, next: typeof TWO): boolean {
  const wanted = next.supportedLocales.map((entry) => entry.code);
  const have = codes(ctrl);
  const removed = have.filter((code) => !wanted.includes(code)).map((code) => ctrl.localizationActions.removeLocale(code));
  const added = wanted.filter((code) => !have.includes(code)).map((code) => ctrl.localizationActions.addLocale(code));
  return [...removed, ...added].every(Boolean);
}

describe("language edits in the history", () => {
  it("makes adding a language an entry: Undo takes it away, Redo puts it back", () => {
    const ctrl = languagesController(TWO);
    expect(ctrl.canUndo()).toBe(false);
    expect(apply(ctrl, { ...TWO, supportedLocales: [...TWO.supportedLocales, { code: "es" } as never] })).toBe(true);
    expect(codes(ctrl)).toEqual(["en", "fr", "es"]);
    expect(ctrl.canUndo()).toBe(true);
    ctrl.undo();
    expect(codes(ctrl)).toEqual(["en", "fr"]);
    expect(ctrl.canUndo()).toBe(false);
    ctrl.redo();
    expect(codes(ctrl)).toEqual(["en", "fr", "es"]);
  });

  it("makes removing a language with no text in it an entry too", () => {
    const ctrl = languagesController({ ...TWO, supportedLocales: [...TWO.supportedLocales, { code: "es" } as never] });
    expect(apply(ctrl, { ...TWO, supportedLocales: TWO.supportedLocales })).toBe(true);
    expect(codes(ctrl)).toEqual(["en", "fr"]);
    ctrl.undo();
    expect(codes(ctrl)).toEqual(["en", "fr", "es"]);
    ctrl.redo();
    expect(codes(ctrl)).toEqual(["en", "fr"]);
  });

  it("makes a rename of a language nothing is written in an entry, and keeps the canvas language with it", () => {
    const ctrl = languagesController({ ...TWO, supportedLocales: [...TWO.supportedLocales, { code: "es" } as never] });
    ctrl.setOptions({ locale: "es" });
    expect(ctrl.renameLocale("es", "es-MX")).toBe(true);
    expect(codes(ctrl)).toEqual(["en", "fr", "es-MX"]);
    expect(ctrl.currentLocale()).toBe("es-MX");
    ctrl.undo();
    expect(codes(ctrl)).toEqual(["en", "fr", "es"]);
    expect(ctrl.currentLocale()).toBe("es");
    ctrl.redo();
    expect(codes(ctrl)).toEqual(["en", "fr", "es-MX"]);
  });

  it("is one linear history: a component edit and a language edit undo in the order they were made", () => {
    const ctrl = languagesController(TWO);
    ctrl.add("text");
    const added = ctrl.snapshot().children!.content!.length;
    apply(ctrl, { ...TWO, supportedLocales: [...TWO.supportedLocales, { code: "es" } as never] });
    // The language is the last thing done, so it is the first thing undone — and the component stays.
    ctrl.undo();
    expect(codes(ctrl)).toEqual(["en", "fr"]);
    expect(ctrl.snapshot().children!.content!.length).toBe(added);
    ctrl.undo();
    expect(ctrl.snapshot().children!.content!.length).toBe(added - 1);
    expect(codes(ctrl)).toEqual(["en", "fr"]);
  });

  it("does not let a component edit made after a language edit take the language back", () => {
    const ctrl = languagesController(TWO);
    apply(ctrl, { ...TWO, supportedLocales: [...TWO.supportedLocales, { code: "es" } as never] });
    ctrl.add("text");
    ctrl.undo();
    expect(codes(ctrl)).toEqual(["en", "fr", "es"]);
  });

  it("records a host's direct write (setLocalization) as an entry, leaving the Save baseline where it was", () => {
    const ctrl = languagesController(TWO);
    ctrl.setLocalization({ ...TWO, supportedLocales: [...TWO.supportedLocales, { code: "es" } as never] });
    expect(codes(ctrl)).toEqual(["en", "fr", "es"]);
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
    expect(ctrl.canUndo()).toBe(true);
    ctrl.undo();
    expect(codes(ctrl)).toEqual(["en", "fr"]);
    ctrl.redo();
    expect(codes(ctrl)).toEqual(["en", "fr", "es"]);
    // Writing what the form already has is no step.
    const same = languagesController(TWO);
    same.setLocalization(TWO);
    expect(same.canUndo()).toBe(false);
  });

  it("keeps the silent write a mode makes to mirror the form's languages out of the history", () => {
    const ctrl = languagesController(TWO);
    ctrl.setLocalization({ ...TWO, supportedLocales: [...TWO.supportedLocales, { code: "es" } as never] }, { silent: true });
    expect(codes(ctrl)).toEqual(["en", "fr", "es"]);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("leaves an open root draft alone when a host writes the languages", () => {
    const ctrl = languagesController(TWO);
    ctrl.select(ctrl.rootId());
    ctrl.setDraftProperty(ctrl.rootId(), "title", "Drafting");
    ctrl.setLocalization({ ...TWO, supportedLocales: [...TWO.supportedLocales, { code: "es" } as never] });
    expect(ctrl.localization()?.supportedLocales?.length).toBe(3);
    // Only the title edit pends: the languages are no part of the draft.
    expect(ctrl.hasPendingChanges()).toBe(true);
    ctrl.discardDraft();
    expect(ctrl.hasPendingChanges()).toBe(false);
    expect(ctrl.localization()?.supportedLocales?.length).toBe(3);
  });

  it("makes each language action of the controller an entry of its own, taken back by one Undo", () => {
    const ctrl = languagesController(TWO);
    expect(ctrl.localizationActions.addLocale("es", "Español")).toBe(true);
    expect(ctrl.localizationActions.relabelLocale("es", "Castellano")).toBe(true);
    expect(ctrl.localizationActions.renameLocale("es", "es-MX")).toBe(true);
    expect(ctrl.localizationActions.makeDefaultLocale("fr")).toBe(true);
    expect(ctrl.localizationActions.removeLocale("es-MX")).toBe(true);
    expect(codes(ctrl)).toEqual(["en", "fr"]);
    expect(ctrl.localization()?.defaultLocale).toBe("fr");
    // The strings changed with the default: the French is the text now, and the English its translation.
    expect(ctrl.getProperty("root", "title")).toBe("Permis");
    for (let step = 0; step < 5; step += 1) {
      expect(ctrl.canUndo()).toBe(true);
      ctrl.undo();
    }
    expect(ctrl.canUndo()).toBe(false);
    expect(codes(ctrl)).toEqual(["en", "fr"]);
    expect(ctrl.localization()?.defaultLocale).toBe("en");
    expect(ctrl.getProperty("root", "title")).toBe("Permit");
    for (let step = 0; step < 5; step += 1) {
      ctrl.redo();
    }
    expect(codes(ctrl)).toEqual(["en", "fr"]);
    expect(ctrl.localization()?.defaultLocale).toBe("fr");
  });
});
