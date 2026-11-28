// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { FormDefinition, ComponentNode } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { bodyHtml, drawDatum, settled, unmountAll } from "../live-datum-parts-kit.js";

afterEach(unmountAll);

function form(root: ComponentNode): FormDefinition {
  return { id: "f1", version: "1", schemaVersion: "1", root, localization: { defaultLocale: "en" } };
}

function runtime(root: ComponentNode): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
  return new FormRuntime(form(root), {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([])
  });
}

describe("runtime + rules integration", () => {
  it("recomputes effective visibility when a dependency value changes", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "hasPet", type: "checkbox", configuration: {} },
          {
            id: "petName",
            type: "text",
            configuration: {},
            rules: {
              visibleWhen: "hasPet = true"
            }
          }
        ]
      }
    };

    const rt = runtime(root);
    expect(rt.effectiveState("petName")?.visible).toBe(false);

    rt.setValue("hasPet", true);
    expect(rt.effectiveState("petName")?.visible).toBe(true);

    rt.setValue("hasPet", false);
    expect(rt.effectiveState("petName")?.visible).toBe(false);
  });

  it("folds ancestor visibility onto descendants", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "advanced", type: "checkbox", configuration: {} },
          {
            id: "section",
            type: "container",
            configuration: {},
            rules: {
              visibleWhen: "advanced"
            },
            children: {
              content: [{ id: "tuning", type: "text", configuration: {} }]
            }
          }
        ]
      }
    };

    const rt = runtime(root);
    expect(rt.effectiveState("tuning")?.visible).toBe(false);
    rt.setValue("advanced", true);
    expect(rt.effectiveState("tuning")?.visible).toBe(true);
  });

  it("applies calculation rules and writes back without marking dirty", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "price", type: "number", configuration: {} },
          { id: "qty", type: "number", configuration: {} },
          {
            id: "total",
            type: "number",
            configuration: {},
            rules: {
              value: "price * qty"
            }
          }
        ]
      }
    };

    const rt = runtime(root);
    rt.setValue("price", 5);
    rt.setValue("qty", 3);

    expect(rt.state().values.total).toBe(15);
    // Computed field is not user-dirty.
    expect([...rt.state().dirty]).toEqual(["price", "qty"]);
  });

  it("evaluates requiredWhen against current values", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "contactMethod", type: "text", configuration: {} },
          {
            id: "phone",
            type: "text",
            configuration: {},
            rules: {
              requiredWhen: 'contactMethod = "phone"'
            }
          }
        ]
      }
    };

    const rt = runtime(root);
    expect(rt.isRequired("phone")).toBe(false);
    rt.setValue("contactMethod", "phone");
    expect(rt.isRequired("phone")).toBe(true);
  });

  it("throws on a calculation rule cycle at construction", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "a", type: "number", configuration: {}, rules: { value: "b" } },
          { id: "b", type: "number", configuration: {}, rules: { value: "a" } }
        ]
      }
    };
    expect(() => runtime(root)).toThrow(/cycle/i);
  });

  it("gates wizard navigation on rules.navigationGating", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "step1", type: "step", configuration: {}, children: { content: [] } },
          {
            id: "step2",
            type: "step",
            configuration: {},
            children: { content: [] },
            rules: {
              navigationGating: "agreed = true"
            }
          }
        ]
      }
    };

    const rt = runtime(root);
    const blocked = await rt.navigate("step2");
    expect(blocked).toMatchObject({ ok: false, reason: "gating-rule" });

    rt.setValue("agreed", true);
    const allowed = await rt.navigate("step2");
    expect(allowed).toMatchObject({ ok: true, currentStepId: "step2" });
  });
});

describe("runtime + validation hidden-policy enforcement", () => {
  function requiredPipeline(requiredIds: string[]): ValidationPipeline {
    return new ValidationPipeline([
      {
        id: "required",
        version: "1.0.0",
        validate: (ctx) => ({
          errors: requiredIds
            .filter((id) => !ctx.values[id])
            .map((id) => ({
              code: "required",
              componentId: id,
              path: id,
              stage: "required",
              source: "client" as const
            }))
        })
      }
    ]);
  }

  function rt(root: ComponentNode, requiredIds: string[] = ["visibleReq", "petName"]): FormRuntime {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    return new FormRuntime(form(root), {
      submissionModes: modes,
      validationPipeline: requiredPipeline(requiredIds)
    });
  }

  const root = (): ComponentNode => ({
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "hasPet", type: "checkbox", configuration: {} },
        { id: "visibleReq", type: "text", configuration: {} },
        {
          id: "petName",
          type: "text",
          configuration: {},
          rules: {
            visibleWhen: "hasPet = true"
          }
        }
      ]
    }
  });

  it("drops required errors on hidden (skip) fields but keeps them on visible fields", async () => {
    const runtime = rt(root());
    const errors = await runtime.validate();
    const ids = errors.map((error) => error.componentId).sort();
    expect(ids).toEqual(["visibleReq"]);
  });

  it("re-applies the required error once the field becomes visible", async () => {
    const runtime = rt(root());
    runtime.setValue("hasPet", true);
    const errors = await runtime.validate();
    expect(errors.map((error) => error.componentId).sort()).toEqual(["petName", "visibleReq"]);
  });

  it("excludes hidden exclude-from-submission values from the canonical submission", async () => {
    const withExclude: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "visibleReq", type: "text", configuration: {} },
          {
            id: "secret",
            type: "text",
            configuration: { hidden: true, hiddenValueBehavior: "exclude-from-submission" }
          }
        ]
      }
    };
    const runtime = rt(withExclude, ["visibleReq"]);
    runtime.setValue("visibleReq", "ok");
    runtime.setValue("secret", "classified");

    const result = await runtime.submit("m", {
      form: { id: "f1", version: "1" },
      client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" }
    });

    expect(result.accepted).toBe(true);
    const values = (result.canonicalSubmission?.submission.values ?? {}) as Record<string, unknown>;
    expect(values).toEqual({ visibleReq: "ok" });
  });
});

describe("runtime + Required when", () => {
  const contactIs = (value: string): string => `contactMethod = ${JSON.stringify(value)}`;
  const root = (): ComponentNode => ({
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "contactMethod", type: "text", configuration: { label: "Contact" } },
        { id: "phone", type: "text", configuration: { label: "Phone" }, rules: { requiredWhen: contactIs("phone") } },
        { id: "name", type: "text", configuration: { label: "Name", required: true } },
        { id: "both", type: "text", configuration: { label: "Both", required: true }, rules: { requiredWhen: contactIs("never") } }
      ]
    }
  });
  function validating(tree: ComponentNode): FormRuntime {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    return new FormRuntime(form(tree), { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(tree)]) });
  }
  const codes = (errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>): string[] =>
    errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
  /** The `<label class="datum-form__field …">` block of one field in the rendered form. */
  const fieldMarkup = (html: string, id: string): string =>
    (html.match(/<label class="datum-form__field[^"]*"[\s\S]*?<\/label>/g) ?? []).find((block) => block.includes(`for="${id}"`)) ?? "";

  it("validate() holds a field to its rule only while it holds, and clears the error when it stops", async () => {
    const rt = validating(root());
    rt.setValue("name", "Ada");
    rt.setValue("both", "b");
    expect(codes(await rt.validate())).toEqual([]);

    rt.setValue("contactMethod", "phone");
    expect(rt.isRequired("phone")).toBe(true);
    expect(codes(await rt.validate())).toEqual(["phone:required"]);

    rt.setValue("phone", "555 0100");
    expect(codes(await rt.validate())).toEqual([]);

    rt.setValue("phone", "");
    rt.setValue("contactMethod", "email");
    expect(rt.isRequired("phone")).toBe(false);
    expect(codes(await rt.validate())).toEqual([]);
  });

  it("isRequired and requiredMap answer for a field that is only ticked, and for every component but the root", () => {
    const rt = validating(root());
    expect(rt.isRequired("name")).toBe(true);
    expect(rt.isRequired("phone")).toBe(false);
    expect(rt.isRequired("both")).toBe(true);
    expect(rt.isRequired("root")).toBe(false);
    expect([...rt.requiredMap()]).toEqual([
      ["contactMethod", false],
      ["phone", false],
      ["name", true],
      ["both", true]
    ]);
  });

  it("keeps a ticked field required while its rule is false, in the verdict and in the markup", async () => {
    const rt = validating(root());
    rt.setValue("name", "Ada");
    rt.setValue("contactMethod", "email");
    expect(codes(await rt.validate())).toEqual(["both:required"]);

    const drawn = await drawDatum(form(root()), {}, { runtime: rt });
    const html = bodyHtml(drawn);
    expect(fieldMarkup(html, "both")).toContain('aria-required="true"');
    expect(fieldMarkup(html, "both")).toContain('<span class="datum-form__required" aria-hidden="true">*</span>');
    expect(fieldMarkup(html, "phone")).toContain('aria-required="false"');
    expect(fieldMarkup(html, "phone")).not.toContain("datum-form__required");

    // The rule adds the marker to the unticked field as the answer changes.
    rt.setValue("contactMethod", "phone");
    await settled(drawn.form);
    expect(fieldMarkup(bodyHtml(drawn), "phone")).toContain('aria-required="true"');
  });
});
