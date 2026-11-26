import { describe, expect, it } from "vitest";

import {
  collectFieldConstraints,
  compilePattern,
  createFieldConstraintsStage,
  isEmptyValue
} from "../form-engine/validation/core/field-constraints.js";
import { validationCodesRaisedBy } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { ValidationContext } from "../form-engine/core/schema/contracts.js";
import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { DATA_GRID_ROWS_CAP, normalizeDataGrids } from "../form-engine/core/schema/data-grid.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";

function form(children: ComponentNode[]): ComponentNode {
  return { id: "root", type: "form", configuration: {}, children: { content: children } };
}

function contextFor(values: Record<string, unknown>, locale = "en"): ValidationContext {
  return { values, formId: "f", locale };
}

const POSTCODE = "[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9]";

describe("field constraints — reading the tree", () => {
  it("collects only the components that declare a constraint", () => {
    const constraints = collectFieldConstraints(
      form([
        { id: "name", type: "text", configuration: { label: "Name", required: true } },
        { id: "nickname", type: "text", configuration: { label: "Nickname" } },
        { id: "postcode", type: "text", configuration: { pattern: POSTCODE } }
      ])
    );
    expect(constraints.map((constraint) => constraint.componentId)).toEqual(["name", "postcode"]);
    expect(constraints[0]?.required).toBe(true);
    expect(constraints[1]?.pattern?.source).toBe(POSTCODE);
  });

  it("reads through a data-scoping container: value path nests, component id does not", () => {
    const constraints = collectFieldConstraints(
      form([
        {
          id: "applicant",
          type: "container",
          configuration: { scopeData: true },
          children: {
            content: [{ id: "email", type: "text", configuration: { required: true } }]
          }
        }
      ])
    );
    expect(constraints[0]).toMatchObject({ componentId: "email", path: "applicant.email" });
  });
});

describe("field constraints — what counts as empty", () => {
  it("treats blank, missing and empty collections as unfilled", () => {
    expect(isEmptyValue(undefined, "text")).toBe(true);
    expect(isEmptyValue(null, "text")).toBe(true);
    expect(isEmptyValue("   ", "text")).toBe(true);
    expect(isEmptyValue([], "select")).toBe(true);
    expect(isEmptyValue("a", "text")).toBe(false);
    expect(isEmptyValue(0, "number")).toBe(false);
  });

  it("counts an unticked checkbox as unanswered, but false elsewhere as an answer", () => {
    // A required consent box means "must be ticked"; nothing else reads false that way.
    expect(isEmptyValue(false, "checkbox")).toBe(true);
    expect(isEmptyValue(false, "toggle")).toBe(false);
  });

  it("counts a checkboxes group with nothing ticked as unanswered, touched or not", () => {
    // The group writes every option as a boolean, so an all-false object is what "nothing
    // selected" looks like after a tick and untick — it must mean what undefined means, or
    // a required group could be satisfied by touching it.
    expect(isEmptyValue(undefined, "checkboxes")).toBe(true);
    expect(isEmptyValue({}, "checkboxes")).toBe(true);
    expect(isEmptyValue({ email: false, phone: false }, "checkboxes")).toBe(true);
    expect(isEmptyValue({ email: true, phone: false }, "checkboxes")).toBe(false);
    // Only the checkboxes type reads an object this way.
    expect(isEmptyValue({ email: false }, "text")).toBe(false);
  });

  it("counts a number that is not finite as unanswered, as the null JSON carries it as", () => {
    // A calculation that divided by an empty or zero answer: a server judging the envelope sees null.
    for (const type of ["number", "text"]) {
      expect(isEmptyValue(Number.NaN, type)).toBe(true);
      expect(isEmptyValue(Number.POSITIVE_INFINITY, type)).toBe(true);
      expect(isEmptyValue(Number.NEGATIVE_INFINITY, type)).toBe(true);
    }
    expect(isEmptyValue(-0, "number")).toBe(false);
    expect(isEmptyValue(Number.MAX_VALUE, "number")).toBe(false);
  });
});

describe("field constraints — the validation stage", () => {
  const root = form([
    { id: "name", type: "text", configuration: { required: true } },
    {
      id: "postcode",
      type: "text",
      configuration: {
        pattern: POSTCODE,
        patternMessage: "Use the form A1A 1A1"
      }
    },
    { id: "consent", type: "checkbox", configuration: { required: true } }
  ]);

  // The definition's own translations word the message for the context's locale.
  const stage = createFieldConstraintsStage(root, {
    textSources: { translations: { "fr-CA": { components: { postcode: { patternMessage: { text: "Format A1A 1A1", source: sourceHash("Use the form A1A 1A1") } } } } } }
  });

  it("words a pattern's message from the context's catalog over its translations", () => {
    const own = createFieldConstraintsStage(root);
    const message = (extra: Record<string, unknown>) => {
      const result = own.validate({ ...contextFor({ name: "Ada", postcode: "nope", consent: true }), locale: "fr-CA", ...extra });
      return ("errors" in result ? result.errors : []).find((error) => error.code === "pattern")?.parameters?.message;
    };
    const map = { "fr-CA": { components: { postcode: { patternMessage: { text: "Carte", source: sourceHash("Use the form A1A 1A1") } } } } };
    const catalog = { "fr-CA": { components: { postcode: { patternMessage: "Catalogue" } } } };
    expect(message({ translations: map, catalog })).toBe("Catalogue");
    expect(message({ translations: map })).toBe("Carte");
    expect(message({ catalog })).toBe("Catalogue");
    expect(message({})).toBe("Use the form A1A 1A1");
  });

  it("reports a missing required value against the component id", () => {
    const result = stage.validate(contextFor({ consent: true }));
    expect("errors" in result ? result.errors : []).toEqual([
      { code: "required", componentId: "name", path: "name", stage: "field-constraints", source: "client" }
    ]);
  });

  it("reports an unticked required checkbox", () => {
    const result = stage.validate(contextFor({ name: "Ada", consent: false }));
    const errors = "errors" in result ? result.errors : [];
    expect(errors.map((error) => error.componentId)).toEqual(["consent"]);
  });

  it("passes a value that matches its pattern and fails one that does not", () => {
    const ok = stage.validate(contextFor({ name: "Ada", consent: true, postcode: "K1A 0B1" }));
    expect("errors" in ok ? ok.errors : []).toEqual([]);

    const bad = stage.validate(contextFor({ name: "Ada", consent: true, postcode: "nope" }));
    const errors = "errors" in bad ? bad.errors : [];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "pattern", componentId: "postcode" });
    expect(errors[0]?.parameters).toMatchObject({
      pattern: POSTCODE,
      message: "Use the form A1A 1A1"
    });
  });

  it("localizes the author's message", () => {
    const result = stage.validate(
      contextFor({ name: "Ada", consent: true, postcode: "nope" }, "fr-CA")
    );
    const errors = "errors" in result ? result.errors : [];
    expect(errors[0]?.parameters?.message).toBe("Format A1A 1A1");
  });

  it("anchors the pattern, exactly as the browser's own pattern attribute does", () => {
    // Unanchored, "xK1A 0B1x" would match — and the browser would still reject it, leaving
    // the form insisting a value is fine while refusing to submit it.
    const result = stage.validate(contextFor({ name: "Ada", consent: true, postcode: "xK1A 0B1x" }));
    expect("errors" in result ? result.errors : []).toHaveLength(1);
    expect(compilePattern("a|b")?.test("ab")).toBe(false);
    expect(compilePattern("a|b")?.test("a")).toBe(true);
  });

  it("leaves an empty optional value to the required check alone", () => {
    // No double-reporting: a blank field is missing, not malformed.
    const blank = createFieldConstraintsStage(
      form([{ id: "postcode", type: "text", configuration: { pattern: POSTCODE } }])
    ).validate(contextFor({ postcode: "" }));
    expect("errors" in blank ? blank.errors : []).toEqual([]);
  });

  it("judges a pattern this runtime cannot compile as the server does: refused under fail, skipped under warn", () => {
    const broken = createFieldConstraintsStage(
      form([{ id: "x", type: "text", configuration: { pattern: "[unclosed" } }])
    ).validate(contextFor({ x: "anything" }));
    expect(("errors" in broken ? broken.errors : []).map((error) => [error.code, error.parameters?.invalid])).toEqual([["pattern", true]]);
    const warned = createFieldConstraintsStage(form([{ id: "x", type: "text", configuration: { pattern: "[unclosed" } }]), { formulaErrors: "warn" }).validate(
      contextFor({ x: "anything" })
    );
    expect("errors" in warned ? warned.errors : []).toEqual([]);
    expect(compilePattern("[unclosed")).toBeUndefined();
    // A stray `)` and `(` pair up inside the anchors, so the source alone must compile.
    expect(compilePattern(")(a+)+(")).toBeUndefined();
  });

  // A pattern that repeats a repeat is not run unless the host allows it.
  it("does not run a pattern of a catastrophic shape, unless the host allows risky patterns", () => {
    const risky = form([{ id: "x", type: "text", configuration: { pattern: "(a+)+$" } }]);
    const hostile = { x: "a".repeat(40) + "!" };
    const started = Date.now();
    // Not run: under the default policy the answer cannot be shown to match and is refused, as the server refuses it.
    const refused = createFieldConstraintsStage(risky).validate(contextFor(hostile));
    expect(("errors" in refused ? refused.errors : []).map((error) => [error.code, error.parameters?.invalid, error.parameters?.risky])).toEqual([["pattern", true, true]]);
    expect(Date.now() - started).toBeLessThan(500);
    const explicit = createFieldConstraintsStage(risky, { riskyPatterns: "refuse", formulaErrors: "warn" }).validate(contextFor(hostile));
    expect("errors" in explicit ? explicit.errors : []).toEqual([]);
    // Allowed, it is the ordinary pattern: a short answer that fits it passes, one that does not fails.
    const allowed = createFieldConstraintsStage(risky, { riskyPatterns: "allow" });
    expect("errors" in allowed.validate(contextFor({ x: "aaa" })) ? (allowed.validate(contextFor({ x: "aaa" })) as { errors: unknown[] }).errors : []).toEqual([]);
    const mismatch = allowed.validate(contextFor({ x: "bbb" }));
    expect(("errors" in mismatch ? mismatch.errors : []).map((error) => error.code)).toEqual(["pattern"]);
  });

  it("runs as a deterministic stage in a pipeline", () => {
    const pipeline = new ValidationPipeline([createFieldConstraintsStage(root, { id: "fields" })]);
    const { merged } = pipeline.runDeterministic(contextFor({}));
    expect(merged.errors.map((error) => `${error.stage}:${error.componentId}`)).toEqual([
      "fields:name",
      "fields:consent"
    ]);
  });
});

describe("field constraints — length limits", () => {
  const root = form([
    { id: "handle", type: "text", configuration: { minLength: 3, maxLength: 8 } },
    { id: "bio", type: "textarea", configuration: { maxLength: 5, pattern: "[a-z]+" } }
  ]);
  const stage = createFieldConstraintsStage(root);
  const errorsOf = (values: Record<string, unknown>) => {
    const result = stage.validate(contextFor(values));
    return "errors" in result ? result.errors : [];
  };

  it("collects a field that declares only a length limit", () => {
    const constraints = collectFieldConstraints(root);
    expect(constraints.map((constraint) => constraint.componentId)).toEqual(["handle", "bio"]);
    expect(constraints[0]).toMatchObject({ required: false, minLength: 3, maxLength: 8 });
    expect(constraints[1]).toMatchObject({ maxLength: 5, pattern: { source: "[a-z]+" } });
  });

  it("reports too short and too long, with the numbers a message needs", () => {
    expect(errorsOf({ handle: "ab" })).toEqual([
      {
        code: "minLength",
        componentId: "handle",
        path: "handle",
        stage: "field-constraints",
        source: "client",
        parameters: { minLength: 3, length: 2 }
      }
    ]);
    expect(errorsOf({ handle: "abcdefghi" })[0]).toMatchObject({
      code: "maxLength",
      parameters: { maxLength: 8, length: 9 }
    });
    expect(errorsOf({ handle: "abc" })).toEqual([]);
    expect(errorsOf({ handle: "abcdefgh" })).toEqual([]);
  });

  it("counts characters the way a person does, not UTF-16 units", () => {
    // Two emoji are four code units but two characters: too short, not just right.
    expect(errorsOf({ handle: "🙂🙂" })[0]).toMatchObject({ code: "minLength", parameters: { length: 2 } });
    expect(errorsOf({ handle: "🙂🙂🙂" })).toEqual([]);
  });

  it("leaves an empty value to the required check, and refuses a non-string value as text", () => {
    expect(errorsOf({ handle: "   " })).toEqual([]);
    // A text answer is a string: a number is refused, never stored past the length limits.
    expect(errorsOf({ handle: 12 }).map((error) => error.code)).toEqual(["text"]);
  });

  it("reports the length before the pattern, one error per field", () => {
    expect(errorsOf({ bio: "ABCDEFG" }).map((error) => error.code)).toEqual(["maxLength"]);
    expect(errorsOf({ bio: "ABC" }).map((error) => error.code)).toEqual(["pattern"]);
    expect(errorsOf({ bio: "abc" })).toEqual([]);
  });

  it("ignores limits no value could meet, as it ignores a pattern that cannot compile", () => {
    const contradictory = createFieldConstraintsStage(
      form([{ id: "x", type: "text", configuration: { minLength: 9, maxLength: 2 } }])
    ).validate(contextFor({ x: "hello" }));
    expect("errors" in contradictory ? contradictory.errors : []).toEqual([]);
    expect(
      collectFieldConstraints(form([{ id: "y", type: "text", configuration: { minLength: 0, maxLength: -1 } }]))
    ).toEqual([]);
    // Floored: a limit of 2.9 is a limit of 2.
    expect(
      collectFieldConstraints(form([{ id: "z", type: "text", configuration: { maxLength: 2.9 } }]))[0]?.maxLength
    ).toBe(2);
  });
});

describe("field constraints — file limits", () => {
  const MB = 1024 * 1024;
  const root = form([
    { id: "doc", type: "file", configuration: { maxFileSizeMb: 1, accept: ".pdf, image/*" } },
    { id: "photos", type: "file", configuration: { multiple: true, accept: "image/*" } }
  ]);
  // A required file with no limits of its own, kept apart so it does not complain in every case above.
  const requiredRoot = form([{ id: "any", type: "file", configuration: { required: true } }]);
  const errorsIn = (tree: ComponentNode, values: Record<string, unknown>) => {
    const result = createFieldConstraintsStage(tree).validate(contextFor(values));
    return "errors" in result ? result.errors : [];
  };
  const errorsOf = (values: Record<string, unknown>) => errorsIn(root, values);
  const attachment = (name: string, type: string, size: number) => ({
    storage: "base64",
    name,
    type,
    size,
    data: ""
  });

  it("collects a file field's limits, and leaves a file field with none to the required check", () => {
    const constraints = collectFieldConstraints(root);
    expect(constraints.map((constraint) => constraint.componentId)).toEqual(["doc", "photos"]);
    // And how many attachments the field takes (one unless `multiple`, else `maxFiles`, else 100).
    expect(constraints[0]?.file).toEqual({ maxFileSize: MB, accept: [".pdf", "image/*"], maxFiles: 1 });
    expect(constraints[1]?.file).toEqual({ accept: ["image/*"], maxFiles: 100 });
    expect(collectFieldConstraints(requiredRoot)[0]).toMatchObject({ componentId: "any", required: true });
    expect(collectFieldConstraints(requiredRoot)[0]?.file).toBeUndefined();
  });

  it("reports a file over the limit, with the bytes and a readable label for the message", () => {
    expect(errorsOf({ doc: attachment("scan.pdf", "application/pdf", MB + 1) })).toEqual([
      {
        code: "maxFileSize",
        componentId: "doc",
        path: "doc",
        stage: "field-constraints",
        source: "client",
        parameters: {
          file: "scan.pdf",
          size: MB + 1,
          maxFileSize: MB,
          sizeLabel: "1 MB",
          maxFileSizeLabel: "1 MB"
        }
      }
    ]);
    expect(errorsOf({ doc: attachment("scan.pdf", "application/pdf", MB) })).toEqual([]);
  });

  it("reports a file of a type the field does not accept", () => {
    expect(errorsOf({ doc: attachment("notes.txt", "text/plain", 10) })).toEqual([
      {
        code: "fileType",
        componentId: "doc",
        path: "doc",
        stage: "field-constraints",
        source: "client",
        parameters: { file: "notes.txt", type: "text/plain", accept: ".pdf, image/*" }
      }
    ]);
    // Either token admits it: by extension or by MIME family.
    expect(errorsOf({ doc: attachment("scan.PDF", "", 10) })).toEqual([]);
    expect(errorsOf({ doc: attachment("me.heic", "image/heic", 10) })).toEqual([]);
  });

  it("checks every attachment of a multi-file field, and reports the first offender only", () => {
    const errors = errorsOf({
      photos: [attachment("a.png", "image/png", 10), attachment("b.pdf", "application/pdf", 10), attachment("c.txt", "text/plain", 10)]
    });
    expect(errors.map((error) => [error.code, error.parameters?.file])).toEqual([["fileType", "b.pdf"]]);
  });

  it("reports size before type, and an empty field only through required", () => {
    expect(errorsOf({ doc: attachment("big.txt", "text/plain", 2 * MB) }).map((error) => error.code)).toEqual([
      "maxFileSize"
    ]);
    expect(errorsIn(requiredRoot, {}).map((error) => error.code)).toEqual(["required"]);
    expect(errorsIn(requiredRoot, { any: [] }).map((error) => error.code)).toEqual(["required"]);
    expect(errorsIn(requiredRoot, { any: attachment("x.bin", "", 1) })).toEqual([]);
    // Something that is not an attachment at all (a stale string) is neither empty nor checkable:
    // It is refused as `file`, never waved through with the limits unchecked.
    expect(errorsOf({ doc: "C:\\fakepath\\x.exe" }).map((error) => error.code)).toEqual(["file"]);
  });
});

describe("validationCodesRaisedBy", () => {
  it("names each code the stage can raise for a tree, once, in the engine's order", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { required: true, pattern: "x" },
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name", required: true, maxLength: 40 } },
          { id: "again", type: "text", configuration: { label: "Again", required: true } },
          {
            id: "group",
            type: "fieldset",
            configuration: {},
            children: {
              content: [
                { id: "code", type: "text", configuration: { pattern: "^[A-Z]{3}$" } },
                { id: "doc", type: "file", configuration: { accept: "application/pdf", maxFileSizeMb: 2 } }
              ]
            }
          }
        ]
      }
    };
    expect(validationCodesRaisedBy(root)).toEqual(["required", "maxLength", "pattern", "fileType", "maxFileSize"]);
    // A field on its own yields its own codes; a container, its children's.
    expect(validationCodesRaisedBy(root.children!.content![0]!)).toEqual(["required", "maxLength"]);
    expect(validationCodesRaisedBy(root.children!.content![2]!)).toEqual(["pattern", "fileType", "maxFileSize"]);
    expect(validationCodesRaisedBy({ id: "note", type: "text", configuration: { label: "Note" } })).toEqual([]);
  });

  it("follows the stage's own reading: a min above the max counts for nothing, a limitless file field neither", () => {
    expect(validationCodesRaisedBy({ id: "t", type: "text", configuration: { minLength: 9, maxLength: 3 } })).toEqual([]);
    expect(validationCodesRaisedBy({ id: "t", type: "text", configuration: { minLength: 2 } })).toEqual(["minLength"]);
    expect(validationCodesRaisedBy({ id: "f", type: "file", configuration: {} })).toEqual([]);
    expect(validationCodesRaisedBy({ id: "f", type: "file", configuration: { maxFileSizeMb: 1 } })).toEqual(["maxFileSize"]);
  });
});

describe("field constraints — keys named like Object.prototype members", () => {
  it("reads only a value the answers hold themselves, as the validation kernel does", () => {
    const stage = createFieldConstraintsStage(
      form([
        { id: "constructor", type: "text", configuration: { required: true } },
        { id: "toString", type: "text", configuration: { required: true } },
        { id: "valueOf", type: "text", configuration: { minLength: 3 } }
      ])
    );
    const empty = stage.validate(contextFor({})) as { errors: Array<{ componentId?: string; code: string }> };
    expect(empty.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["constructor:required", "toString:required"]);

    const answered = stage.validate(contextFor({ constructor: "c", toString: "t", valueOf: "v" })) as {
      errors: Array<{ componentId?: string; code: string }>;
    };
    expect(answered.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["valueOf:minLength"]);
  });
});

describe("field constraints — Required when", () => {
  const byPhone: Expression = {
    kind: "binary",
    operator: "eq",
    left: { kind: "path", path: "contact" },
    right: { kind: "literal", value: "phone" }
  };
  const root = form([
    { id: "contact", type: "radio", configuration: {} },
    { id: "phone", type: "text", configuration: {}, rules: { requiredWhen: byPhone } },
    { id: "both", type: "text", configuration: { required: true }, rules: { requiredWhen: byPhone } }
  ]);
  const stage = createFieldConstraintsStage(root);
  const errorsOf = (values: Record<string, unknown>, requiredComponents?: Record<string, boolean>): string[] => {
    const context = contextFor(values);
    if (requiredComponents !== undefined) {
      context.requiredComponents = requiredComponents;
    }
    const result = stage.validate(context) as { errors: Array<{ componentId?: string; code: string }> };
    return result.errors.map((error) => `${error.componentId}:${error.code}`);
  };

  it("collects a field with only the rule, marked requiredWhen, its tick unset", () => {
    const constraints = collectFieldConstraints(root);
    expect(constraints.map((constraint) => constraint.componentId)).toEqual(["phone", "both"]);
    expect(constraints[0]).toMatchObject({ componentId: "phone", path: "phone", required: false, requiredWhen: true, type: "text" });
    expect(constraints[1]).toMatchObject({ required: true, requiredWhen: true });
    // The tick alone carries no requiredWhen key, so existing strict comparisons hold.
    expect(collectFieldConstraints(form([{ id: "name", type: "text", configuration: { required: true } }]))[0]).not.toHaveProperty("requiredWhen");
  });

  it("holds the field to the rule through requiredComponents: true refuses an empty answer, false or absent does not", () => {
    expect(errorsOf({ contact: "phone", both: "b" }, { phone: true })).toEqual(["phone:required"]);
    expect(errorsOf({ contact: "phone", both: "b", phone: "555" }, { phone: true })).toEqual([]);
    expect(errorsOf({ contact: "email", both: "b" }, { phone: false })).toEqual([]);
    expect(errorsOf({ contact: "email", both: "b" }, {})).toEqual([]);
    // No map at all — a host running the stage outside FormRuntime — and the tick alone counts.
    expect(errorsOf({ contact: "phone", both: "b" })).toEqual([]);
  });

  it("keeps the tick whatever the rule says: Required OR Required when", () => {
    expect(errorsOf({ contact: "email" }, { phone: false, both: false })).toEqual(["both:required"]);
    expect(errorsOf({ contact: "email" })).toEqual(["both:required"]);
    expect(errorsOf({ contact: "phone" }, { phone: true, both: true })).toEqual(["phone:required", "both:required"]);
  });

  it("lists required among the codes a rule-only field can raise", () => {
    expect(validationCodesRaisedBy(root.children!.content![1]!)).toEqual(["required"]);
    expect(validationCodesRaisedBy(root)).toEqual(["required"]);
    expect(validationCodesRaisedBy({ id: "contact", type: "radio", configuration: {} })).toEqual([]);
  });

  it("reads the map's own keys only: a component called constructor is required only when the map says so itself", () => {
    const named = createFieldConstraintsStage(form([{ id: "constructor", type: "text", configuration: {}, rules: { requiredWhen: byPhone } }]));
    const run = (requiredComponents: Record<string, boolean>): Array<string | undefined> => {
      const context = contextFor({});
      context.requiredComponents = requiredComponents;
      const result = named.validate(context) as { errors: Array<{ componentId?: string }> };
      return result.errors.map((error) => error.componentId);
    };
    expect(run({})).toEqual([]);
    expect(run({ constructor: true })).toEqual(["constructor"]);
    expect(run(Object.assign(Object.create(null) as Record<string, boolean>, { constructor: true }))).toEqual(["constructor"]);
    // A `true` the map only inherits is not the map's own word: without the own-key guard this
    // would read `true` through the prototype and refuse the empty answer.
    expect(run(Object.create({ constructor: true, phone: true }) as Record<string, boolean>)).toEqual([]);
  });

  it("collects the rule only where the fold reads it: a group, a static block, a data grid or a row field keeps its tick alone, and raises no required code", () => {
    const gated = form([
      { id: "contact", type: "radio", configuration: {} },
      { id: "extra", type: "fieldset", configuration: {}, rules: { requiredWhen: byPhone } },
      { id: "note", type: "html", configuration: {}, rules: { requiredWhen: byPhone } },
      { id: "orders", type: "dataGrid", configuration: {}, rules: { requiredWhen: byPhone } },
      {
        id: "items",
        type: "repeatingSection",
        configuration: {},
        collection: { itemFields: ["sku"], collectionPath: "items" },
        children: { content: [{ id: "sku", type: "text", configuration: {}, rules: { requiredWhen: byPhone } }, { id: "qty", type: "text", configuration: { required: true } }] }
      },
      { id: "ticked", type: "fieldset", configuration: { required: true }, rules: { requiredWhen: byPhone } }
    ]);
    const constraints = collectFieldConstraints(gated);
    // Only the ticks are collected; none of the rules is (the grid is, for its row count alone).
    expect(constraints.map((constraint) => constraint.componentId)).toEqual(["orders", "qty", "ticked"]);
    expect(constraints[0]?.required).toBe(false);
    expect(constraints.some((constraint) => "requiredWhen" in constraint)).toBe(false);
    // So the messages editor is offered no `required` for a code the stage never raises.
    expect(validationCodesRaisedBy(gated.children!.content![1]!)).toEqual([]);
    expect(validationCodesRaisedBy(gated.children!.content![2]!)).toEqual([]);
    expect(validationCodesRaisedBy(gated.children!.content![3]!)).toEqual([]);
    // Even a record that says so (a host's own map) cannot make the stage hold such a node to the rule.
    // (The ticks are read as before: `qty`'s at its own path, as the stage has always read a row field's.)
    const stage = createFieldConstraintsStage(gated);
    const context = contextFor({ contact: "phone", qty: "1", ticked: "x" });
    context.requiredComponents = { extra: true, note: true, orders: true, sku: true };
    const result = stage.validate(context) as { errors: Array<{ componentId?: string }> };
    expect(result.errors).toEqual([]);
    // A hand-written null is no rule either.
    const nulls = form([{ id: "a", type: "text", configuration: {}, rules: null } as unknown as ComponentNode, { id: "b", type: "text", configuration: {}, rules: { requiredWhen: null } } as unknown as ComponentNode]);
    expect(collectFieldConstraints(nulls)).toEqual([]);
  });
});

describe("a data grid's row count", () => {
  const grid = (configuration: Record<string, unknown>, collectionPath = "items"): ComponentNode => ({
    id: "items_grid",
    type: "dataGrid",
    configuration,
    collection: { collectionPath },
    children: { content: [{ id: "sku", type: "text", configuration: { required: true } }] }
  });
  const formOf = (...children: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: children } });

  it("is collected after the grid and before its fields, a grid with no bound included (held to the row cap)", () => {
    expect(collectFieldConstraints(formOf(grid({ minRows: 1, maxRows: 3 }))).map((constraint) => [constraint.componentId, constraint.path, constraint.rows])).toEqual([
      ["items_grid", "items", { collection: "items", min: 1, max: 3 }],
      ["sku", "sku", undefined]
    ]);
    expect(collectFieldConstraints(formOf(grid({}))).map((constraint) => [constraint.componentId, constraint.rows])).toEqual([
      ["items_grid", { collection: "items", min: 0 }],
      ["sku", undefined]
    ]);
    // A path written with brackets defines no key to count.
    expect(collectFieldConstraints(formOf(grid({ minRows: 1 }, "rows[0]"))).map((constraint) => constraint.componentId)).toEqual(["sku"]);
  });

  it("lists rows.min and rows.max among the codes the form raises", () => {
    expect(validationCodesRaisedBy(formOf(grid({ minRows: 1, maxRows: 3 })))).toEqual(["required", "rows.min", "rows.max"]);
    expect(validationCodesRaisedBy(formOf(grid({ maxRows: 3 })))).toEqual(["required", "rows.max"]);
    expect(validationCodesRaisedBy(formOf(grid({ minRows: 0 })))).toEqual(["required"]);
  });

  it("raises rows.min and rows.max against the grid at its collection path, with min or max and the count", () => {
    const stage = createFieldConstraintsStage(formOf(grid({ minRows: 2, maxRows: 3 })));
    const rows = (values: Record<string, unknown>) =>
      (stage.validate({ formId: "f", locale: "en", values }) as { errors: Array<{ code: string }> }).errors.filter((error) => error.code.startsWith("rows."));
    expect(rows({ "items[0].sku": "a" })).toEqual([{ code: "rows.min", componentId: "items_grid", path: "items", stage: "field-constraints", source: "client", parameters: { min: 2, count: 1 } }]);
    expect(rows({ items: [{}, {}, {}, {}] })).toEqual([{ code: "rows.max", componentId: "items_grid", path: "items", stage: "field-constraints", source: "client", parameters: { max: 3, count: 4 } }]);
    expect(rows({ "items[0].sku": "a", "items[1].sku": "b" })).toEqual([]);
  });

  it("holds a grid with no maximum to DATA_GRID_ROWS_CAP rows, as the kernel and adding a row do; the cap is not a code the form names", () => {
    const stage = createFieldConstraintsStage(formOf(grid({})));
    const rows = (values: Record<string, unknown>, dataGridRowBounds?: unknown) =>
      (stage.validate({ formId: "f", locale: "en", values, ...(dataGridRowBounds === undefined ? {} : { dataGridRowBounds }) } as ValidationContext) as { errors: Array<{ code: string; parameters?: unknown }> }).errors
        .filter((error) => error.code.startsWith("rows."))
        .map((error) => [error.code, error.parameters]);
    const full = Array.from({ length: DATA_GRID_ROWS_CAP }, () => ({ sku: "a" }));
    expect(rows({ items: full })).toEqual([]);
    expect(rows({ items: [...full, { sku: "a" }] })).toEqual([["rows.max", { max: DATA_GRID_ROWS_CAP, count: DATA_GRID_ROWS_CAP + 1 }]]);
    // A formula that resolved to nothing usable leaves the grid with no maximum of its own: the cap.
    expect(rows({ items: [...full, { sku: "a" }] }, { items_grid: { minRows: 0, maxRows: undefined } })).toEqual([["rows.max", { max: DATA_GRID_ROWS_CAP, count: DATA_GRID_ROWS_CAP + 1 }]]);
    expect(validationCodesRaisedBy(formOf(grid({})))).toEqual(["required"]);
    // The kernel says the same.
    const kernel = runKernel({ formId: "f", values: { items: [...full, { sku: "a" }] }, locale: "en", form: formOf(grid({})) }, [], undefined, formulaFunctionSignatures());
    expect(kernel.errors.map((error) => [error.code, error.parameters])).toEqual([["rows.max", { max: DATA_GRID_ROWS_CAP, count: DATA_GRID_ROWS_CAP + 1 }]]);
  });

  it("collects a grid whose bound is a formula, and names the codes it may raise", () => {
    const formula = (rules: Record<string, unknown>, configuration: Record<string, unknown> = {}): ComponentNode => ({ ...grid(configuration), rules: rules as NonNullable<ComponentNode["rules"]> });
    expect(collectFieldConstraints(formOf(formula({ minRows: "people" }))).map((constraint) => constraint.rows)).toEqual([
      { collection: "items", min: 0, minRule: true },
      undefined
    ]);
    expect(collectFieldConstraints(formOf(formula({ maxRows: "4" }, { minRows: 1 })))[0]?.rows).toEqual({ collection: "items", min: 1, maxRule: true });
    expect(validationCodesRaisedBy(formOf(formula({ minRows: "people" })))).toEqual(["required", "rows.min"]);
    expect(validationCodesRaisedBy(formOf(formula({ maxRows: "people" })))).toEqual(["required", "rows.max"]);
    // A cleared rule is no rule.
    expect(collectFieldConstraints(formOf(formula({ minRows: null })))[0]?.rows).toEqual({ collection: "items", min: 0 });
  });

  it("counts against the bounds the caller resolved, and keeps the fixed bounds for a grid it does not name", () => {
    const stage = createFieldConstraintsStage(formOf({ ...grid({ minRows: 2, maxRows: 3 }), rules: { minRows: "people" } as NonNullable<ComponentNode["rules"]> }));
    const rows = (values: Record<string, unknown>, dataGridRowBounds?: unknown) =>
      (stage.validate({ formId: "f", locale: "en", values, ...(dataGridRowBounds === undefined ? {} : { dataGridRowBounds }) } as ValidationContext) as { errors: Array<{ code: string; parameters?: unknown }> }).errors
        .filter((error) => error.code.startsWith("rows."))
        .map((error) => [error.code, error.parameters]);
    const values = { items: [{}, {}] };
    expect(rows(values)).toEqual([]);
    expect(rows(values, { items_grid: { minRows: 4, maxRows: 6 } })).toEqual([["rows.min", { min: 4, count: 2 }]]);
    expect(rows(values, { items_grid: { minRows: 0, maxRows: 1 } })).toEqual([["rows.max", { max: 1, count: 2 }]]);
    expect(rows(values, { items_grid: { minRows: 0, maxRows: undefined } })).toEqual([]);
    // Another grid's entry, or an inherited name, leaves the fixed bounds.
    expect(rows({ items: [{}] }, { other: { minRows: 0, maxRows: undefined } })).toEqual([["rows.min", { min: 2, count: 1 }]]);
    expect(rows({ items: [{}] }, Object.create({ items_grid: { minRows: 0, maxRows: undefined } }))).toEqual([["rows.min", { min: 2, count: 1 }]]);
  });

  // A stage built over the authored root (a host's own pipeline, the builder's
  // Try it) reads a grid as the kernel normalizes it, so the two verdicts are one.
  it("reads the root normalized: a grid with no binding, or bound elsewhere, is judged as the kernel judges it", () => {
    const unbound: ComponentNode = {
      id: "lines",
      type: "dataGrid",
      configuration: { minRows: 1 },
      children: { content: [{ id: "sku", type: "text", configuration: { required: true } }] }
    };
    const bound: ComponentNode = {
      id: "lines_grid",
      type: "dataGrid",
      configuration: { minRows: 2 },
      collection: { collectionPath: "lines" },
      children: { content: [{ id: "sku_field", type: "text", configuration: { required: true, dataKey: "sku" } }] }
    };
    const verdicts = (root: ComponentNode, values: Record<string, unknown>) => ({
      stage: (createFieldConstraintsStage(root).validate({ formId: "f", locale: "en", values }) as { errors: Array<{ code: string; componentId?: string; path?: string; parameters?: unknown }> }).errors.map(
        (error) => [error.code, error.componentId, error.path, error.parameters ?? null]
      ),
      kernel: runKernel({ formId: "f", locale: "en", form: root, values }, []).errors.map((error) => [error.code, error.componentId, error.path, error.parameters ?? null])
    });
    for (const root of [formOf(unbound), formOf(bound)]) {
      for (const values of [{}, { "lines[0].sku": "" }, { "lines[0].sku": "A", "lines[1].sku": "" }, { "lines[0].sku": "A", "lines[1].sku": "B", "lines[2].sku": "C" }]) {
        const { stage, kernel } = verdicts(root, values);
        expect(stage, `${root.children!.content![0]!.id} ${JSON.stringify(values)}`).toEqual(kernel);
      }
    }
    expect(verdicts(formOf(unbound), { "lines[0].sku": "" }).stage).toEqual([["required", "sku", "lines[0].sku", null]]);
    expect(verdicts(formOf(bound), {}).stage).toEqual([["rows.min", "lines_grid", "lines", { min: 2, count: 0 }]]);
    // The constraints read over the normalized tree are the ones read over the authored one.
    expect(collectFieldConstraints(formOf(unbound))).toEqual(collectFieldConstraints(normalizeDataGrids(formOf(unbound))));
    // A tree with no grid to rewrite is read as handed in, never copied or changed.
    const plain = formOf(grid({ minRows: 1 }));
    expect(normalizeDataGrids(plain)).toBe(plain);
    const before = JSON.stringify(plain);
    collectFieldConstraints(plain);
    expect(JSON.stringify(plain)).toBe(before);
  });
});
