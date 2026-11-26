import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A field whose minimum is above its maximum (a number's or a date's `min` and `max`, a text's
 * `minLength` and `maxLength`) is noted under the box as a warning, in the sentence the
 * definition's check gives it: the form ignores both limits. It is a note, never a problem, so
 * it holds no Save back.
 */

const LIMITS = "The minimum is above the maximum, so the form ignores both; swap them or remove one.";

function make(content: ComponentNode[]): BuilderController {
  return new BuilderController({ initialRoot: { id: "root", type: "form", configuration: {}, children: { content } } });
}

describe("limits that contradict each other", () => {
  it("are noted under the maximum as a warning, and are not a problem", () => {
    const ctrl = make([
      { id: "age", type: "number", configuration: { label: "Age", min: 10, max: 2 } },
      { id: "when", type: "date", configuration: { label: "When", min: "2026-12-01", max: "2026-01-01" } },
      { id: "name", type: "text", configuration: { label: "Name", minLength: 5, maxLength: 3 } },
      { id: "fine", type: "number", configuration: { label: "Fine", min: 1, max: 2 } }
    ]);
    expect(ctrl.notesOf("age")).toContainEqual({ target: "max", message: LIMITS, severity: "warning", code: "component.limits.inverted" });
    expect(ctrl.notesOf("when")).toContainEqual({ target: "max", message: LIMITS, severity: "warning", code: "component.limits.inverted" });
    expect(ctrl.notesOf("name")).toContainEqual({ target: "maxLength", message: LIMITS, severity: "warning", code: "component.limits.inverted" });
    expect(ctrl.notesOf("fine")).toEqual([]);
    expect(ctrl.problemsOf("age")).toEqual([]);
    expect(ctrl.problemsOf("name")).toEqual([]);
  });

  it("follow the draft: the note goes once the author swaps them", () => {
    const ctrl = make([{ id: "age", type: "number", configuration: { label: "Age", min: 10, max: 2 } }]);
    ctrl.select("age");
    ctrl.setDraftProperty("age", "max", 20);
    expect(ctrl.notesOf("age")).toEqual([]);
    expect(ctrl.commitDraft("age")).toBe(true);
  });
});
