// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { stepsFeature } from "../form-engine/render/live/steps.js";
import { cleanUp, definitionOf, mounted, runtimeOf, settled } from "./live-extras-kit.js";

/*
 * A step a rule hides (render/live/steps.ts, FormRuntime.next/back): listed by the indicator,
 * holding nothing, and passed over by Continue and Back, so the person never lands on an empty
 * step.
 */

afterEach(cleanUp);

const definition = () =>
  definitionOf([
    {
      id: "wizard",
      type: "steps",
      configuration: {},
      children: {
        content: [
          { id: "s1", type: "step", configuration: { label: "One" }, children: { content: [{ id: "q", type: "text", configuration: { label: "Q" } }] } },
          { id: "s2", type: "step", configuration: { label: "Two" }, rules: { visibleWhen: 'q = "yes"' }, children: { content: [{ id: "r", type: "text", configuration: { label: "R" } }] } },
          { id: "s3", type: "step", configuration: { label: "Three" }, children: { content: [{ id: "t", type: "text", configuration: { label: "T" } }] } }
        ]
      }
    } as ComponentNode
  ]);

async function drained(form: Parameters<typeof settled>[0]): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await settled(form);
  }
}

describe("live steps: a hidden step is passed over", () => {
  it("goes from the step before it to the step after it on Continue, and back on Back", async () => {
    const runtime = runtimeOf(definition());
    const { root, form } = await mounted(definition(), { runtime, features: [stepsFeature()] });
    const shown = (): string[] => Array.from(root.querySelectorAll<HTMLElement>("[data-step-panel]")).filter((panel) => !panel.hidden).map((panel) => panel.getAttribute("data-step-panel") ?? "");
    // Listed by the indicator all the same.
    expect(root.querySelectorAll("[data-step-select]")).toHaveLength(3);
    (root.querySelector("[data-step-next]") as HTMLElement).click();
    await drained(form);
    expect(runtime.state().navigation.currentStepId).toBe("s3");
    expect(shown()).toEqual(["s3"]);
    // The last step offers no Continue, and Back passes the hidden step too.
    expect(root.querySelector("[data-step-next]")).toBeNull();
    (root.querySelector("[data-step-prev]") as HTMLElement).click();
    await drained(form);
    expect(runtime.state().navigation.currentStepId).toBe("s1");
    expect(shown()).toEqual(["s1"]);
  });

  it("offers no way to open the hidden step from the indicator", async () => {
    const runtime = runtimeOf(definition());
    const { root, form } = await mounted(definition(), { runtime, features: [stepsFeature()] });
    // Shown once, so reached, then hidden by its rule.
    runtime.setValue("q", "yes");
    await settled(form);
    (root.querySelector("[data-step-next]") as HTMLElement).click();
    await drained(form);
    (root.querySelector("[data-step-next]") as HTMLElement).click();
    await drained(form);
    expect(runtime.state().navigation.currentStepId).toBe("s3");
    runtime.setValue("q", "no");
    await drained(form);
    (root.querySelector('[data-step-select="s2"]') as HTMLElement).click();
    await drained(form);
    expect(runtime.state().navigation.currentStepId).toBe("s3");
    (root.querySelector("[data-step-prev]") as HTMLElement).click();
    await drained(form);
    expect(runtime.state().navigation.currentStepId).toBe("s1");
  });

  it("is passed over by the runtime's next and back", async () => {
    const runtime = runtimeOf(definition());
    expect(await runtime.next()).toMatchObject({ ok: true, currentStepId: "s1" });
    expect(await runtime.next()).toMatchObject({ ok: true, currentStepId: "s3" });
    expect(await runtime.next()).toMatchObject({ ok: false, reason: "at-last-step" });
    expect(await runtime.back()).toMatchObject({ ok: true, currentStepId: "s1" });
    runtime.setValue("q", "yes");
    expect(await runtime.next()).toMatchObject({ ok: true, currentStepId: "s2" });
  });
});

describe("live steps: the step the form is on is hidden", () => {
  const hiddenFirst = () =>
    definitionOf([
      {
        id: "wizard",
        type: "steps",
        configuration: {},
        children: {
          content: [
            { id: "s1", type: "step", configuration: { label: "One" }, rules: { visibleWhen: 'r = "yes"' }, children: { content: [{ id: "q", type: "text", configuration: { label: "Q" } }] } },
            { id: "s2", type: "step", configuration: { label: "Two" }, children: { content: [{ id: "r", type: "text", configuration: { label: "R" } }] } },
            { id: "s3", type: "step", configuration: { label: "Three" }, children: { content: [{ id: "t", type: "text", configuration: { label: "T" } }] } }
          ]
        }
      } as ComponentNode
    ]);
  const panels = (root: ParentNode): string[] =>
    Array.from(root.querySelectorAll<HTMLElement>("[data-step-panel]"))
      .filter((panel) => !panel.hidden)
      .map((panel) => panel.getAttribute("data-step-panel") ?? "");

  it("shows the first step shown when the first step is hidden, with no Back to it", async () => {
    const runtime = runtimeOf(hiddenFirst());
    const { root, form } = await mounted(hiddenFirst(), { runtime, features: [stepsFeature()] });
    await drained(form);
    expect(panels(root)).toEqual(["s2"]);
    expect(root.querySelector("[data-step-prev]")).toBeNull();
    expect(root.querySelector("[data-step-next]")).not.toBeNull();
  });

  it("moves on to the next step shown when a rule hides the step on view", async () => {
    const runtime = runtimeOf(definition());
    const { root, form } = await mounted(definition(), { runtime, features: [stepsFeature()] });
    runtime.setValue("q", "yes");
    await settled(form);
    (root.querySelector("[data-step-next]") as HTMLElement).click();
    await drained(form);
    expect(panels(root)).toEqual(["s2"]);
    runtime.setValue("q", "no");
    await drained(form);
    expect(panels(root)).toEqual(["s3"]);
    // Back from there passes the hidden step.
    (root.querySelector("[data-step-prev]") as HTMLElement).click();
    await drained(form);
    expect(panels(root)).toEqual(["s1"]);
  });
});
