import { describe, expect, it } from "vitest";

import type { FormDefinition, ComponentNode } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { FormEventType } from "../../form-engine/core/events/event-types.js";

function wizardForm(): FormDefinition {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "step1", type: "step", configuration: {}, children: { content: [] } },
        { id: "step2", type: "step", configuration: {}, children: { content: [] } },
        { id: "step3", type: "step", configuration: {}, children: { content: [] } }
      ]
    }
  };
  return { id: "wizard", version: "1", schemaVersion: "1", root };
}

function runtime(hooks = {}): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
  return new FormRuntime(wizardForm(), {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([]),
    hooks
  });
}

describe("navigation integration", () => {
  it("exposes wizard steps in document order", () => {
    expect(runtime().wizardSteps()).toEqual(["step1", "step2", "step3"]);
  });

  it("navigates forward and back, tracking navigation state and events", async () => {
    const rt = runtime();
    const events: string[] = [];
    rt.events().subscribe("*", (event) => {
      if (String(event.type).startsWith("NAVIGATION_")) {
        events.push(event.type);
      }
    });

    const first = await rt.next();
    expect(first).toMatchObject({ ok: true, currentStepId: "step1" });
    expect(rt.state().navigation.currentStepId).toBe("step1");
    expect(rt.state().navigation.mode).toBe("wizard");

    await rt.next();
    expect(rt.state().navigation.currentStepId).toBe("step2");
    expect([...rt.state().navigation.visitedSteps]).toEqual(["step1", "step2"]);

    const backResult = await rt.back();
    expect(backResult).toMatchObject({ ok: true, currentStepId: "step1" });

    expect(events).toEqual([
      FormEventType.NAVIGATION_STARTED,
      FormEventType.NAVIGATION_COMPLETED,
      FormEventType.NAVIGATION_STARTED,
      FormEventType.NAVIGATION_COMPLETED,
      FormEventType.NAVIGATION_STARTED,
      FormEventType.NAVIGATION_COMPLETED
    ]);
  });

  it("runs beforeNavigation hooks and lets a throwing hook veto the move", async () => {
    const seen: Array<{ fromStepId?: string; toStepId?: string }> = [];
    const rt = runtime({
      beforeNavigation: [
        (ctx: { fromStepId?: string; toStepId?: string }) => {
          seen.push({ ...ctx });
          if (ctx.toStepId === "step3") {
            throw new Error("gate closed");
          }
        }
      ]
    });

    await rt.navigate("step1");
    const blocked = await rt.navigate("step3");

    expect(blocked).toMatchObject({ ok: false, currentStepId: "step1", reason: "gate closed" });
    expect(rt.state().navigation.currentStepId).toBe("step1");
    expect(seen).toEqual([
      { toStepId: "step1", mode: "wizard" },
      { fromStepId: "step1", toStepId: "step3", mode: "wizard" }
    ]);
  });

  it("blocks navigation to an unknown step", async () => {
    const rt = runtime();
    const result = await rt.navigate("nope");
    expect(result).toMatchObject({ ok: false, reason: "unknown-step" });
  });

  it("reports boundary conditions for next/back", async () => {
    const rt = runtime();
    await rt.navigate("step3");
    expect(await rt.next()).toMatchObject({ ok: false, reason: "at-last-step" });
    await rt.navigate("step1");
    expect(await rt.back()).toMatchObject({ ok: false, reason: "at-first-step" });
  });
});
