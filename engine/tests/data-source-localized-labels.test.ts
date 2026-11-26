import { describe, expect, it } from "vitest";

import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import { resolveComponentOptionState, type DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildRuntimeRenderOutput, type RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import { StaticDataSourceProvider } from "../form-engine/data/providers/static-data-source-provider.js";
import { RemoteDataSourceProvider } from "../form-engine/data/providers/remote-data-source-provider.js";

/** Data-source items carry LocalizedText labels and descriptions; they resolve at render. */

const select: ComponentNode = { id: "country", type: "select", configuration: { data: { sourceId: "countries" } } };

const ITEMS = [
  {
    value: "CA",
    label: { default: "Canada", locales: { fr: "Canada (fr)" } },
    description: { default: "North", locales: { fr: "Nord" } }
  },
  { value: "US", label: { default: "USA", locales: { "fr-CA": "États-Unis" } } },
  { value: "MX", label: "Mexico", description: "" }
];

const resolverOf = (items: unknown[]): DataSourceResolver => ({ resolveDataSource: async () => ({ items: items as never }) });

describe("data-source option items with localized text", () => {
  it("resolves label and description in the filler's locale, plain strings as given, an empty description dropped", async () => {
    const state = await resolveComponentOptionState(resolverOf(ITEMS), select, undefined, undefined, { locale: "fr" });
    expect(state.status).toBe("ready");
    expect(state.items).toEqual([
      { value: "CA", label: "Canada (fr)", description: "Nord" },
      { value: "US", label: "USA" },
      { value: "MX", label: "Mexico" }
    ]);
  });

  it("falls back to default for a locale the text does not carry", async () => {
    const state = await resolveComponentOptionState(resolverOf(ITEMS), select, undefined, undefined, { locale: "de" });
    expect(state.items.map((item) => item.label)).toEqual(["Canada", "USA", "Mexico"]);
  });

  it("reads a label from its own languages only: neither the form's map nor the host's catalog has an address for it", async () => {
    const state = await resolveComponentOptionState(resolverOf(ITEMS), select, undefined, undefined, {
      locale: "fr-CA",
      translations: { "fr-CA": { components: { country: { options: { US: { label: { text: "Nope", source: "x" } } } } } } },
      translationCatalog: { "fr-CA": { components: { country: { options: { US: { label: "Nope" } } } } } }
    });
    expect(state.items[1]?.label).toBe("États-Unis");
  });

  it("still refuses an item whose label is neither a string nor a localized object", async () => {
    const state = await resolveComponentOptionState(resolverOf([{ value: "x", label: 7 }]), select);
    expect(state.status).toBe("error");
    expect(state.malformed).toBe(true);
  });

  it("the static provider hands localized items over untouched, the remote provider too", async () => {
    const staticAnswer = await new StaticDataSourceProvider("s", ITEMS as never).load({ sourceId: "s" }, { environment: "client", locale: "fr" } as never);
    expect(staticAnswer.items[0]?.label).toEqual(ITEMS[0]?.label);
    let url = "";
    const remote = new RemoteDataSourceProvider("r", "https://example.test/o", async (input) => {
      url = input;
      return new Response(JSON.stringify({ items: ITEMS }), { status: 200 });
    });
    const answer = await remote.load({ sourceId: "r" }, { environment: "client", locale: "fr" } as never);
    expect(answer.items).toEqual(ITEMS);
    expect(url).toContain("locale=fr");
  });
});

describe("the provisional answer memo is kept per locale", () => {
  function runtimeIn(locale: string): { runtime: RenderableRuntime; asked: string[] } {
    const form: ComponentNode = { id: "f", type: "form", configuration: {}, children: { content: [select] } };
    const asked: string[] = [];
    const state: FormState = {
      values: {},
      touched: new Set(),
      dirty: new Set(),
      validation: { valid: true },
      submission: { status: "idle", attempts: 0 },
      navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
      locale
    };
    const runtime: RenderableRuntime = {
      formRoot: () => form,
      state: () => state,
      errors: () => [],
      effectiveStatesMap: () => new Map(),
      requiredMap: () => new Map(),
      componentTree: () => new ComponentTree(form),
      resolveDataSource: async () => {
        asked.push(state.locale);
        return { items: [{ value: "CA", label: state.locale === "fr" ? "Canada FR" : "Canada EN" }] };
      }
    };
    return { runtime, asked };
  }

  const labelsOf = (output: Awaited<ReturnType<typeof buildRuntimeRenderOutput>>): Array<string | undefined> =>
    output.components.find((component) => component.id === "country")?.optionState?.items.map((item) => item.label) ?? [];

  it("a provisional build for another locale is pending, never the previous language's labels", async () => {
    const { runtime } = runtimeIn("en");
    const answerMemo = new Map();
    const en = await buildRuntimeRenderOutput(runtime, "interactive", { answerMemo });
    expect(labelsOf(en)).toEqual(["Canada EN"]);
    const again = await buildRuntimeRenderOutput(runtime, "interactive", { answerMemo, provisional: true });
    expect(labelsOf(again)).toEqual(["Canada EN"]);
    const fr = await buildRuntimeRenderOutput(runtime, "interactive", { answerMemo, provisional: true, locale: "fr" });
    expect(fr.components.find((component) => component.id === "country")?.optionState?.status).toBe("loading");
    expect(labelsOf(fr)).toEqual([]);
  });
});
