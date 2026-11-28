import { describe, expect, it } from "vitest";

import { createFormTextResolver } from "../form-engine/core/localization/form-texts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { buildReviewModel } from "../form-engine/render/core/journey-review.js";
import { foldPresentation, presentationNodes } from "../form-engine/render/core/presentation-tree.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { definitionOf, runtimeOf } from "./live-chrome-harness.js";

/** A group holding two fields; one journey step may ask a field of it on its own. */
const fields: ComponentNode[] = [
  {
    id: "box",
    type: "fieldset",
    configuration: { label: "Contact" },
    children: {
      content: [
        { id: "email", type: "text", configuration: { label: "Email" } },
        { id: "phone", type: "text", configuration: { label: "Phone" } }
      ]
    }
  }
];

function journeyRuntime(pages: Array<{ id: string; title: string; components: string[]; kind?: string }>) {
  return runtimeOf(definitionOf(fields, { journey: { journeys: [{ id: "j", pages }] } } as never));
}

describe("a field a step asks on its own and a later step's container holds", () => {
  it("is listed once on Check answers, under the earliest step", async () => {
    const runtime = journeyRuntime([
      { id: "p1", title: "Email", components: ["email"] },
      { id: "p2", title: "Contact", components: ["box"] },
      { id: "check", kind: "review", title: "Check", components: [] }
    ]);
    runtime.startJourney("j");
    runtime.setValue("email", "a@b.c");
    await runtime.nextPage();
    runtime.setValue("phone", "1");
    await runtime.nextPage();
    const view = runtime.journeyView()!;
    expect(view.pageId).toBe("check");
    const output = await buildRuntimeRenderOutput(runtime, "interactive", { journeyKit: EagerJourneyRenderKit });
    const model = buildReviewModel({ view, components: output.components, locale: "en", sources: {}, text: createFormTextResolver("en") })!;
    expect(model.sections.map((section) => [section.pageId, section.items.map((item) => item.key)])).toEqual([
      ["p1", ["email"]],
      ["p2", ["phone"]]
    ]);
  });
});

describe("a printed journey's pages", () => {
  const pageFields = async (pages: Array<{ pageId: string; members: string[] }>): Promise<Array<[string, string[]]>> => {
    const runtime = runtimeOf(definitionOf(fields));
    const output = await buildRuntimeRenderOutput(runtime, "readonly");
    const tree = foldPresentation(output, {
      locale: "en",
      journeyKit: EagerJourneyRenderKit,
      pages: pages.map((page) => ({ ...page, title: page.pageId }))
    });
    return tree.nodes.map((page) => [page.id, presentationNodes([page]).flatMap((node) => (node.kind === "field" ? [node.id] : []))]);
  };

  it("draws a field a container on an earlier page holds on that page alone", async () => {
    expect(await pageFields([{ pageId: "p1", members: ["box"] }, { pageId: "p2", members: ["email"] }])).toEqual([
      ["p1", ["email", "phone"]],
      ["p2", []]
    ]);
  });

  it("leaves a field an earlier page lists out of a later page's container", async () => {
    expect(await pageFields([{ pageId: "p1", members: ["email"] }, { pageId: "p2", members: ["box"] }])).toEqual([
      ["p1", ["email"]],
      ["p2", ["phone"]]
    ]);
  });
});
