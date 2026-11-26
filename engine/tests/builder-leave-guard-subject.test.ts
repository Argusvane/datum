import { describe, expect, it } from "vitest";

import { BuilderController, type LeaveGuard } from "../form-engine/builder/controller/builder-controller.js";

/**
 * `leaveGuardSubject()`: the id a held leave would name, read without raising
 * the prompt, so the browser-assistant tools can say exactly which editor outside the tree holds
 * unsaved edits (`unsaved-draft.componentId`).
 */

function guard(id: string, pending: boolean): LeaveGuard & { pending: () => boolean } {
  let holding = pending;
  return {
    pending: () => holding,
    subject: () => ({ id, label: id, blocked: false }),
    save: () => {
      holding = false;
      return true;
    },
    discard: () => {
      holding = false;
    }
  };
}

describe("BuilderController.leaveGuardSubject", () => {
  it("is undefined without a guard", () => {
    const controller = new BuilderController();
    expect(controller.leaveGuardSubject()).toBeUndefined();
    expect(controller.hasPendingLeaveGuard()).toBe(false);
  });

  it("names the installed guard's subject id, pending or not, and goes when the guard is removed", () => {
    const controller = new BuilderController();
    controller.setLeaveGuard(guard("languages-texts", true));
    expect(controller.leaveGuardSubject()).toBe("languages-texts");
    expect(controller.hasPendingLeaveGuard()).toBe(true);

    controller.setLeaveGuard(guard("languages-texts", false));
    expect(controller.leaveGuardSubject()).toBe("languages-texts");
    expect(controller.hasPendingLeaveGuard()).toBe(false);

    controller.setLeaveGuard(undefined);
    expect(controller.leaveGuardSubject()).toBeUndefined();
  });

  it("names the stacked guard that holds edits first, as the prompt would", () => {
    const controller = new BuilderController();
    controller.setLeaveGuard(guard("logic", true));
    const release = controller.pushLeaveGuard(guard("tests-panel", false));
    // The stacked one holds nothing: the slot's guard is what is in the way.
    expect(controller.leaveGuardSubject()).toBe("logic");
    const releaseHolding = controller.pushLeaveGuard(guard("tests-panel", true));
    expect(controller.leaveGuardSubject()).toBe("tests-panel");
    releaseHolding();
    release();
    expect(controller.leaveGuardSubject()).toBe("logic");
  });

  it("is the id the raised prompt names, and reading it raises none and moves nothing", () => {
    const controller = new BuilderController();
    controller.setLeaveGuard(guard("paper", true));
    let changes = 0;
    controller.on("change", () => {
      changes += 1;
    });
    const before = JSON.stringify(controller.snapshot());
    expect(controller.leaveGuardSubject()).toBe("paper");
    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    expect(changes).toBe(0);
    expect(JSON.stringify(controller.snapshot())).toBe(before);

    // The person's leave is held for the guard and names the same subject.
    let left = false;
    expect(controller.requestLeave(() => (left = true))).toBe(false);
    expect(left).toBe(false);
    expect(controller.unsavedChangesPrompt()).toMatchObject({ componentId: "paper", external: { id: "paper" } });
    controller.answerUnsavedChangesPrompt("stay");
  });
});
