import { describe, expect, it, vi } from "vitest";

import type { FormulaEditorModule } from "../form-engine/builder/formula/formula-editor-loader.js";
import type { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { JourneyDiagnostic } from "../form-engine/core/journey/journey-diagnostics.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { agentBuilder, contactRequestController, contactRequestRoot, okOf, refusalOf, uiStub } from "./fixtures/agent-builder.js";

/**
 * `check_form`: every area answers
 * with a finding that names its fix, or is listed under skipped; the lint and the journey
 * diagnostics run only when their chunk is already on the page (and run once it is, without a
 * revision); the host's whole-definition check is skipped bare and reported with a stub; the PDF
 * findings come from the page; drafts are excluded and named; the severity filter says what it
 * hid; and get_form / describe_builder count the same cached findings.
 */

type Finding = Record<string, unknown> & { area: string; code: string; severity: string; fix?: string; componentId?: string };

/** A tree with a problem in every area a bare controller can hold. */
function problemRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Checks" },
    children: {
      content: [
        { id: "first", type: "text", configuration: { label: "First", dataKey: "name" } },
        { id: "second", type: "text", configuration: { label: "Second", dataKey: "name" } },
        { id: "total", type: "number", configuration: { label: "Total" }, rules: { value: "summ(1)" } },
        { id: "note", type: "textarea", configuration: { label: "" }, rules: { visibleWhen: "nope = 1" } },
        { id: "untitled", type: "checkbox", configuration: { label: "Untitled field" } },
        { id: "pick", type: "select", configuration: { label: "Pick" } },
        {
          id: "rows",
          type: "dataGrid",
          configuration: { label: "Rows", minRows: 5, maxRows: 2, initialRows: 900 },
          children: { content: [{ id: "qty", type: "number", configuration: { label: "Qty" } }] }
        }
      ]
    }
  };
}

const PROBLEM_TESTS = {
  scenarios: [
    { id: "test-1", source: 'test "Bad"\n  set x to 1\n' },
    { id: "test-2", source: 'test "Ghost"\n  set ghost = 1\n' }
  ]
};

/** A formula editor module the lint can call: one warning per formula. */
function lintModule(): FormulaEditorModule {
  return {
    lintFormula: () => [{ message: "compares decimals with =.", start: 0, end: 1 }],
    scanFormula: () => []
  } as unknown as FormulaEditorModule;
}

function findingsOf(result: Record<string, unknown>): Finding[] {
  return result.findings as Finding[];
}

function codes(result: Record<string, unknown>, area: string): string[] {
  return findingsOf(result)
    .filter((finding) => finding.area === area)
    .map((finding) => finding.code);
}

/** A definition with one journey, for the journey area. */
function withJourney(controller: BuilderController): () => FormDefinition {
  return () => ({
    id: "contact-request",
    version: "1.0.0",
    schemaVersion: "1",
    root: controller.snapshot(),
    journey: { journeys: [{ id: "intake", pages: [{ id: "start", components: ["full_name"] }] }] }
  }) as unknown as FormDefinition;
}

describe("check_form areas", () => {
  it("reports every area's findings, each with a fix, errors first", async () => {
    const builder = agentBuilder({ root: problemRoot(), tests: PROBLEM_TESTS, host: { formulaEditorLoaded: lintModule } });
    const result = okOf(await builder.execute("check_form", {}));
    expect(codes(result, "dataKey")).toEqual(["duplicate-path", "duplicate-path"]);
    expect(codes(result, "formula")).toEqual(["unknownFunction", "unknownField"]);
    expect(codes(result, "lint")).toEqual(["lint"]);
    expect(codes(result, "content")).toEqual(["no-label", "untitled", "no-options", "no-submit-button"]);
    expect(codes(result, "rows")).toEqual(["rows-range", "rows-cap"]);
    expect(codes(result, "tests")).toEqual(["expectedEquals", "tests.set.unknownPath"]);
    expect(codes(result, "structure")).toContain("component.dataGrid.bounds");
    for (const finding of findingsOf(result)) {
      expect(typeof finding.fix, `${finding.area} ${finding.code}`).toBe("string");
      expect((finding.message as string).length).toBeGreaterThan(0);
    }
    const severities = findingsOf(result).map((finding) => finding.severity);
    expect(severities.indexOf("warning")).toBeGreaterThan(severities.lastIndexOf("error"));
    expect(findingsOf(result).find((finding) => finding.code === "unknownFunction")).toMatchObject({
      componentId: "total",
      label: "Total",
      propertyPath: "rules.value",
      span: { start: 0, end: 4, text: "summ" },
      fix: 'set_properties { componentId: "total", propertyPath: "rules.value" }'
    });
    expect(findingsOf(result).find((finding) => finding.code === "no-submit-button")?.fix).toBe('add_components with a button { action: "submit" }');
    expect(findingsOf(result).find((finding) => finding.code === "expectedEquals")).toMatchObject({ testId: "test-1", fix: 'write_test { id: "test-1" }' });
    expect(result).toMatchObject({ clean: false, ran: ["id", "dataKey", "formula", "lint", "structure", "content", "rows", "tests"] });
    expect((result.counts as { errors: number }).errors).toBe(5);
  });

  it("reports ids a loaded definition carries that the builder would never write", async () => {
    const controller = contactRequestController();
    const bad = contactRequestRoot();
    const content = bad.children?.content as ComponentNode[];
    content.push({ id: "9lives", type: "text", configuration: { label: "Lives" } }, { id: "email", type: "text", configuration: { label: "Email again" } });
    const proxy = new Proxy(controller, {
      get(target, key) {
        if (key === "snapshot") {
          return () => structuredClone(bad);
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
    });
    const builder = agentBuilder({ controller: proxy });
    const result = okOf(await builder.execute("check_form", {}));
    expect(findingsOf(result).filter((finding) => finding.area === "id")).toEqual([
      expect.objectContaining({ code: "duplicate-id", componentId: "email", fix: 'rename_component { componentId: "email", newId: "<an unused id>" }' }),
      expect.objectContaining({ code: "invalid-id", componentId: "9lives", fix: 'rename_component { componentId: "9lives", newId: "<a valid id>" }' })
    ]);
  });

  it("is clean on the contact-request form, listing what it skipped bare", async () => {
    const builder = agentBuilder();
    const result = okOf(await builder.execute("check_form", {}));
    expect(result).toMatchObject({ clean: true, total: 0, count: 0, findings: [], draftsExcluded: [] });
    expect(result.ran).toEqual(["id", "dataKey", "formula", "structure", "content", "rows", "tests"]);
    expect(result.skipped).toEqual([
      { area: "lint", reason: "chunk-unavailable" },
      { area: "structure", check: "formDefinitionProblem", reason: "not-applicable" },
      { area: "pdf", reason: "not-applicable" },
      { area: "journey", reason: "not-applicable" }
    ]);
    expect(result.definitionProblem).toBeUndefined();
  });
});

describe("check_form: a test that sets a path no field stores at", () => {
  it("is a tests.set.unknownPath warning naming the path; any other unknown name stays unknown-ref", async () => {
    const tests = { scenarios: [{ id: "test-1", source: 'test "Ghost"\n  set ghost = 1\n  expect phantom = 1\n' }] };
    const builder = agentBuilder({ root: problemRoot(), tests });
    const result = okOf(await builder.execute("check_form", {}));
    const found = findingsOf(result).filter((finding) => finding.area === "tests");
    expect(found.map((finding) => [finding.code, finding.severity])).toEqual([
      ["tests.set.unknownPath", "warning"],
      ["unknown-ref", "warning"]
    ]);
    expect(found[0]).toMatchObject({
      testId: "test-1",
      message: "Line 2: No field stores an answer at ghost, so the form keeps nothing there; the step still runs.",
      span: { text: "ghost" },
      fix: 'write_test { id: "test-1" }'
    });
  });
});

describe("check_form: limits that contradict each other", () => {
  it("are listed once, from the definition's check, though the builder notes them under the field", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { title: "Limits" },
      children: { content: [{ id: "age", type: "number", configuration: { label: "Age", min: 10, max: 2 } }] }
    };
    const builder = agentBuilder({ root, tests: null });
    const result = okOf(await builder.execute("check_form", {}));
    const found = findingsOf(result).filter((finding) => String(finding.message).endsWith("The minimum is above the maximum, so the form ignores both; swap them or remove one."));
    expect(found.map((finding) => [finding.area, finding.code])).toEqual([["structure", "component.limits.inverted"]]);
    expect(builder.controller.notesOf("age")).toHaveLength(1);
  });
});

describe("check_form: what the page holds", () => {
  it("runs the lint once the editor's chunk is on the page, at the same revision", async () => {
    let module: FormulaEditorModule | undefined;
    const builder = agentBuilder({ host: { formulaEditorLoaded: () => module } });
    const before = okOf(await builder.execute("check_form", {}));
    expect(before.skipped).toContainEqual({ area: "lint", reason: "chunk-unavailable" });
    module = lintModule();
    const after = okOf(await builder.execute("check_form", {}));
    expect(after.revision).toBe(before.revision);
    expect(after.ran).toContain("lint");
    expect(codes(after, "lint")).toEqual(["lint"]);
    expect(findingsOf(after).find((finding) => finding.area === "lint")).toMatchObject({ componentId: "message", propertyPath: "rules.requiredWhen", severity: "warning" });
  });

  it("reports the host's whole-definition check and its load gate, and skips the former bare", async () => {
    const builder = agentBuilder({
      host: {
        formDefinitionProblem: () => "The root component must have type form.",
        definitionProblem: () => "Components nest more than 32 levels deep."
      }
    });
    const result = okOf(await builder.execute("check_form", {}));
    expect(findingsOf(result).filter((finding) => finding.area === "structure")).toEqual([
      expect.objectContaining({ severity: "error", code: "structure-limit", message: "Components nest more than 32 levels deep." }),
      expect.objectContaining({ severity: "error", code: "definition", message: "The root component must have type form." })
    ]);
    expect(result.definitionProblem).toBe("Components nest more than 32 levels deep.");
    expect(result.skipped).not.toContainEqual(expect.objectContaining({ check: "formDefinitionProblem" }));
    expect(result.ran).toContain("structure");
  });

  it("reads the PDF findings from the page as warnings, once per revision, and skips them with the feature off", async () => {
    const pdfFindings = vi.fn(() => [{ code: "pdf-layout.no-default" as const, message: "No layout prints when no condition holds." }]);
    const builder = agentBuilder({ ui: { ...uiStub().ui, pdfFindings } as never });
    const result = okOf(await builder.execute("check_form", {}));
    expect(findingsOf(result).filter((finding) => finding.area === "pdf")).toEqual([
      expect.objectContaining({ severity: "warning", code: "pdf-layout.no-default", message: "No layout prints when no condition holds." })
    ]);
    expect(result.ran).toContain("pdf");
    okOf(await builder.execute("check_form", { severity: "error" }));
    okOf(await builder.execute("get_form", {}));
    expect(pdfFindings).toHaveBeenCalledTimes(1);

    const off = agentBuilder({ featureOn: { pdf: false }, ui: { ...uiStub().ui, pdfFindings } as never });
    const skipped = okOf(await off.execute("check_form", {}));
    expect(skipped.skipped).toContainEqual({ area: "pdf", reason: "feature-off" });
    expect(pdfFindings).toHaveBeenCalledTimes(1);
  });

  it("skips the journey area until its chunk is on the page, then reports its diagnostics", async () => {
    const controller = contactRequestController();
    let diagnostics: JourneyDiagnostic[] | undefined;
    const stub = uiStub();
    const ui = { ...stub.ui, journeyDiagnostics: () => diagnostics, workspaceProblems: () => ({ journeys: 2 }) };
    const builder = agentBuilder({ controller, ui, host: { definition: withJourney(controller) } });
    const waiting = okOf(await builder.execute("check_form", {}));
    expect(waiting.skipped).toContainEqual({ area: "journey", reason: "chunk-unavailable" });
    expect((waiting.counts as { byArea: Record<string, number> }).byArea.journey).toBe(2);
    diagnostics = [{ severity: "error", code: "journey.no-end", journeyId: "intake", message: "This journey never ends." } as JourneyDiagnostic];
    const loaded = okOf(await builder.execute("check_form", {}));
    expect(loaded.ran).toContain("journey");
    expect(findingsOf(loaded).filter((finding) => finding.area === "journey")).toEqual([
      expect.objectContaining({ severity: "error", code: "journey.no-end", journeyId: "intake", message: "This journey never ends." })
    ]);
    const bare = agentBuilder({ featureOn: { journeys: false } });
    expect(okOf(await bare.execute("check_form", {})).skipped).toContainEqual({ area: "journey", reason: "feature-off" });
  });
});

describe("check_form: filters and what reads it", () => {
  it("excludes the person's drafts and names them", async () => {
    const builder = agentBuilder();
    builder.controller.setDraftProperty("email", "label", "");
    const result = okOf(await builder.execute("check_form", {}));
    expect(result.draftsExcluded).toEqual(["email"]);
    expect(result.warnings).toEqual(["drafts-excluded: the person's unsaved edits on email were not part of this check."]);
    // Checked as committed: the draft's empty label is not a finding.
    expect(result.clean).toBe(true);
    expect(result.total).toBe(0);
  });

  it("filters by severity and says how many warnings it hid; counts stay whole", async () => {
    const builder = agentBuilder({ root: problemRoot(), tests: PROBLEM_TESTS });
    const all = okOf(await builder.execute("check_form", {}));
    const errors = okOf(await builder.execute("check_form", { severity: "error" }));
    const warnings = (all.counts as { warnings: number }).warnings;
    expect(findingsOf(errors).every((finding) => finding.severity === "error")).toBe(true);
    expect(errors.total).toBe((all.counts as { errors: number }).errors);
    expect(errors.counts).toEqual(all.counts);
    expect(errors.note).toEqual([`${warnings} warnings hidden by severity: error.`]);
    expect(all.note).toBeUndefined();
  });

  it("limits component findings to a subtree, keeps form-level ones, and refuses an unknown id", async () => {
    const root = contactRequestRoot();
    const details = (root.children?.content as ComponentNode[]).find((node) => node.id === "details") as ComponentNode;
    ((details.children?.content as ComponentNode[])[0] as ComponentNode).rules = { requiredWhen: "topic ==" };
    (root.children?.content as ComponentNode[]).push({ id: "lonely", type: "select", configuration: { label: "Lonely" } });
    const builder = agentBuilder({ root });
    const subtree = okOf(await builder.execute("check_form", { componentId: "details" }));
    expect(findingsOf(subtree).map((finding) => finding.componentId)).toEqual(["message"]);
    const whole = okOf(await builder.execute("check_form", {}));
    expect(findingsOf(whole).map((finding) => finding.componentId)).toEqual(["message", "lonely"]);
    const unknown = refusalOf(await builder.execute("check_form", { componentId: "detials" }));
    expect(unknown).toMatchObject({ code: "unknown-component", details: { componentId: "detials", closest: "details" } });
  });

  it("pages its findings", async () => {
    const builder = agentBuilder({ root: problemRoot(), tests: PROBLEM_TESTS });
    const first = okOf(await builder.execute("check_form", { limit: 2 }));
    expect(first).toMatchObject({ count: 2, truncated: true, nextOffset: 2 });
    const rest = okOf(await builder.execute("check_form", { offset: 2, limit: 500 }));
    expect((rest.count as number) + 2).toBe(first.total);
  });

  it("get_form.problems and describe_builder.counts.problems read the same findings", async () => {
    const builder = agentBuilder({ root: problemRoot(), tests: PROBLEM_TESTS });
    const checked = okOf(await builder.execute("check_form", { limit: 500 }));
    const all = findingsOf(checked);
    const described = okOf(await builder.execute("describe_builder", {}));
    expect((described.counts as { problems: number }).problems).toBe(all.length);
    const outline = okOf(await builder.execute("get_form", { limit: 1000 }));
    expect(outline.problems).toBe(all.filter((finding) => finding.componentId !== undefined).length);
    const pick = (outline.nodes as Array<{ id: string; problems?: number }>).find((node) => node.id === "pick");
    expect(pick?.problems).toBe(1);
  });

  it("a whole-definition check that throws skips that check only: the area still runs and reports the gate", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const builder = agentBuilder({
      host: {
        definitionProblem: () => "Too deep.",
        formDefinitionProblem: () => {
          throw new Error("boom");
        }
      }
    });
    const result = okOf(await builder.execute("check_form", {}));
    expect(result.ran).toContain("structure");
    expect(result.skipped).toContainEqual({ area: "structure", check: "formDefinitionProblem", reason: "not-applicable" });
    expect(result.skipped).not.toContainEqual({ area: "structure", reason: "not-applicable" });
    expect(codes(result, "structure")).toEqual(["structure-limit"]);
    expect(result.definitionProblem).toBe("Too deep.");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("an area that throws part way is skipped whole: none of its findings and no definitionProblem stay behind", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const controller = contactRequestController();
    // The gate answers, then the kernel's pass reads every key and meets one that throws.
    const definition = (): FormDefinition => {
      const whole = { id: "contact-request", version: "1.0.0", schemaVersion: "1", root: controller.snapshot() } as Record<string, unknown>;
      Object.defineProperty(whole, "pdf", {
        enumerable: true,
        get() {
          throw new Error("unreadable");
        }
      });
      return whole as unknown as FormDefinition;
    };
    const builder = agentBuilder({ controller, host: { definition, definitionProblem: () => "Too deep." } });
    const result = okOf(await builder.execute("check_form", {}));
    expect(result.skipped).toContainEqual({ area: "structure", reason: "not-applicable" });
    expect(result.ran).not.toContain("structure");
    expect(codes(result, "structure")).toEqual([]);
    expect(result.definitionProblem).toBeUndefined();
    expect(result.clean).toBe(true);
    error.mockRestore();
  });

  it("a formula editor probe that throws skips the lint only: check_form, get_form and describe_builder still answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const builder = agentBuilder({
      host: {
        formulaEditorLoaded: () => {
          throw new Error("probe boom");
        }
      }
    });
    // get_form first: its read is the one that computes the findings at this revision.
    okOf(await builder.execute("get_form", {}));
    okOf(await builder.execute("describe_builder", {}));
    const checked = okOf(await builder.execute("check_form", {}));
    expect(checked.skipped).toContainEqual({ area: "lint", reason: "chunk-unavailable" });
    expect(checked.ran).toEqual(["id", "dataKey", "formula", "structure", "content", "rows", "tests"]);
    error.mockRestore();
  });

  it("a formula area that throws part way skips the lint as not-applicable, with none of the lint it gathered", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { title: "Two rules" },
      children: {
        content: [
          { id: "a", type: "text", configuration: { label: "A" }, rules: { visibleWhen: 'b = "x"' } },
          { id: "b", type: "text", configuration: { label: "B" }, rules: { visibleWhen: 'a = "y"' } },
          { id: "send", type: "button", configuration: { label: "Send", action: "submit" } }
        ]
      }
    };
    const lintFormula = vi.fn(() => [{ message: "compares text with =.", start: 0, end: 1 }]);
    const module = { lintFormula, scanFormula: () => [] } as unknown as FormulaEditorModule;
    // The second rule's parse meets a signature table that throws (shared.formulas.parseRule reads it per parse).
    let armed = false;
    let calls = 0;
    const signatures = (): ReturnType<typeof formulaFunctionSignatures> => {
      if (armed && ++calls >= 2) {
        throw new Error("signatures boom");
      }
      return formulaFunctionSignatures();
    };
    const builder = agentBuilder({ root, tests: { scenarios: [] }, host: { formulaEditorLoaded: () => module, signatures } });
    armed = true;
    const result = okOf(await builder.execute("check_form", {}));
    expect(lintFormula).toHaveBeenCalledTimes(1);
    expect(result.skipped).toContainEqual({ area: "formula", reason: "not-applicable" });
    expect(result.skipped).toContainEqual({ area: "lint", reason: "not-applicable" });
    expect(result.ran).not.toContain("lint");
    expect(codes(result, "lint")).toEqual([]);
    error.mockRestore();
  });

  it("reports one structure-limit finding when the whole-definition check says what the gate said", async () => {
    const builder = agentBuilder({ host: { definitionProblem: () => "Too deep.", formDefinitionProblem: () => "Too deep." } });
    const result = okOf(await builder.execute("check_form", {}));
    expect(findingsOf(result).filter((finding) => finding.area === "structure")).toEqual([expect.objectContaining({ code: "structure-limit", message: "Too deep." })]);
  });

  it("cuts a finding's message at 500 characters, the lint's too", async () => {
    const long = "x".repeat(600);
    const module = { lintFormula: () => [{ message: long, start: 0, end: 1 }], scanFormula: () => [] } as unknown as FormulaEditorModule;
    const builder = agentBuilder({ host: { formDefinitionProblem: () => long, formulaEditorLoaded: () => module } });
    const result = okOf(await builder.execute("check_form", {}));
    const definition = findingsOf(result).find((finding) => finding.code === "definition");
    const lint = findingsOf(result).find((finding) => finding.area === "lint");
    for (const finding of [definition, lint]) {
      const message = finding?.message as string;
      expect(message.length).toBeLessThanOrEqual(500);
      expect(message.length).toBeGreaterThan(400);
    }
  });

  it("a lint that throws is skipped and not retried at the same revision", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lintFormula = vi.fn(() => {
      throw new Error("lint boom");
    });
    const module = { lintFormula, scanFormula: () => [] } as unknown as FormulaEditorModule;
    const pdfFindings = vi.fn(() => []);
    const builder = agentBuilder({ ui: { ...uiStub().ui, pdfFindings } as never, host: { formulaEditorLoaded: () => module } });
    const first = okOf(await builder.execute("check_form", {}));
    expect(first.skipped).toContainEqual({ area: "lint", reason: "not-applicable" });
    expect(lintFormula).toHaveBeenCalledTimes(1);
    expect(pdfFindings).toHaveBeenCalledTimes(1);
    const again = okOf(await builder.execute("check_form", {}));
    expect(again.revision).toBe(first.revision);
    expect(lintFormula).toHaveBeenCalledTimes(1);
    expect(pdfFindings).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("a host whose definition() or page probes throw still answers check_form and get_form", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = (): never => {
      throw new Error("boom");
    };
    const builder = agentBuilder({ host: { definition: boom } });
    const checked = okOf(await builder.execute("check_form", {}));
    expect(checked.skipped).toContainEqual({ area: "journey", reason: "not-applicable" });
    expect(checked.skipped).toContainEqual({ area: "structure", reason: "not-applicable" });
    okOf(await builder.execute("get_form", {}));

    // The journey area waits for its chunk; the page's badge and the arrival probe both throw.
    const controller = contactRequestController();
    let waiting = true;
    const ui = {
      ...uiStub().ui,
      journeyDiagnostics: () => {
        if (waiting) {
          return undefined;
        }
        return boom();
      },
      workspaceProblems: boom
    };
    const page = agentBuilder({ controller, ui: ui as never, host: { definition: withJourney(controller) } });
    const before = okOf(await page.execute("check_form", {}));
    expect(before.skipped).toContainEqual({ area: "journey", reason: "chunk-unavailable" });
    waiting = false;
    const after = okOf(await page.execute("check_form", {}));
    expect(after.skipped).toContainEqual({ area: "journey", reason: "chunk-unavailable" });
    error.mockRestore();
  });
});

describe("check_form: the fix sentences name documents", () => {
  it("sends a PDF layout finding to documents { action: 'open', kind: 'pdf_layout' }", async () => {
    const pdfFindings = vi.fn(() => [{ code: "pdf-layout.no-default" as const, layoutId: "main", message: "No layout prints when no condition holds." }]);
    const builder = agentBuilder({ ui: { ...uiStub().ui, pdfFindings } as never });
    const finding = findingsOf(okOf(await builder.execute("check_form", {}))).find((entry) => entry.area === "pdf");
    expect(finding).toMatchObject({ layoutId: "main", fix: "Open the layout with documents { action: 'open', kind: 'pdf_layout', id } and fix its condition in the PDF designer, or tell the person." });
  });

  it("sends a journey finding to documents { action: 'open', kind: 'journey' }", async () => {
    const controller = contactRequestController();
    const diagnostics = [{ severity: "error", code: "journey.no-end", journeyId: "intake", message: "This journey never ends." } as JourneyDiagnostic];
    const ui = { ...uiStub().ui, journeyDiagnostics: () => diagnostics };
    const builder = agentBuilder({ controller, ui, host: { definition: withJourney(controller) } });
    const finding = findingsOf(okOf(await builder.execute("check_form", {}))).find((entry) => entry.area === "journey");
    expect(finding).toMatchObject({
      journeyId: "intake",
      fix: "Open the journey with documents { action: 'open', kind: 'journey', id } to show the person, or tell them; journey pages are edited in the Journeys designer."
    });
  });

  it("still fetches nothing: the journey area is skipped while its chunk is away, and no load runs", async () => {
    const controller = contactRequestController();
    const loadTests = vi.fn(() => Promise.reject(new Error("no")));
    const loadDataModelKit = vi.fn(() => Promise.reject(new Error("no")));
    const builder = agentBuilder({ controller, ui: { ...uiStub().ui, journeyDiagnostics: () => undefined } as never, host: { definition: withJourney(controller), loadTests, loadDataModelKit } });
    okOf(await builder.execute("check_form", {}));
    expect(loadTests).not.toHaveBeenCalled();
    expect(loadDataModelKit).not.toHaveBeenCalled();
  });
});
