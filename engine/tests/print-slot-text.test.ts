// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { normalizeDataGrids } from "../form-engine/core/schema/data-grid.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import {
  buildPrintDocument,
  buildPrintModel,
  localPrintDay,
  printPageCss,
  resolvePrintSlot,
  type PrintModel,
  type PrintSlotScope,
  type PrintSourceOptions
} from "../form-engine/render/print/index.js";

/**
 * A printed form's header and footer slots: literal text with placeholders read from one scope
 * (the title, the day, the page counters, the receipt, the host, the answers), plain text only,
 * reaching the page box as CSS strings.
 */

const scope = (extra: Partial<PrintSlotScope> = {}): PrintSlotScope => ({
  title: "Intake",
  date: "March 15, 2026",
  values: { name: "Ada", age: 36, agree: true, address: { city: "Ottawa" }, pets: ["cat"], "rows[0].x": "first", receipt: "a field named receipt" },
  hostContext: { office: "North", user: { id: 7 } },
  receipt: { reference: "GC-48213", amount: 12.5, nested: { at: "desk 4" }, list: [1], none: null },
  ...extra
});

describe("resolvePrintSlot", () => {
  it("reads the title and the day of printing", () => {
    expect(resolvePrintSlot("{{title}}", scope())).toEqual([{ text: "Intake" }]);
    expect(resolvePrintSlot("Printed {{ date }}", scope())).toEqual([{ text: "Printed March 15, 2026" }]);
  });

  it("leaves the page counters to the printer, under either spelling", () => {
    expect(resolvePrintSlot("Page {{page}} of {{pages}}", scope())).toEqual([{ text: "Page " }, { counter: "page" }, { text: " of " }, { counter: "pages" }]);
    expect(resolvePrintSlot("{{pageNumber}}/{{pageCount}}", scope())).toEqual([{ counter: "page" }, { text: "/" }, { counter: "pages" }]);
    // A counter alone prints, whatever else is empty.
    expect(resolvePrintSlot("{{receipt.missing}}{{page}}", scope())).toEqual([{ counter: "page" }]);
  });

  it("reads the receipt, which shadows a field stored at receipt", () => {
    expect(resolvePrintSlot("Ref {{receipt.reference}}", scope())).toEqual([{ text: "Ref GC-48213" }]);
    expect(resolvePrintSlot("{{receipt.nested.at}}", scope())).toEqual([{ text: "desk 4" }]);
    expect(resolvePrintSlot("{{receipt.reference}}", scope({ receipt: undefined }))).toBeUndefined();
  });

  it("reads the host's context as the rules do", () => {
    expect(resolvePrintSlot("{{host.office}} office", scope())).toEqual([{ text: "North office" }]);
    expect(resolvePrintSlot("{{host.user.id}}", scope())).toEqual([{ text: "7" }]);
    expect(resolvePrintSlot("{{host.office}}", scope({ hostContext: undefined }))).toBeUndefined();
  });

  it("reads a field's value path in the form scope", () => {
    expect(resolvePrintSlot("{{name}}", scope())).toEqual([{ text: "Ada" }]);
    expect(resolvePrintSlot("{{address.city}}", scope())).toEqual([{ text: "Ottawa" }]);
    expect(resolvePrintSlot("{{rows[0].x}}", scope())).toEqual([{ text: "first" }]);
  });

  it("prints strings and finite numbers only: an object, a list, a yes-or-no, null print nothing", () => {
    expect(resolvePrintSlot("{{age}} / {{receipt.amount}}", scope())).toEqual([{ text: "36 / 12.5" }]);
    for (const path of ["agree", "address", "pets", "receipt.list", "receipt.none", "receipt.nested", "receipt", "host.user", "missing", "constructor", "toString"]) {
      expect(resolvePrintSlot(`{{${path}}}`, scope()), path).toBeUndefined();
    }
    expect(resolvePrintSlot("{{n}}", scope({ values: { n: Number.NaN } }))).toBeUndefined();
    expect(resolvePrintSlot("{{n}}", scope({ values: { n: Number.POSITIVE_INFINITY } }))).toBeUndefined();
  });

  it("omits a slot whose value placeholders are all empty, whatever words surround them, and keeps literal text", () => {
    expect(resolvePrintSlot("", scope())).toBeUndefined();
    expect(resolvePrintSlot("   ", scope())).toBeUndefined();
    expect(resolvePrintSlot("{{missing}} {{host.missing}}", scope())).toBeUndefined();
    expect(resolvePrintSlot("{{title}}", scope({ title: undefined }))).toBeUndefined();
    expect(resolvePrintSlot("Ref: {{receipt.missing}}", scope())).toBeUndefined();
    expect(resolvePrintSlot("Reference {{receipt.reference}}", scope({ receipt: undefined }))).toBeUndefined();
    expect(resolvePrintSlot("Ref {{receipt.missing}} {{name}}", scope())).toEqual([{ text: "Ref  Ada" }]);
    expect(resolvePrintSlot("Page {{page}} · {{receipt.missing}}", scope())).toEqual([{ text: "Page " }, { counter: "page" }, { text: " · " }]);
    expect(resolvePrintSlot("Office copy", scope())).toEqual([{ text: "Office copy" }]);
    expect(resolvePrintSlot("{ not a placeholder }", scope())).toEqual([{ text: "{ not a placeholder }" }]);
  });

  it("keeps a value as plain text: braces in an answer are not read again", () => {
    expect(resolvePrintSlot("{{name}}", scope({ values: { name: "{{host.office}}" } }))).toEqual([{ text: "{{host.office}}" }]);
  });
});

describe("localPrintDay", () => {
  it("names the local calendar day", () => {
    expect(localPrintDay(new Date(2026, 2, 5, 23, 59))).toBe("2026-03-05");
    expect(localPrintDay(new Date(2026, 11, 31, 0, 1))).toBe("2026-12-31");
  });
});

function definition(children: ComponentNode[], configuration: Record<string, unknown>, extra: Partial<FormDefinition> = {}): FormDefinition {
  return {
    id: "slots",
    version: "1",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] },
    root: { id: "root", type: "form", configuration, children: { content: children } },
    ...extra
  } as FormDefinition;
}

function runtimeOf(form: FormDefinition, deps: { hostContext?: Record<string, unknown>; today?: string } = {}): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(normalizeDataGrids(form.root))]),
    ...deps
  } as never);
}

async function modelOf(runtime: FormRuntime, options: PrintSourceOptions = {}): Promise<PrintModel> {
  return buildPrintModel(runtime, { render: { journeyKit: EagerJourneyRenderKit }, today: "2026-03-15", ...options });
}

const fields: ComponentNode[] = [
  { id: "name", type: "text", configuration: { label: "Name" } },
  { id: "secret", type: "text", configuration: { label: "Secret", hidden: true } }
];

describe("slots on the printed form", () => {
  it("resolves every slot from the form's answers, the host, the receipt and the day", async () => {
    const form = definition(fields, {
      title: "Intake",
      print: {
        header: { start: "{{title}} — {{name}}", end: "{{host.office}}" },
        footer: { start: "Printed {{date}}", end: "Ref {{receipt.reference}} · {{page}}" }
      }
    });
    const runtime = runtimeOf(form, { hostContext: { office: "North" } });
    runtime.setValue("name", "Ada");
    const model = await modelOf(runtime, { notice: { data: { reference: "GC-48213" } } });
    expect(model.page.header).toEqual({ start: [{ text: "Intake — Ada" }], end: [{ text: "North" }] });
    expect(model.page.footer).toEqual({ start: [{ text: "Printed March 15, 2026" }], end: [{ text: "Ref GC-48213 · " }, { counter: "page" }] });
    // A notice with only its data draws nothing on paper.
    expect(model.notice).toBeUndefined();
    const css = printPageCss(model, "");
    expect(css).toContain('@top-left { content: "Intake — Ada";  white-space: nowrap; }');
    expect(css).toContain('@top-right { content: "North";  white-space: nowrap; }');
    expect(css).toContain('@bottom-left { content: "Printed March 15, 2026";  white-space: nowrap; }');
    expect(css).toContain('@bottom-right { content: "Ref GC-48213 · " counter(page);  }');
  });

  it("reads the day from the runtime when the call names none, in the print's locale", async () => {
    const form = definition(fields, { title: "Intake", print: { footer: { start: "{{date}}" } } });
    const runtime = runtimeOf(form, { today: "2026-07-01" });
    expect((await buildPrintModel(runtime, { render: { journeyKit: EagerJourneyRenderKit } })).page.footer.start).toEqual([{ text: "July 1, 2026" }]);
    expect((await buildPrintModel(runtime, { render: { journeyKit: EagerJourneyRenderKit }, locale: "fr" })).page.footer.start).toEqual([{ text: "1 juillet 2026" }]);
  });

  it("prints no answer a printed copy leaves out, and no line on a blank form that reads only answers", async () => {
    const form = definition(fields, { title: "Intake", print: { header: { start: "{{name}}|{{secret}}" } } });
    const runtime = runtimeOf(form);
    runtime.setValue("name", "Ada");
    runtime.setValue("secret", "hush");
    expect((await modelOf(runtime)).page.header.start).toEqual([{ text: "Ada|" }]);
    expect((await modelOf(runtime, { rendition: "blank" })).page.header.start).toBeUndefined();
  });

  it("translates a slot at form › print › <band> › <slot>", async () => {
    const authored = "Office copy";
    const form = definition(fields, { title: "Intake", print: { header: { end: authored } } }, {
      translations: { fr: { form: { print: { header: { end: { text: "Copie du bureau", source: sourceHash(authored) } } } } } }
    } as never);
    const runtime = runtimeOf(form);
    expect((await modelOf(runtime)).page.header.end).toEqual([{ text: "Office copy" }]);
    expect((await modelOf(runtime, { locale: "fr" })).page.header.end).toEqual([{ text: "Copie du bureau" }]);
  });

  it("leaves a slot off the page when all it reads is empty", async () => {
    const form = definition(fields, { print: { header: { start: "{{title}}", end: "{{receipt.reference}}" }, footer: { start: "", end: "{{page}}" } } });
    const model = await modelOf(runtimeOf(form));
    expect(model.page.header).toEqual({});
    expect(model.page.footer).toEqual({ end: [{ counter: "page" }] });
    const css = printPageCss(model, "");
    expect(css).not.toContain("@top-");
    expect(css).not.toContain("@bottom-left");
    expect(css).toContain("@bottom-right { content: counter(page);  }");
  });

  it("keeps a hostile value inert: one CSS string, nothing that closes the style element or the rule", async () => {
    const form = definition(fields, { title: "Intake", print: { header: { start: "{{name}}", end: "{{receipt.note}}" }, footer: { start: "{{host.who}}" } } });
    const hostile = 'x"; } body { display:none } @page { @top-left { content: "y';
    const runtime = runtimeOf(form, { hostContext: { who: "back\\slash\nnew line\r\nand </style><script>alert(1)</script>" } });
    runtime.setValue("name", "</style><script>alert(1)</script>");
    const model = await modelOf(runtime, { notice: { data: { note: hostile } } });
    const html = buildPrintDocument(model);
    const style = html.slice(html.lastIndexOf("<style>"), html.lastIndexOf("</style>") + "</style>".length);
    // The value never closes the style element, and no script reaches the document.
    expect(style.match(/<\/style/gi)).toHaveLength(1);
    expect(html).not.toMatch(/<script/i);
    expect(style).toContain('@top-left { content: "\\3c /style>\\3c script>alert(1)\\3c /script>";');
    expect(style).toContain('@top-right { content: "x\\"; } body { display:none } @page { @top-left { content: \\"y";');
    expect(style).toContain('@bottom-left { content: "back\\\\slash\\a new line\\a and \\3c /style>\\3c script>alert(1)\\3c /script>";');
    // The injected rules are only text inside the strings: one @page, no body rule but the renderer's own.
    const outside = style.replace(/content: "(?:[^"\\]|\\.)*"/g, "content: X");
    expect(outside.match(/@page/g)).toHaveLength(1);
    expect(outside).not.toContain("display:none");
  });
});
