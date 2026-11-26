import { describe, expect, it, vi } from "vitest";

import { BuilderController, normalizeTestsConfiguration } from "../form-engine/builder/controller/builder-controller.js";
import type { FormTestConfiguration } from "../form-engine/core/form-tests/form-test-types.js";

/**
 * The form's `tests` block lives on the controller beside the localization:
 * an undoable edit that announces one `change`, with a silent path for a host's initial feed.
 */

const ONE: FormTestConfiguration = { scenarios: [{ id: "test-1", source: 'test "a"\n  set x = 1\n' }] };
const TWO: FormTestConfiguration = { scenarios: [...ONE.scenarios, { id: "test-2", source: 'test "b"\n' }] };

function controller(): BuilderController {
  return new BuilderController({
    initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } }
  });
}

function reasons(ctrl: BuilderController): string[] {
  const seen: string[] = [];
  ctrl.on("change", (event) => seen.push(event.reason));
  return seen;
}

describe("the tests block on the controller", () => {
  it("is undefined on a new controller", () => {
    expect(controller().tests()).toBeUndefined();
  });

  it("stores a clone, so neither the caller nor a reader can edit the held block", () => {
    const ctrl = controller();
    const given = structuredClone(ONE);
    ctrl.setTests(given);
    given.scenarios[0]!.source = "changed";
    expect(ctrl.tests()).toEqual(ONE);
    ctrl.tests()!.scenarios.length = 0;
    expect(ctrl.tests()).toEqual(ONE);
  });

  it("drops malformed entries and collapses an empty list to undefined", () => {
    const ctrl = controller();
    ctrl.setTests({
      scenarios: [
        { id: "", source: "x" },
        { id: "ok", source: "keep" },
        { id: "ok", source: "a repeated id" },
        { id: 3, source: "x" },
        { id: "nosource" },
        null,
        "text"
      ]
    } as unknown as FormTestConfiguration);
    expect(ctrl.tests()).toEqual({ scenarios: [{ id: "ok", source: "keep" }] });
    ctrl.setTests({ scenarios: [{ id: "", source: "" }] });
    expect(ctrl.tests()).toBeUndefined();
    expect(normalizeTestsConfiguration({} as FormTestConfiguration)).toBeUndefined();
  });

  it("emits one change with reason edit, and undo and redo put the blocks back", () => {
    const ctrl = controller();
    const seen = reasons(ctrl);
    ctrl.setTests(ONE);
    expect(seen).toEqual(["edit"]);
    ctrl.setTests(TWO);
    expect(seen).toEqual(["edit", "edit"]);
    expect(ctrl.tests()).toEqual(TWO);
    ctrl.undo();
    expect(ctrl.tests()).toEqual(ONE);
    ctrl.undo();
    expect(ctrl.tests()).toBeUndefined();
    ctrl.redo();
    expect(ctrl.tests()).toEqual(ONE);
    ctrl.redo();
    expect(ctrl.tests()).toEqual(TWO);
  });

  it("is silent on a host's initial feed: no change, no history entry", () => {
    const ctrl = controller();
    const seen = reasons(ctrl);
    const could = ctrl.canUndo();
    ctrl.setTests(ONE, { silent: true });
    expect(seen).toEqual([]);
    expect(ctrl.canUndo()).toBe(could);
    expect(ctrl.tests()).toEqual(ONE);
  });

  it("announces nothing for the same data again", () => {
    const ctrl = controller();
    ctrl.setTests(ONE);
    const seen = reasons(ctrl);
    ctrl.setTests(structuredClone(ONE));
    expect(seen).toEqual([]);
    const before = ctrl.canUndo();
    ctrl.setTests(undefined);
    expect(seen).toEqual(["edit"]);
    expect(ctrl.canUndo()).toBe(before);
  });

  it("is kept when the tree is rebuilt, like the localization (the host feeds both with the form)", () => {
    const ctrl = controller();
    ctrl.setTests(ONE, { silent: true });
    ctrl.setOptions({ initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } } });
    expect(ctrl.tests()).toEqual(ONE);
  });

  it("lets a second editor read the leave guard in force, to chain over it", () => {
    const ctrl = controller();
    expect(ctrl.leaveGuardInForce()).toBeUndefined();
    const guard = { pending: () => true, subject: () => ({ kind: "rule" }), save: () => true, discard: () => undefined } as unknown as Parameters<BuilderController["setLeaveGuard"]>[0];
    ctrl.setLeaveGuard(guard);
    expect(ctrl.leaveGuardInForce()).toBe(guard);
    expect(ctrl.hasPendingLeaveGuard()).toBe(true);
    ctrl.setLeaveGuard(undefined);
    expect(ctrl.leaveGuardInForce()).toBeUndefined();
  });

  it("stacks a guard over the slot: the slot's owner cannot drop it, a leave asks it first and Save saves all that hold edits", () => {
    const ctrl = controller();
    const guard = (id: string, pending: boolean, saves = true) => ({
      pending: () => pending,
      subject: () => ({ id, label: id, blocked: false }),
      save: vi.fn(() => saves),
      discard: vi.fn()
    });
    const tests = guard("tests-panel", true);
    const release = ctrl.pushLeaveGuard(tests);
    // The Logic surface sets the slot on connect and clears it whole on disconnect.
    ctrl.setLeaveGuard(guard("logic", false));
    ctrl.setLeaveGuard(undefined);
    expect(ctrl.hasPendingLeaveGuard()).toBe(true);
    const logic = guard("logic", true);
    ctrl.setLeaveGuard(logic);
    let left = 0;
    expect(ctrl.requestLeave(() => (left += 1))).toBe(false);
    expect(ctrl.unsavedChangesPrompt()?.external?.id).toBe("tests-panel");
    ctrl.answerUnsavedChangesPrompt("save");
    expect(tests.save).toHaveBeenCalledTimes(1);
    expect(logic.save).toHaveBeenCalledTimes(1);
    expect(left).toBe(1);
    // Discard settles every guard holding edits.
    ctrl.requestLeave(() => (left += 1));
    ctrl.answerUnsavedChangesPrompt("discard");
    expect(tests.discard).toHaveBeenCalledTimes(1);
    expect(logic.discard).toHaveBeenCalledTimes(1);
    expect(left).toBe(2);
    // A refusal stops the leave.
    release();
    const refusing = guard("tests-panel", true, false);
    ctrl.pushLeaveGuard(refusing);
    ctrl.requestLeave(() => (left += 1));
    ctrl.answerUnsavedChangesPrompt("save");
    expect(left).toBe(2);
    expect(logic.save).toHaveBeenCalledTimes(1);
    // Released, the slot's guard is the one asked again.
    expect(ctrl.leaveGuardInForce()).toBe(logic);
  });
});
