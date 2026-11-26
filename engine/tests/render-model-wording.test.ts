// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { buildRenderOutput, type RenderOrchestratorRequest } from "../form-engine/render/core/render-orchestrator.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { parseComponentPath } from "../form-engine/core/tree/component-path.js";
import { buildAccessibilitySemantics } from "../form-engine/core/accessibility/accessibility-semantics.js";
import { resolveFieldLocking } from "../form-engine/render/core/render-policy.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import type { FormError } from "../form-engine/core/errors/form-error.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { definitionOf, drawDatum, settled, unmountAll } from "./live-datum-parts-kit.js";

afterEach(unmountAll);

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

function form(configuration: Record<string, unknown> = {}): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration,
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Full name", description: "As on your passport" } },
        {
          id: "age",
          type: "number",
          configuration: { label: "Age", messages: { required: "Tell us your age." } }
        }
      ]
    }
  };
}

function error(id: string, code: string, componentId: string | undefined, extra: Partial<FormError> = {}): FormError {
  return { id, code, ...(componentId !== undefined ? { componentId } : {}), stage: "field", source: "client", ...extra };
}

async function render(root: ComponentNode, errors: FormError[], extra: Partial<RenderOrchestratorRequest> = {}) {
  return buildRenderOutput({
    mode: "interactive",
    root,
    state: new FormStateStore("en").snapshot(),
    resolver,
    errors,
    componentTree: new ComponentTree(root),
    ...extra
  });
}

describe("worded errors on the render model", () => {
  it("words each blocking error beside the error, in order, from the engine's defaults", async () => {
    const output = await render(form(), [error("e1", "required", "name")]);
    const model = output.components.find((c) => c.id === "name");
    expect(model?.blockingErrors).toHaveLength(1);
    expect(model?.errorMessages).toEqual(["This field is required"]);
    expect(model?.notices).toEqual([]);
  });

  it("layers the page's messages over the component's own, and the component's over the engine's", async () => {
    const output = await render(form(), [error("e1", "required", "age"), error("e2", "required", "name")], {
      wording: { messages: { required: "Page wins." } }
    });
    expect(output.components.find((c) => c.id === "age")?.errorMessages).toEqual(["Page wins."]);
    expect(output.components.find((c) => c.id === "name")?.errorMessages).toEqual(["Page wins."]);

    // A code the page leaves out keeps the component's own words, and the engine's where it has none.
    const unnamed = await render(form(), [error("e1", "required", "age"), error("e2", "required", "name")], {
      wording: { messages: { minLength: "Page: longer." } }
    });
    expect(unnamed.components.find((c) => c.id === "age")?.errorMessages).toEqual(["Tell us your age."]);
    expect(unnamed.components.find((c) => c.id === "name")?.errorMessages).toEqual(["This field is required"]);
  });

  it("words an error from the form's texts with the field's label", async () => {
    const output = await render(form(), [error("e1", "required", "name")], {
      wording: { texts: { "error.required": "Enter {{label}}" } }
    });
    expect(output.components.find((c) => c.id === "name")?.errorMessages).toEqual(["Enter full name"]);
  });

  it("keeps warnings and info apart as notices that never make the field invalid", async () => {
    const output = await render(form(), [
      error("w1", "careful", "name", { severity: "warning", message: "Check the spelling." }),
      error("i1", "tip", "name", { severity: "info", message: "Use your legal name." })
    ]);
    const model = output.components.find((c) => c.id === "name");
    expect(model?.blockingErrors).toEqual([]);
    expect(model?.errorMessages).toEqual([]);
    expect(model?.notices).toEqual([
      { code: "careful", severity: "warning", message: "Check the spelling." },
      { code: "tip", severity: "info", message: "Use your legal name." }
    ]);
    expect(model?.accessibility.invalid).toBe(false);
    expect(model?.accessibility.errorId).toBeUndefined();
    expect(model?.accessibility.noticeId).toBe("name__notice");
    // Nothing is described by an element the surface does not draw until it says it draws notices.
    expect(model?.accessibility.ariaDescribedBy).toEqual(["name__description"]);
    // The old rendering input stays whole: every error is still on `errors`.
    expect(model?.errors).toHaveLength(2);
  });

  it("describes the control by its notices after the description when the surface draws them", async () => {
    const output = await render(
      form(),
      [error("w1", "careful", "name", { severity: "warning", message: "Check." }), error("e1", "required", "name")],
      { accessibilityOptions: { describeNotices: true } }
    );
    const model = output.components.find((c) => c.id === "name");
    expect(model?.accessibility.ariaDescribedBy).toEqual(["name__description", "name__notice", "name__error"]);
    expect(model?.accessibility.invalid).toBe(true);
    expect(model?.blockingErrors.map((e) => e.code)).toEqual(["required"]);
    expect(model?.errorMessages).toHaveLength(1);
  });

  it("gives a notice id only when notices exist", () => {
    const none = buildAccessibilitySemantics({ componentId: "a", required: false, readonly: false, disabled: false, errors: [] });
    expect(none.noticeId).toBeUndefined();
    const some = buildAccessibilitySemantics({
      componentId: "a",
      required: false,
      readonly: false,
      disabled: false,
      errors: [error("w", "careful", "a", { severity: "warning" })]
    });
    expect(some.noticeId).toBe("a__notice");
    expect(some.invalid).toBe(false);
  });
});

describe("error summary entries on the render output", () => {
  it("lists blocking errors only, worded, with the control each goes to", async () => {
    const output = await render(form(), [
      error("e1", "required", "name"),
      error("w1", "careful", "name", { severity: "warning", message: "Check." }),
      error("e2", "required", "age")
    ]);
    expect(output.meta.errorSummary.entries).toEqual([
      { targetPath: "name", componentId: "name", label: "Full name", message: "This field is required", text: "Full name: This field is required", authored: false },
      { targetPath: "age", componentId: "age", label: "Age", message: "Tell us your age.", text: "Age: Tell us your age.", authored: true }
    ]);
    // The counts keep including every error.
    expect(output.meta.errorSummary.total).toBe(3);
    expect(output.meta.errorSummary.heading).toBe("2 errors");
  });

  it("words a form-level error as text ahead of the field entries", async () => {
    const output = await render(form(), [
      error("h1", "delivery.failed", undefined, { stage: "host", source: "server", message: "The form could not be sent." }),
      error("e1", "required", "name")
    ]);
    expect(output.meta.errorSummary.formEntries).toEqual([
      { message: "The form could not be sent.", text: "The form could not be sent." }
    ]);
    expect(output.meta.errorSummary.entries.map((entry) => entry.componentId)).toEqual(["name"]);
  });

  it("has no entries without errors, and uses the form's summaryEntry text", async () => {
    const clean = await render(form(), []);
    expect(clean.meta.errorSummary.entries).toEqual([]);
    expect(clean.meta.errorSummary.formEntries).toEqual([]);

    const themed = await render(form(), [error("e1", "required", "name")], {
      wording: { texts: { summaryEntry: "{{label}} - {{message}}" } }
    });
    expect(themed.meta.errorSummary.entries[0]?.text).toBe("Full name - This field is required");
  });

  it("names a data grid's row and goes to the row's control", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "lines",
            type: "dataGrid",
            configuration: { label: "Lines", minRows: 1 },
            collection: { collectionPath: "items" },
            children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU", required: true } }] }
          }
        ]
      }
    };
    const state = { ...new FormStateStore("en").snapshot(), values: { "items[0].sku": "a", "items[1].sku": "" } };
    const output = await render(root, [error("e1", "required", "sku", { path: parseComponentPath("items[1].sku") })], { state });
    expect(output.meta.errorSummary.entries).toEqual([
      {
        targetPath: "items[1].sku",
        componentId: "sku",
        label: "Row 2: SKU",
        message: "This field is required",
        text: "Row 2: SKU: This field is required",
        authored: false
      }
    ]);
    const rowModel = output.components.find((c) => c.id === "lines")?.rows?.entries[1]?.find((c) => c.id === "sku");
    expect(rowModel?.blockingErrors).toHaveLength(1);
    expect(rowModel?.errorMessages).toEqual(["This field is required"]);
  });
});

describe("summary entries say whether their message was written for the error", () => {
  const authoredOf = async (errors: FormError[], extra: Partial<RenderOrchestratorRequest> = {}) =>
    (await render(form(), errors, extra)).meta.errorSummary.entries.map((entry) => [entry.componentId, entry.message, entry.authored]);

  it("calls the engine's own sentence and a binding pack's wording default, and every author's or host's words authored", async () => {
    expect(await authoredOf([error("e1", "required", "name"), error("e2", "required", "age")])).toEqual([
      ["name", "This field is required", false],
      ["age", "Tell us your age.", true]
    ]);
    // A binding's language pack: its messages and its per-type texts are default wordings too.
    const pack = { messages: { en: { required: "Enter information to continue." } }, texts: { en: { "error.pattern": "Use the format, {{label}}." } } };
    expect(await authoredOf([error("e1", "required", "name"), error("e2", "pattern", "name")], { wording: { pack } })).toEqual([
      ["name", "Enter information to continue.", false],
      ["name", "Use the format, full name.", false]
    ]);
    // The page's catalog and the page's error texts are the host's words for the error.
    expect(await authoredOf([error("e1", "required", "name")], { wording: { messages: { required: "Page wording." } } })).toEqual([["name", "Page wording.", true]]);
    expect(await authoredOf([error("e1", "required", "name")], { wording: { texts: { "error.required": "Enter {{label}}" } } })).toEqual([["name", "Enter full name", true]]);
  });

  it("calls a message the error carries authored, unless the engine's own sentence stands in its place", async () => {
    // A server's code of its own, worded by the server.
    expect(await authoredOf([error("e1", "taken", "name", { source: "server", message: "That name is taken." })])).toEqual([["name", "That name is taken.", true]]);
    // An engine code a kernel baked an English message into reads as the engine's sentence: a default.
    expect(await authoredOf([error("e1", "date", "name", { source: "wasm", message: "Enter a real date" })])).toEqual([["name", "Enter a real date", false]]);
  });
});

describe("summary entries and the markup's summary", () => {
  it("say what the drawn summary says, field and row entries alike", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Full name", required: true } },
          {
            id: "lines",
            type: "dataGrid",
            configuration: { label: "Lines", minRows: 1 },
            collection: { collectionPath: "items" },
            children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU", required: true } }] }
          }
        ]
      }
    };
    const m = await drawDatum(definitionOf(root.children?.content ?? []));
    await m.runtime.validate();
    await settled(m.form);
    const output = await buildRuntimeRenderOutput(m.runtime, "interactive");
    const links = Array.from(m.root.querySelectorAll(".datum-form__summary a")).map((link) => link.textContent);
    expect(output.meta.errorSummary.entries).toHaveLength(2);
    expect(links).toEqual(output.meta.errorSummary.entries.map((entry) => entry.text));
  });
});

describe("field locking flags", () => {
  it("keeps readOnly, disabled and the mode lock as separate facts", () => {
    const configured = { readOnly: false, disabled: false };
    expect(resolveFieldLocking({ readOnlyByMode: false, workedOut: false, configured })).toEqual({ readOnly: false, disabled: false, lockedByMode: false });
    expect(resolveFieldLocking({ readOnlyByMode: false, workedOut: false, configured: { readOnly: true, disabled: false } })).toEqual({
      readOnly: true,
      disabled: false,
      lockedByMode: false
    });
    expect(resolveFieldLocking({ readOnlyByMode: false, workedOut: false, configured: { readOnly: false, disabled: true } })).toEqual({
      readOnly: false,
      disabled: true,
      lockedByMode: false
    });
    expect(resolveFieldLocking({ readOnlyByMode: true, workedOut: false, configured })).toEqual({ readOnly: true, disabled: false, lockedByMode: true });
    expect(resolveFieldLocking({ readOnlyByMode: false, workedOut: true, configured })).toEqual({ readOnly: true, disabled: false, lockedByMode: false });
  });

  it("lets the effective state replace the configuration", () => {
    expect(
      resolveFieldLocking({
        readOnlyByMode: false,
        workedOut: false,
        effective: { readonly: false, disabled: true },
        configured: { readOnly: true, disabled: false }
      })
    ).toEqual({ readOnly: false, disabled: true, lockedByMode: false });
  });

  it("puts the flags on the model by mode", async () => {
    const root = form({});
    const interactive = await render(root, []);
    expect(interactive.components.find((c) => c.id === "name")).toMatchObject({ readOnly: false, disabled: false, lockedByMode: false });
    const review = await render(root, [], { mode: "readonly" });
    expect(review.components.find((c) => c.id === "name")).toMatchObject({ readOnly: true, disabled: false, lockedByMode: true });
  });
});
