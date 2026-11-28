import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import {
  buildLogicModel,
  conditionSentence,
  createLogicWords,
  expressionText,
  formRuleSentence,
  ruleFormulaText,
  rulesForFilter,
  withNodeCopy
} from "../form-engine/builder/logic/logic-model.js";
import type { LogicRule, LogicToken } from "../form-engine/builder/logic/logic-types.js";

// --- builders ------------------------------------------------------------------------------

const path = (p: string): Expression => ({ kind: "path", path: p });
const lit = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
const eq = (p: string, value: string | number | boolean | null): Expression => ({ kind: "binary", operator: "eq", left: path(p), right: lit(value) });
const cmp = (operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte", p: string, value: string | number | boolean | null): Expression => ({
  kind: "binary",
  operator,
  left: path(p),
  right: lit(value)
});
const and = (left: Expression, right: Expression): Expression => ({ kind: "logical", operator: "and", left, right });
const or = (left: Expression, right: Expression): Expression => ({ kind: "logical", operator: "or", left, right });
const not = (operand: Expression): Expression => ({ kind: "unary", operator: "not", operand });

function field(id: string, label: string, extra: Partial<ComponentNode> & { configuration?: Record<string, unknown> } = {}): ComponentNode {
  return { id, type: extra.type ?? "text", configuration: { label, ...(extra.configuration ?? {}) }, ...(extra.rules ? { rules: extra.rules } : {}), ...(extra.children ? { children: extra.children } : {}), ...(extra.collection ? { collection: extra.collection } : {}) };
}

function form(children: ComponentNode[]): ComponentNode {
  return { id: "form", type: "form", configuration: {}, children: { default: children } };
}

const text = (tokens: LogicToken[]): string => tokens.map((token) => token.text).join("");

function ruleById(rules: LogicRule[], id: string): LogicRule {
  const rule = rules.find((candidate) => candidate.id === id);
  if (!rule) {
    throw new Error(`no rule ${id}: ${rules.map((r) => r.id).join(", ")}`);
  }
  return rule;
}

const STRUCTURE_OPTIONS = [
  { value: "sole", label: "Sole proprietorship" },
  { value: "partnership", label: "Partnership" },
  { value: "corp", label: "Corporation" }
];

function businessForm(): ComponentNode {
  return form([
    field("structure", "Business structure", { type: "radio", configuration: { options: STRUCTURE_OPTIONS } }),
    field("agent", "Registered agent", {
      configuration: { hiddenValueBehavior: "exclude-from-submission" },
      rules: { visibleWhen: 'structure = "partnership" or structure = "corp"' }
    }),
    field("employees", "Number of employees", { type: "number" }),
    field("consent", "Consent", { type: "checkbox" }),
    field("email", "Email", { rules: { requiredWhen: "not(consent)", enabledWhen: "consent", readonlyWhen: "employees >= 100" } }),
    field("fee", "Fee", {
      type: "number",
      rules: { value: "employees * 10 + 5", defaultValue: "0" }
    }),
    field("province", "Province", { type: "select", rules: { filter: 'row.region != "north"' } })
  ]);
}

// --- sentences -----------------------------------------------------------------------------

describe("rule sentences", () => {
  const model = buildLogicModel(businessForm());

  it("words a show rule with the or of one field as one clause, by option label", () => {
    const rule = ruleById(model.rules, "form:agent:visibleWhen");
    expect(rule.kind).toBe("show");
    expect(rule.filter).toBe("show");
    expect(rule.editable).toBe(true);
    expect(text(rule.sentence)).toBe("Show Registered agent when Business structure is Partnership or Corporation");
    expect(rule.sentence).toEqual([
      { kind: "verb", text: "Show " },
      { kind: "field", text: "Registered agent", componentId: "agent" },
      { kind: "word", text: " when " },
      { kind: "field", text: "Business structure", componentId: "structure" },
      { kind: "word", text: " is " },
      { kind: "value", text: "Partnership" },
      { kind: "word", text: " or " },
      { kind: "value", text: "Corporation" }
    ]);
    expect(rule.hiddenValueBehavior).toBe("exclude-from-submission");
    expect(rule.reads).toEqual(["structure"]);
  });

  it("words require, enable, read-only, calculate, default and filter rules", () => {
    expect(text(ruleById(model.rules, "form:email:requiredWhen").sentence)).toBe("Require Email when Consent is not ticked");
    expect(text(ruleById(model.rules, "form:email:enabledWhen").sentence)).toBe("Enable Email when Consent is ticked");
    expect(text(ruleById(model.rules, "form:email:readonlyWhen").sentence)).toBe("Make Email read-only when Number of employees is at least 100");
    const calculate = ruleById(model.rules, "form:fee:value");
    expect(calculate.kind).toBe("calculate");
    expect(calculate.filter).toBe("calculate");
    expect(text(calculate.sentence)).toBe("Calculate Fee as Number of employees * 10 + 5");
    expect(calculate.sentence.slice(3)).toEqual([
      { kind: "field", text: "Number of employees", componentId: "employees" },
      { kind: "word", text: " * " },
      { kind: "value", text: "10" },
      { kind: "word", text: " + " },
      { kind: "value", text: "5" }
    ]);
    expect(calculate.formula).toBe("employees * 10 + 5");
    expect(calculate.storedAsText).toBe(true);
    expect(calculate.run).toBe("both");
    expect(text(ruleById(model.rules, "form:fee:defaultValue").sentence)).toBe("Start Fee at 0");
    const filter = ruleById(model.rules, "form:province:filter");
    expect(filter.filter).toBe("show");
    expect(text(filter.sentence)).toBe("Offer Province's options where row.region is not north");
    expect(filter.sentence.find((token) => token.text === "row.region")).toEqual({ kind: "field", text: "row.region" });
    expect(filter.reads).toEqual([]);
    expect(ruleById(model.rules, "form:email:requiredWhen").hiddenValueBehavior).toBeUndefined();
  });

  it("words the other comparators and a mixed condition as an expression", () => {
    const root = businessForm();
    const sentence = (expression: Expression): string => text(conditionSentence(expression, { root }));
    expect(sentence(cmp("gt", "employees", 10))).toBe("Number of employees is more than 10");
    expect(sentence(cmp("lt", "employees", 10))).toBe("Number of employees is less than 10");
    expect(sentence(cmp("lte", "employees", 10))).toBe("Number of employees is at most 10");
    expect(sentence(cmp("neq", "structure", "sole"))).toBe("Business structure is not Sole proprietorship");
    expect(sentence(and(path("consent"), cmp("eq", "employees", null)))).toBe("Consent is ticked and Number of employees is empty");
    expect(sentence(and(cmp("neq", "structure", "sole"), cmp("neq", "structure", "corp")))).toBe(
      "Business structure is not Sole proprietorship or Corporation"
    );
    expect(sentence(or(path("consent"), and(path("consent"), cmp("gt", "employees", 1))))).toBe(
      "Consent or (Consent and Number of employees > 1)"
    );
    const call = conditionSentence({ kind: "call", name: "contains", args: [path("email"), lit("@gov")] }, { root });
    expect(call).toEqual([
      { kind: "word", text: "contains(" },
      { kind: "field", text: "Email", componentId: "email" },
      { kind: "word", text: ", " },
      { kind: "value", text: "@gov" },
      { kind: "word", text: ")" }
    ]);
    expect(conditionSentence({ kind: "nope" } as unknown as Expression, { root })).toEqual([{ kind: "expression", text: "a custom condition" }]);
    expect(conditionSentence(undefined, { root })).toEqual([]);
  });

  it("prints a call to a plugin function as its formula, like a built-in", () => {
    const root = businessForm();
    // A condition calling a function the sentences do not know (a plugin's): the printed formula.
    expect(text(conditionSentence({ kind: "call", name: "isPrime", args: [path("employees")] }, { root }))).toBe("isPrime(Number of employees)");
  });

  it("names options and fields for the locale", () => {
    const root = businessForm();
    const tokens = conditionSentence(eq("structure", "corp"), {
      root,
      locale: "fr",
      catalog: { fr: { "cond.eq": "{field} est {value}" } },
      // The French is the form's translations, by the option's value.
      translations: { fr: { components: { structure: { options: { corp: { label: { text: "Société", source: sourceHash("Corporation") } } } } } } },
      labelOf: (id) => (id === "structure" ? "Structure" : undefined)
    });
    expect(text(tokens)).toBe("Structure est Société");
  });

  it("words show-step and gate rules on steps", () => {
    const model = buildLogicModel(stepsForm());
    const showStep = ruleById(model.rules, "form:step2:visibleWhen");
    expect(showStep.kind).toBe("show-step");
    expect(showStep.filter).toBe("steps");
    expect(text(showStep.sentence)).toBe("Show step Business when Applicant type is business");
    const gate = ruleById(model.rules, "form:step3:navigationGating");
    expect(gate.kind).toBe("gate");
    expect(gate.filter).toBe("steps");
    expect(text(gate.sentence)).toBe("Continue past Review only when I confirm is ticked");
  });
});

describe("a data grid's row-bound formulas", () => {
  const root = form([
    field("kids", "Children", { type: "number" }),
    field("dependants", "Dependants", {
      type: "dataGrid",
      collection: { collectionPath: "dependants" },
      children: { content: [field("depName", "Name")] },
      rules: { minRows: "kids", maxRows: { formula: "kids + 2", run: "server" } }
    })
  ]);
  const model = buildLogicModel(root);

  it("lists them as rules of the grid, worded as bounds and filed with the required rules", () => {
    const min = ruleById(model.rules, "form:dependants:minRows");
    expect(min.kind).toBe("min-rows");
    expect(min.filter).toBe("require");
    expect(min.editable).toBe(true);
    expect(text(min.sentence)).toBe("Require at least Children rows in Dependants");
    const max = ruleById(model.rules, "form:dependants:maxRows");
    expect(max.kind).toBe("max-rows");
    expect(max.run).toBe("server");
    expect(text(max.sentence)).toBe("Allow at most Children + 2 rows in Dependants");
    expect(min.reads).toEqual(["kids"]);
  });
});

describe("expressionText", () => {
  it("writes the formula the printer spells, with the parentheses a reader needs", () => {
    const sub: Expression = { kind: "arithmetic", operator: "subtract", left: path("a"), right: { kind: "arithmetic", operator: "subtract", left: path("b"), right: path("c") } };
    expect(expressionText(sub)).toBe("a - (b - c)");
    const mul: Expression = { kind: "arithmetic", operator: "multiply", left: { kind: "arithmetic", operator: "add", left: path("a"), right: lit(1) }, right: lit(2) };
    expect(expressionText(mul)).toBe("(a + 1) * 2");
    expect(expressionText({ kind: "call", name: "sum", args: [path("a"), path("b")] })).toBe("sum(a, b)");
    expect(expressionText(not(and(path("a"), path("b"))))).toBe("not(a and b)");
    expect(expressionText(cmp("gt", "employees", 10), (p) => (p === "employees" ? "Employees" : undefined))).toBe("Employees > 10");
  });
});

// --- formulas, hide rules, cases, run scopes --------------------------------------------------

describe("formula rules", () => {
  const root = form([
    field("structure", "Business structure", { type: "radio", configuration: { options: STRUCTURE_OPTIONS } }),
    field("employees", "Number of employees", { type: "number" }),
    field("agent", "Registered agent", { rules: { visibleWhen: 'structure in ("partnership", "corp")' } }),
    field("bn", "Business number", { rules: { requiredWhen: { formula: "employees > 0", run: "browser" } } }),
    field("fee", "Fee", { type: "number", rules: { value: 'if employees > 10 and structure = "corp" then 250 else if structure = "partnership" then 180 else 120' } }),
    field("score", "Eligibility score", { type: "number", rules: { value: { formula: "employees * 2", run: "server-secret" } } }),
    field("notes", "Notes", { rules: { visibleWhen: "not(employees > 10)" } }),
    field("note2", "Second notes", { rules: { visibleWhen: { formula: "not(employees > 10)", run: "server" } } }),
    field("broken", "Broken", { rules: { visibleWhen: "employees >" } }),
    field("hosted", "Hosted", { rules: { requiredWhen: { formula: 'host.region = "west"', run: "server" } } }),
    field("dated", "Dated", { rules: { visibleWhen: { formula: "age(employees) > 1", run: "server" } } }),
    field("secret_read", "Secret read", { rules: { value: { formula: "notes", run: "server-secret" } } })
  ]);
  const model = buildLogicModel(root);

  it("opens a string rule as its text and words it as a sentence", () => {
    const agent = ruleById(model.rules, "form:agent:visibleWhen");
    expect(agent.formula).toBe('structure in ("partnership", "corp")');
    expect(agent.storedAsText).toBe(true);
    expect(agent.expression).toEqual(or(eq("structure", "partnership"), eq("structure", "corp")));
    expect(text(agent.sentence)).toBe("Show Registered agent when Business structure is Partnership or Corporation");
    expect(agent.reads).toEqual(["structure"]);
  });

  it("reads the object form's formula and run scope", () => {
    const bn = ruleById(model.rules, "form:bn:requiredWhen");
    expect(bn.formula).toBe("employees > 0");
    expect(bn.run).toBe("browser");
    expect(text(bn.sentence)).toBe("Require Business number when Number of employees is more than 0");
    expect(ruleById(model.rules, "form:note2:visibleWhen").run).toBe("server");
  });

  it("words an if as its cases", () => {
    const fee = ruleById(model.rules, "form:fee:value");
    expect(text(fee.sentence)).toBe(
      "Calculate Fee as 250 when Number of employees is more than 10 and Business structure is Corporation; 180 when Business structure is Partnership; otherwise 120"
    );
    expect(fee.sentence.filter((token) => token.kind === "value").map((token) => token.text)).toEqual(["250", "10", "Corporation", "180", "Partnership", "120"]);
    expect(fee.reads).toEqual(["employees", "structure"]);
    expect(fee.formula).toBe('if employees > 10 and structure = "corp" then 250 else if structure = "partnership" then 180 else 120');
    const one: Expression = { kind: "if", cases: [{ when: path("consent"), then: lit(1) }], else: lit(0) };
    expect(text(formRuleSentence(root, { componentId: "fee", ruleKey: "value", expression: one }))).toBe("Calculate Fee as 1 when consent is ticked, otherwise 0");
  });

  it("words a secret rule as a formula the server keeps", () => {
    const score = ruleById(model.rules, "form:score:value");
    expect(score.run).toBe("server-secret");
    expect(text(score.sentence)).toBe("Calculate Eligibility score as a formula the server keeps");
    expect(score.formula).toBe("employees * 2");
  });

  it("reads not over a condition as a hide rule, and not over a field as before", () => {
    const notes = ruleById(model.rules, "form:notes:visibleWhen");
    expect(notes.kind).toBe("hide");
    expect(notes.filter).toBe("show");
    expect(text(notes.sentence)).toBe("Hide Notes when Number of employees is more than 10");
    expect(notes.formula).toBe("not(employees > 10)");
    expect(text(ruleById(buildLogicModel(businessForm()).rules, "form:email:requiredWhen").sentence)).toBe("Require Email when Consent is not ticked");
  });

  it("lists a formula that does not parse with its text and a finding", () => {
    const broken = ruleById(model.rules, "form:broken:visibleWhen");
    expect(broken.expression).toBeUndefined();
    expect(broken.formula).toBe("employees >");
    expect(text(broken.sentence)).toBe("Show Broken when employees >");
    const finding = model.diagnostics.find((diagnostic) => diagnostic.code === "formula-invalid");
    expect(finding?.severity).toBe("error");
    expect(finding?.ruleIds).toEqual(["form:broken:visibleWhen"]);
    expect(finding?.message).toContain("Broken's visibility rule has a formula that does not parse");
    expect(finding?.message).toContain("A value is missing at the end of the formula.");
  });

  it("reports where a rule runs against what it reads", () => {
    const codes = model.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.ruleIds[0]]);
    expect(codes).toContainEqual(["rule.server-cannot-run", "error", "form:hosted:requiredWhen"]);
    expect(codes).toContainEqual(["rule.server-cannot-run", "warning", "form:dated:visibleWhen"]);
    expect(codes).toContainEqual(["rule.browser-only-required", "warning", "form:bn:requiredWhen"]);
    expect(codes.filter(([code]) => code === "rule.secret-reads-browser-hidden")).toEqual([]);
    const hidden = buildLogicModel(
      form([
        field("flag", "Flag", { type: "checkbox" }),
        field("amount", "Amount", { type: "number", rules: { visibleWhen: { formula: "flag", run: "browser" } } }),
        field("total", "Total", { type: "number", rules: { value: { formula: "amount * 2", run: "server-secret" } } })
      ])
    );
    expect(hidden.diagnostics).toEqual([
      {
        code: "rule.secret-reads-browser-hidden",
        severity: "warning",
        message: "Total's secret calculation reads Amount, which a browser-only rule may hide: the server reads what the browser kept or dropped.",
        ruleIds: ["form:total:value"]
      }
    ]);
    expect(model.diagnostics.some((diagnostic) => diagnostic.code === "reads-missing-field")).toBe(false);
  });

  it("words the findings and the rule names from the host's catalog", () => {
    const worded = buildLogicModel(root, {
      locale: "xx",
      catalog: {
        xx: {
          "logic.diag.formulaInvalid": "[xx] {target} / {rule}: {message}",
          "logic.diag.browserOnlyRequired": "[xx-required] {target}",
          "logic.diag.serverCannotRun.host": "[xx-host] {target} / {rule}",
          "logic.diag.serverCannotRun.clock": "[xx-clock] {target} / {rule}",
          "logic.ruleName.visibleWhen": "visibilité",
          "logic.ruleName.requiredWhen": "obligation",
          "formula.err.expectedValue": "[xx] valeur manquante"
        }
      }
    });
    const messages = worded.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toContain("[xx] Broken / visibilité: [xx] valeur manquante");
    expect(messages).toContain("[xx-required] Business number");
    expect(messages).toContain("[xx-host] Hosted / obligation");
    expect(messages).toContain("[xx-clock] Dated / visibilité");
    // A key the host leaves out reads in English.
    const secret = buildLogicModel(
      form([
        field("flag", "Flag", { type: "checkbox" }),
        field("amount", "Amount", { type: "number", rules: { visibleWhen: { formula: "flag", run: "browser" } } }),
        field("total", "Total", { type: "number", rules: { value: { formula: "amount * 2", run: "server-secret" } } })
      ]),
      { locale: "xx", catalog: { xx: { "logic.ruleName.value": "calcul" } } }
    );
    expect(secret.diagnostics[0]?.message).toBe(
      "Total's secret calcul reads Amount, which a browser-only rule may hide: the server reads what the browser kept or dropped."
    );
  });

  it("gives the editor the text of any stored shape", () => {
    expect(ruleFormulaText("a > 1")).toBe("a > 1");
    expect(ruleFormulaText({ formula: "a > 1", run: "server" })).toBe("a > 1");
    expect(ruleFormulaText(undefined)).toBe("");
  });

  it("words a working rule the way the list would, the target unnamed until chosen", () => {
    const words = createLogicWords(root);
    expect(text(words.ruleSentence({ componentId: "agent", ruleKey: "visibleWhen", expression: not(cmp("gt", "employees", 3)) }))).toBe("Hide Registered agent when Number of employees is more than 3");
    expect(text(words.ruleSentence({ ruleKey: "requiredWhen", expression: path("structure") }))).toBe("Require … when Business structure is ticked");
    expect(text(words.ruleSentence({ componentId: "fee", ruleKey: "value", expression: undefined, text: "employees *" }))).toBe("Calculate Fee as employees *");
    expect(text(words.ruleSentence({ componentId: "fee", ruleKey: "value", expression: path("employees"), run: "server-secret" }))).toBe("Calculate Fee as a formula the server keeps");
    expect(text(words.conditionSentence(eq("structure", "corp")))).toBe("Business structure is Corporation");
    expect(words.labelOf("fee")).toBe("Fee");
  });
});

// --- steps, groups, counts ------------------------------------------------------------------

function stepsForm(): ComponentNode {
  return form([
    field("intro_ack", "Read the intro", { type: "checkbox", rules: { requiredWhen: "consent_all" } }),
    field("consent_all", "Consent to all", { type: "checkbox" }),
    {
      id: "wizard",
      type: "steps",
      configuration: {},
      children: {
        default: [
          {
            id: "step1",
            type: "step",
            configuration: { label: "About you" },
            children: {
              default: [
                field("applicant_type", "Applicant type", { type: "select" }),
                field("name", "Name", { rules: { requiredWhen: 'applicant_type = "person"' } })
              ]
            }
          },
          {
            id: "step2",
            type: "step",
            configuration: { label: "Business" },
            rules: { visibleWhen: 'applicant_type = "business"' },
            children: {
              default: [
                field("revenue", "Revenue", { type: "number", rules: { visibleWhen: "staff > 10" } }),
                field("sector", "Sector", { rules: { requiredWhen: "revenue" } })
              ]
            }
          },
          {
            id: "step3",
            type: "step",
            configuration: { label: "Review" },
            rules: { navigationGating: "confirm" },
            children: { default: [field("staff", "Staff", { type: "number" }), field("confirm", "I confirm", { type: "checkbox" })] }
          }
        ]
      }
    }
  ]);
}

describe("grouping, counts and the steps strip", () => {
  const model = buildLogicModel(stepsForm());

  it("groups a rule under the step its target is on", () => {
    expect(ruleById(model.rules, "form:name:requiredWhen").group).toEqual({ id: "step:step1", label: "About you", kind: "step" });
    expect(ruleById(model.rules, "form:revenue:visibleWhen").group.id).toBe("step:step2");
    expect(ruleById(model.rules, "form:sector:requiredWhen").group.id).toBe("step:step2");
    expect(ruleById(model.rules, "form:intro_ack:requiredWhen").group).toEqual({ id: "form", label: "This form", kind: "form" });
    expect(ruleById(model.rules, "form:step2:visibleWhen").group).toEqual({ id: "steps", label: "Steps", kind: "steps" });
    expect(ruleById(model.rules, "form:step3:navigationGating").group.id).toBe("steps");
  });

  it("lists the groups with rules in display order", () => {
    expect(model.groups.map((group) => group.id)).toEqual(["step:step1", "step:step2", "form", "steps"]);
  });

  it("counts the rules per filter", () => {
    expect(model.counts).toEqual({ all: 6, show: 1, require: 3, calculate: 0, steps: 2, journeys: 0, pdf: 0 });
    expect(rulesForFilter(model, "all")).toHaveLength(6);
    expect(rulesForFilter(model, "steps").map((rule) => rule.id)).toEqual(["form:step2:visibleWhen", "form:step3:navigationGating"]);
  });

  it("draws the steps strip from the first steps container", () => {
    expect(model.steps).toEqual([
      { id: "step1", label: "About you", ruleCount: 1, conditional: false },
      { id: "step2", label: "Business", ruleCount: 2, conditional: true },
      { id: "step3", label: "Review", ruleCount: 0, conditional: false }
    ]);
  });

  it("finds a rule reading a field on a later step", () => {
    const later = model.diagnostics.filter((diagnostic) => diagnostic.code === "reads-later-step");
    expect(later).toEqual([
      { code: "reads-later-step", message: "Revenue's rule reads Staff, which is on a later step.", ruleIds: ["form:revenue:visibleWhen"] }
    ]);
  });

  it("has no steps strip for a form without steps", () => {
    expect(buildLogicModel(businessForm()).steps).toEqual([]);
    expect(buildLogicModel(businessForm()).groups.map((group) => group.id)).toEqual(["form"]);
  });
});

// --- paths ---------------------------------------------------------------------------------

describe("path resolution", () => {
  const root = form([
    {
      id: "billing",
      type: "container",
      configuration: { label: "Billing" },
      children: { default: [field("billing_street", "Street", { configuration: { dataKey: "street" } })] }
    },
    field("address", "Address", { type: "address" }),
    {
      id: "items",
      type: "repeatingSection",
      configuration: { label: "Items" },
      collection: { collectionPath: "order.items" } as ComponentNode["collection"] & object,
      children: { default: [field("sku", "SKU")] }
    },
    field("group_box", "Box", { type: "fieldset", children: { default: [] } }),
    field("watcher", "Watcher", {
      rules: {
        visibleWhen: "billing_street and billing.street and (address.city and ghost) and (row.sku and `order.items[0].sku` and group_box)"
      }
    })
  ]);
  const model = buildLogicModel(root);
  const rule = ruleById(model.rules, "form:watcher:visibleWhen");
  const fields = rule.sentence.filter((token) => token.kind === "field").slice(1);

  it("names a field by id, by its keyed value path, by an entry's data path, and through a value it holds", () => {
    expect(fields).toEqual([
      { kind: "field", text: "Street", componentId: "billing_street" },
      { kind: "field", text: "Street", componentId: "billing_street" },
      { kind: "field", text: "address.city", componentId: "address" },
      { kind: "field", text: "ghost", unknown: true },
      { kind: "field", text: "row.sku" },
      { kind: "field", text: "order.items[0].sku", componentId: "sku" },
      { kind: "field", text: "Box", componentId: "group_box" }
    ]);
  });

  it("lists the form-scoped reads, scoped paths left out", () => {
    expect(rule.reads).toEqual(["billing_street", "billing.street", "address.city", "ghost", "order.items[0].sku", "group_box"]);
  });

  it("reports reads of paths no field stores", () => {
    expect(model.diagnostics.filter((diagnostic) => diagnostic.code === "reads-missing-field")).toEqual([
      { code: "reads-missing-field", message: "Watcher's rule reads ghost, which no field in the form stores.", ruleIds: [rule.id] },
      { code: "reads-missing-field", message: "Watcher's rule reads group_box, which no field in the form stores.", ruleIds: [rule.id] }
    ]);
  });
});

// --- journeys and PDF layouts ---------------------------------------------------------------

function definitionWith(root: ComponentNode, extra: Partial<FormDefinition>): FormDefinition {
  return { id: "f", version: "1", schemaVersion: "1", root, ...extra };
}

describe("journeys and variants", () => {
  const root = businessForm();
  const definition = definitionWith(root, {
    journey: {
      journeys: [
        {
          id: "apply",
          pages: [
            {
              id: "start",
              title: "Start",
              components: ["structure", "employees"],
              routes: [{ when: 'structure = "corp"', to: "corp_details" }, { to: "people" }, { when: "consent", to: "$end" }]
            },
            { id: "corp_details", components: ["agent"] },
            { id: "people", title: "People", components: ["employees"] },
            { id: "sector", title: "Sector", components: ["email"] }
          ]
        },
        { id: "short", pages: [{ id: "only", title: "Short form", components: ["structure"] }] }
      ]
    }
  });
  const model = buildLogicModel(root, { definition });

  it("lists no rule for a page: a page has no condition of its own, only its routes do (one with no condition included)", () => {
    const journeyRules = model.rules.filter((rule) => rule.filter === "journeys");
    expect(journeyRules.map((rule) => [rule.id, rule.kind])).toEqual([
      ["journeys:apply:start:route:0", "route"],
      ["journeys:apply:start:route:1", "route"],
      ["journeys:apply:start:route:2", "route"]
    ]);
  });

  it("words routes by their target page, and one with no condition as going there always", () => {
    const route = ruleById(model.rules, "journeys:apply:start:route:0");
    expect(route.kind).toBe("route");
    expect(route.source).toEqual({ mode: "journeys", journeyId: "apply", pageId: "start", routeIndex: 0, routeCount: 3 });
    expect(text(route.sentence)).toBe("Go to Registered agent when Business structure is Corporation");
    const end = ruleById(model.rules, "journeys:apply:start:route:2");
    expect(end.target).toEqual({ id: "$end", label: "the end", type: "journey-end" });
    expect(text(end.sentence)).toBe("Go to the end when Consent is ticked");
    const always = ruleById(model.rules, "journeys:apply:start:route:1");
    expect(text(always.sentence)).toBe("Go to People always");
    expect(always.expression).toBeUndefined();
    expect(always.formula).toBe("");
  });

  it("lists the journey rules read-only unless the builder says it can write them", () => {
    expect(model.rules.filter((rule) => rule.filter === "journeys").every((rule) => !rule.editable)).toBe(true);
    const editable = buildLogicModel(root, { definition, journeysEditable: true });
    expect(editable.rules.filter((rule) => rule.filter === "journeys").every((rule) => rule.editable)).toBe(true);
    expect(editable.rules.filter((rule) => rule.source.mode === "form").every((rule) => rule.editable)).toBe(true);
  });

  it("takes the journeys from the options when it is given them, so the Journeys mode's own are listed", () => {
    const live = buildLogicModel(root, { definition, journeys: [{ id: "x", pages: [{ id: "a", components: ["structure"], routes: [{ to: "$end" }] }] }] });
    expect(live.rules.filter((rule) => rule.filter === "journeys").map((rule) => rule.id)).toEqual(["journeys:x:a:route:0"]);
  });

  it("summarises each journey's steps for the editor's pickers: order, exits, the first of each id, the routes with no condition", () => {
    const withExit = buildLogicModel(root, {
      journeys: [
        {
          id: "j",
          name: "Apply",
          pages: [
            { id: "a", title: "One", components: ["structure"], routes: [{ when: "consent", to: "c" }, { to: "b" }] },
            { id: "b", components: ["employees"] },
            { id: "b", components: ["agent"] },
            { id: "c", kind: "exit", title: "Declined", components: [] },
            { id: "r", kind: "review" }
          ]
        }
      ]
    });
    expect(withExit.journeys).toHaveLength(1);
    const [apply] = withExit.journeys;
    expect(apply!.label).toBe("Apply");
    expect(apply!.pages.map((page) => [page.id, page.firstOfId, page.exit, page.routes, page.unconditional])).toEqual([
      ["a", true, false, 2, [1]],
      ["b", true, false, 0, []],
      ["b", false, false, 0, []],
      ["c", true, true, 0, []],
      ["r", true, false, 0, []]
    ]);
    // No rule leaves an exit step or a review step: the path stops there (a review step goes on to the end).
    expect(apply!.pages.map((page) => page.stops)).toEqual([false, false, false, true, true]);
    expect(apply!.pages[0]!.label).toBe("One");
  });

  it("words a route's condition that does not parse as its text, and reads a blank text as always", () => {
    const model2 = buildLogicModel(root, { journeys: [{ id: "x", pages: [{ id: "a", components: ["structure"], routes: [{ when: "structure = ", to: "$end" }, { when: "  ", to: "$end" }] }] }] });
    expect(text(ruleById(model2.rules, "journeys:x:a:route:0").sentence)).toBe("Go to the end when structure =");
    expect(text(ruleById(model2.rules, "journeys:x:a:route:1").sentence)).toBe("Go to the end always");
  });

  it("groups and counts journey rules", () => {
    expect(model.counts.journeys).toBe(3);
    expect(model.groups.map((group) => group.id)).toEqual(["form", "journeys"]);
  });
});

describe("PDF layouts", () => {
  const root = businessForm();
  const definition = definitionWith(root, {
    pdf: {
      layouts: [
        { id: "large", kind: "generated", name: "Large print", when: "consent", root: { id: "doc", type: "pdf-document", configuration: {}, children: { body: [] } } },
        { id: "plain", kind: "generated", root: { id: "doc2", type: "pdf-document", configuration: {}, children: { body: [] } } },
        { id: "corp", kind: "generated", when: 'structure = "corp"', root: { id: "doc3", type: "pdf-document", configuration: {}, children: { body: [] } } }
      ]
    }
  });
  const model = buildLogicModel(root, { definition });

  it("lists each layout's when, read-only, under Outputs", () => {
    const large = ruleById(model.rules, "pdf:large:when");
    expect(large.kind).toBe("pdf-layout");
    expect(large.filter).toBe("pdf");
    expect(large.editable).toBe(false);
    expect(large.source).toEqual({ mode: "pdf", layoutId: "large" });
    expect(large.group).toEqual({ id: "outputs", label: "PDF layouts", kind: "outputs" });
    expect(text(large.sentence)).toBe("Print PDF layout Large print when Consent is ticked");
    expect(large.sentence[1]).toEqual({ kind: "document", text: "Large print" });
    expect(text(ruleById(model.rules, "pdf:corp:when").sentence)).toBe("Print PDF layout corp when Business structure is Corporation");
    expect(model.counts.pdf).toBe(2);
    expect(rulesForFilter(model, "pdf")).toHaveLength(2);
    expect(model.groups.map((group) => group.id)).toEqual(["form", "outputs"]);
  });
});

// --- visibility cycles ----------------------------------------------------------------------

describe("visibility cycles", () => {
  it("finds two fields hiding each other", () => {
    const model = buildLogicModel(
      form([
        field("a", "Alpha", { rules: { visibleWhen: "b" } }),
        field("b", "Beta", { rules: { visibleWhen: "a" } }),
        field("c", "Gamma", { rules: { visibleWhen: "a" } })
      ])
    );
    expect(model.diagnostics).toEqual([
      { code: "visibility-cycle", message: "Alpha and Beta hide each other, so the form cannot settle.", ruleIds: ["form:a:visibleWhen", "form:b:visibleWhen"] }
    ]);
  });

  it("finds a cycle through a container whose visibility folds into its fields", () => {
    const model = buildLogicModel(
      form([
        field("section", "Section", { type: "fieldset", rules: { visibleWhen: "outside" }, children: { default: [field("inside", "Inside")] } }),
        field("outside", "Outside", { rules: { visibleWhen: "inside" } })
      ])
    );
    const cycles = model.diagnostics.filter((diagnostic) => diagnostic.code === "visibility-cycle");
    expect(cycles).toEqual([
      {
        code: "visibility-cycle",
        message: "Section and Outside hide each other, so the form cannot settle.",
        ruleIds: ["form:section:visibleWhen", "form:outside:visibleWhen"]
      }
    ]);
  });

  it("finds a field hidden by its own answer, and lists three in a ring once", () => {
    const self = buildLogicModel(form([field("x", "Ex", { rules: { visibleWhen: 'x = "y"' } })]));
    expect(self.diagnostics).toEqual([
      { code: "visibility-cycle", message: "Ex is hidden by an answer it hides, so the form cannot settle.", ruleIds: ["form:x:visibleWhen"] }
    ]);
    const ring = buildLogicModel(
      form([
        field("a", "A", { rules: { visibleWhen: "b" } }),
        field("b", "B", { rules: { visibleWhen: "c" } }),
        field("c", "C", { rules: { visibleWhen: "a" } })
      ])
    );
    expect(ring.diagnostics).toHaveLength(1);
    expect(ring.diagnostics[0]?.message).toBe("A, B, and C hide each other, so the form cannot settle.");
  });

  it("finds nothing in a form whose rules settle", () => {
    expect(buildLogicModel(businessForm()).diagnostics).toEqual([]);
  });

  it("draws a rename note beside the rule it names while the rule still holds that text", () => {
    const root = form([field("amount", "Amount", { type: "number" }), field("b", "B", { rules: { visibleWhen: "amount = " } })]);
    const note = { componentId: "b", rule: "visibleWhen", from: "amount", to: "total", formula: "amount = " };
    const model = buildLogicModel(root, { renameNotes: [note] });
    const finding = model.diagnostics.find((diagnostic) => diagnostic.code === "rename-unparsed");
    expect(finding?.ruleIds).toEqual(["form:b:visibleWhen"]);
    expect(finding?.message).toBe("B's visibility rule still names amount, which is now total, but it does not parse, so it was left as written.");
    // Text the author has since changed is no longer the note's.
    const edited = form([field("amount", "Amount", { type: "number" }), field("b", "B", { rules: { visibleWhen: "amount = 1" } })]);
    expect(buildLogicModel(edited, { renameNotes: [note] }).diagnostics.some((diagnostic) => diagnostic.code === "rename-unparsed")).toBe(false);
    const worded = buildLogicModel(root, { renameNotes: [note], locale: "xx", catalog: { xx: { "logic.diag.renameUnparsed": "[xx] {target} {from} {to}" } } });
    expect(worded.diagnostics.map((diagnostic) => diagnostic.message)).toContain("[xx] B amount total");
  });
});

describe("withNodeCopy (Try it copies the spine, not the tree)", () => {
  const tree = {
    id: "root",
    type: "form",
    children: {
      content: [
        { id: "a", type: "text" },
        { id: "box", type: "container", children: { content: [{ id: "b", type: "text" }, { id: "c", type: "text" }] } }
      ]
    }
  } as unknown as ComponentNode;

  it("copies the path to the node and shares every sibling", () => {
    const found = withNodeCopy(tree, "c")!;
    expect(found.node.id).toBe("c");
    expect(found.node).not.toBe(tree.children!.content![1]!.children!.content![1]);
    expect(found.root).not.toBe(tree);
    expect(found.root.children!.content![0]).toBe(tree.children!.content![0]);
    const box = found.root.children!.content![1]!;
    expect(box).not.toBe(tree.children!.content![1]);
    expect(box.children!.content![0]).toBe(tree.children!.content![1]!.children!.content![0]);
    expect(box.children!.content![1]).toBe(found.node);
    // The original is untouched.
    expect(tree.children!.content![1]!.children!.content).toHaveLength(2);
  });

  it("finds the root and answers nothing for an unknown id", () => {
    expect(withNodeCopy(tree, "root")!.node.id).toBe("root");
    expect(withNodeCopy(tree, "zzz")).toBeUndefined();
  });
});

describe("the authored kind of a visibleWhen over not(...)", () => {
  const tree = form([field("a", "A", {}), field("b", "B", { rules: { visibleWhen: "not(empty(a))" } })]);
  const id = "form:b:visibleWhen";

  it("reads from the rule's shape alone as Hide", () => {
    expect(ruleById(buildLogicModel(tree).rules, id).kind).toBe("hide");
  });

  it("reads as Show while the authored kind matches the stored text", () => {
    const authoredKinds = new Map([[id, { kind: "show" as const, stored: "not(empty(a))" }]]);
    expect(ruleById(buildLogicModel(tree, { authoredKinds }).rules, id).kind).toBe("show");
  });

  it("falls back to the shape once the stored text is no longer the one written", () => {
    const authoredKinds = new Map([[id, { kind: "show" as const, stored: "not(empty(zzz))" }]]);
    expect(ruleById(buildLogicModel(tree, { authoredKinds }).rules, id).kind).toBe("hide");
  });
});


describe("a Validate rule", () => {
  const tree = form([
    field("start", "Start", { type: "date" }),
    field("end", "End", { type: "date", configuration: { messages: { rule: "After the start, please." } }, rules: { validWhen: "end >= start" } })
  ]);

  it("lists rules.validWhen as a validate rule under Required, with its sentence and message", () => {
    const model = buildLogicModel(tree);
    const rule = ruleById(model.rules, "form:end:validWhen");
    expect(rule).toMatchObject({ kind: "validate", filter: "require", ruleKey: "validWhen", editable: true, formula: "end >= start", message: "After the start, please." });
    expect(text(rule.sentence)).toBe("Accept End only when End >= Start");
    expect(rulesForFilter(model, "require").map((entry) => entry.id)).toEqual(["form:end:validWhen"]);
  });

  it("lists it after a requiredWhen on the same field, in the inspector's order", () => {
    const both = form([field("x", "X", { rules: { validWhen: "x != \"a\"", requiredWhen: "true" } })]);
    expect(buildLogicModel(both).rules.map((rule) => rule.ruleKey)).toEqual(["requiredWhen", "validWhen"]);
  });
});
