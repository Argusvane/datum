import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { journeyPageFormIds, type Journey } from "../form-engine/core/schema/journey.js";
import type { JourneyView } from "../form-engine/core/journey/journey-types.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import type { FormError } from "../form-engine/core/errors/form-error.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildRenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import { NoopJourneyRenderKit } from "../form-engine/render/core/journey-render-kit.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { createJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-factory.js";
import { EagerJourneyReviewKit } from "../form-engine/render/core/journey-review-kit-eager.js";
import { defaultJourneyRenderKit, setDefaultJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-default.js";
import {
  buildJourneyMeta,
  journeyPageComponentIds,
  journeyPageComponents,
  journeyPageErrors,
  journeyPageTexts
} from "../form-engine/render/core/journey-render.js";
import { createJourneyPageFeature } from "../form-engine/render/live/journey-page.js";

// The renderer's side of the journey seam: the kit the render orchestrator calls
// through, with a Noop that draws a form whole and the eager kit that delegates to the
// journey-render functions unchanged.

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Your name", required: true } },
        { id: "email", type: "text", configuration: { label: "Email" } },
        { id: "city", type: "text", configuration: { label: "City" } }
      ]
    }
  };
}

const JOURNEY: Journey = {
  id: "apply",
  progress: "count",
  pages: [
    { id: "who", components: ["name", "email"] },
    { id: "place", components: ["city"] }
  ]
};

function view(pageId: string): JourneyView {
  const index = JOURNEY.pages.findIndex((page) => page.id === pageId);
  const page = JOURNEY.pages[index]!;
  const path = JOURNEY.pages.map((entry) => entry.id);
  return {
    journeyId: JOURNEY.id,
    journey: JOURNEY,
    pageId,
    page,
    kind: "questions",
    path,
    index,
    total: path.length,
    number: index + 1,
    completed: path.slice(0, index),
    frontierPageId: pageId,
    ...(index > 0 ? { backPageId: path[index - 1]! } : {}),
    final: index === path.length - 1,
    end: "end",
    members: journeyPageFormIds(page),
    pageOf: {},
    validation: { continue: "page", server: false, onUnavailable: "block" }
  };
}

const errors: FormError[] = [
  { code: "required", message: "Required", componentId: "name" } as FormError,
  { code: "required", message: "Required", componentId: "city" } as FormError
];

function request(extra: Record<string, unknown> = {}) {
  return {
    mode: "interactive" as const,
    root: form(),
    state: new FormStateStore("en").snapshot(),
    resolver,
    errors,
    ...extra
  };
}

describe("NoopJourneyRenderKit", () => {
  it("draws no journey chrome: no ids, no meta, no markup, models and errors as they are", async () => {
    const output = await buildRenderOutput(request());
    expect(NoopJourneyRenderKit.pageComponentIds(form(), ["name"])).toBeUndefined();
    expect(NoopJourneyRenderKit.buildMeta(form(), view("who"), { locale: "en" })).toBeUndefined();
    expect(NoopJourneyRenderKit.pageErrors(errors, { name: "alias" })).toBe(errors);
    expect(NoopJourneyRenderKit.pageComponents(output.components, view("who")).map((model) => model.id)).toEqual(
      output.components.map((model) => model.id)
    );
    expect(NoopJourneyRenderKit.pageTexts({ back: "Back" }, undefined)).toEqual({ back: "Back" });
    expect(NoopJourneyRenderKit.pageTexts(undefined, { back: "Prev" })).toBeUndefined();
    expect(Object.isFrozen(NoopJourneyRenderKit)).toBe(true);
  });

  it("imports no journey module by value (the entry may hold it)", () => {
    const source = readFileSync(new URL("../form-engine/render/core/journey-render-kit.ts", import.meta.url), "utf8");
    const valueImports = source.split("\n").filter((line) => /^import\s+(?!type\b)/.test(line));
    expect(valueImports).toEqual([]);
  });
});

describe("EagerJourneyRenderKit", () => {
  it("is the journey-render functions, unwrapped, with no Check answers kit (the journeys chunk's)", () => {
    const plain = createJourneyRenderKit();
    expect(plain.pageComponentIds).toBe(journeyPageComponentIds);
    expect(plain.pageErrors).toBe(journeyPageErrors);
    expect(plain.buildMeta).toBe(buildJourneyMeta);
    expect(plain.pageComponents).toBe(journeyPageComponents);
    expect(plain.pageTexts).toBe(journeyPageTexts);
    expect(plain.pageFeature).toBe(createJourneyPageFeature);
    expect(plain.id).toBe("datum-journey-render-kit-eager");
    expect(createJourneyRenderKit()).toBe(plain);
    expect(Object.isFrozen(plain)).toBe(true);
  });

  it("is the page kit over the real Check answers kit, one kit per review kit", () => {
    expect(createJourneyRenderKit(EagerJourneyReviewKit)).toBe(EagerJourneyRenderKit);
    expect(EagerJourneyRenderKit.id).toBe("datum-journey-render-kit-eager");
    expect(EagerJourneyRenderKit.pageErrors).toBe(journeyPageErrors);
    expect(EagerJourneyRenderKit.buildMeta).toBe(buildJourneyMeta);
    expect(EagerJourneyRenderKit.pageComponents).toBe(journeyPageComponents);
    expect(EagerJourneyRenderKit.pageTexts).toBe(journeyPageTexts);
    expect(Object.isFrozen(EagerJourneyRenderKit)).toBe(true);
    const page = EagerJourneyRenderKit.pageFeature?.();
    expect(typeof page?.summaryTarget).toBe("function");
    expect(typeof page?.focusOwner).toBe("function");
    // The page module of the kit with no Check answers kit routes nothing to review rows.
    const bare = createJourneyRenderKit().pageFeature?.();
    expect(bare?.summaryTarget).toBeUndefined();
    expect(bare?.focusOwner).toBeUndefined();
  });

  it("hands the live renderer a new page module per mount; the Noop has none", () => {
    const one = EagerJourneyRenderKit.pageFeature?.();
    const two = EagerJourneyRenderKit.pageFeature?.();
    expect(one?.id).toBe("journey-page");
    expect(typeof one?.quietNextPageFocus).toBe("function");
    expect(typeof one?.setPageRedirected).toBe("function");
    expect(one).not.toBe(two);
    expect(NoopJourneyRenderKit.pageFeature).toBeUndefined();
  });
});

describe("buildRenderOutput through a kit", () => {
  it("builds a plain form's output identically with the Noop kit, the eager kit and the default", async () => {
    const eager = await buildRenderOutput(request({ journeyKit: EagerJourneyRenderKit }));
    const noop = await buildRenderOutput(request({ journeyKit: NoopJourneyRenderKit }));
    const byDefault = await buildRenderOutput(request());
    expect(noop.meta).toEqual(eager.meta);
    expect(byDefault.meta).toEqual(eager.meta);
    expect(noop.meta.journey).toBeUndefined();
    expect(noop.components).toEqual(eager.components);
    expect(byDefault.components).toEqual(eager.components);
  });

  it("draws a journey page with the eager kit and the default, and the whole form with the Noop kit", async () => {
    const page = view("who");
    const eager = await buildRenderOutput(request({ journey: page, journeyKit: EagerJourneyRenderKit }));
    const byDefault = await buildRenderOutput(request({ journey: page }));
    const noop = await buildRenderOutput(request({ journey: page, journeyKit: NoopJourneyRenderKit }));

    expect(eager.meta.journey?.pageId).toBe("who");
    expect(byDefault.meta).toEqual(eager.meta);
    // The page's summary counts what it draws; the error on the other page is the form's.
    expect(eager.meta.errorSummary.byComponent).toEqual({ name: 1 });
    expect(eager.meta.errorSummary.formErrors.map((error) => error.componentId)).toEqual(["city"]);

    expect(noop.meta.journey).toBeUndefined();
    expect(noop.meta.errorSummary.byComponent).toEqual({ name: 1, city: 1 });
    expect(noop.meta.errorSummary.formErrors).toEqual([]);
  });

  it("moves a hosted field's errors with the eager kit and leaves them with the Noop kit", async () => {
    const hosted = { ...view("who"), hosts: { name: "email" } };
    const eager = await buildRenderOutput(request({ journey: hosted, journeyKit: EagerJourneyRenderKit }));
    const noop = await buildRenderOutput(request({ journey: hosted, journeyKit: NoopJourneyRenderKit }));
    expect(Object.keys(eager.meta.errorSummary.byComponent)).toEqual(["email"]);
    expect(noop.meta.errorSummary.byComponent).toEqual({ name: 1, city: 1 });
  });
});

// The default kit is the Noop one unless a host registers another, so the renderer
// entry names no journey chrome. The test setup registers the eager kit for the other suites;
// these cases clear the slot (as journey-engine-noop-parity.test.ts does for the engine) and
// put back what they found.
describe("the default render kit", () => {
  const SLOT = Symbol.for("datum.journeyRenderKit.default");
  const holder = globalThis as unknown as { [SLOT]?: unknown };
  let registered: unknown;

  beforeEach(() => {
    registered = holder[SLOT];
    delete holder[SLOT];
  });

  afterEach(() => {
    if (registered === undefined) {
      delete holder[SLOT];
    } else {
      holder[SLOT] = registered;
    }
  });

  it("is the Noop kit when nothing was registered, and whatever setDefaultJourneyRenderKit last set", () => {
    expect(defaultJourneyRenderKit()).toBe(NoopJourneyRenderKit);
    setDefaultJourneyRenderKit(EagerJourneyRenderKit);
    expect(defaultJourneyRenderKit()).toBe(EagerJourneyRenderKit);
    setDefaultJourneyRenderKit(NoopJourneyRenderKit);
    expect(defaultJourneyRenderKit()).toBe(NoopJourneyRenderKit);
  });

  it("draws a journey page's form whole by default, and the page once the eager kit is registered", async () => {
    const page = view("who");
    const plain = await buildRenderOutput(request({ journey: page }));
    expect(plain.meta.journey).toBeUndefined();
    expect(plain.components.map((model) => model.id)).toEqual(expect.arrayContaining(["name", "email", "city"]));

    setDefaultJourneyRenderKit(EagerJourneyRenderKit);
    const drawn = await buildRenderOutput(request({ journey: page }));
    expect(drawn.meta.journey?.pageId).toBe("who");
    expect(drawn.components.map((model) => model.id)).toContain("name");
  });
});
