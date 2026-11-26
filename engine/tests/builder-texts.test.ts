import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILDER_TEXTS_EN as CORE_TEXTS_EN,
  areaText,
  formatList,
  formulaErrorText,
  formulaProblemText,
  type BuilderTextCatalog
} from "../form-engine/builder/logic/builder-texts.js";
import { JOURNEY_EN } from "../form-engine/builder/journey-designer/journey-texts-en.js";
import { JOURNEY_MAP_EN } from "../form-engine/builder/journey-map/journey-map-texts-en.js";
import { JOURNEY_PREVIEW_EN } from "../form-engine/builder/journey-designer/journey-preview-texts-en.js";
import { JOURNEY_AUTHORING_EN } from "../form-engine/builder/journey-designer/journey-authoring-texts-en.js";
import { DATA_EN } from "../form-engine/builder/data/data-texts-en.js";
import { LANGUAGES_EN } from "../form-engine/builder/languages/languages-texts-en.js";
import { PRINT_EN } from "../form-engine/builder/print/print-texts-en.js";
import { LOGIC_EN } from "../form-engine/builder/logic/logic-texts-en.js";
import { OVERVIEW_EN } from "../form-engine/builder/overview/overview-texts-en.js";
import { PALETTE_EN } from "../form-engine/builder/palette/palette-texts-en.js";
import { FORMULA_EN } from "../form-engine/builder/formula/formula-texts-en.js";
import { TRY_EN } from "../form-engine/builder/web-component/try-texts-en.js";
import { PDF_EN } from "../form-engine/builder/pdf-designer/pdf-texts-en.js";
import { MOVE_EN } from "../form-engine/builder/drag-drop/move-texts-en.js";
import { TESTS_EN } from "../form-engine/builder/form-tests/tests-texts-en.js";
import { TESTS_PANEL_EN } from "../form-engine/builder/form-tests/tests-panel-texts-en.js";
import { TESTS_EDITOR_EN } from "../form-engine/builder/form-tests/tests-editor-texts-en.js";
import { AGENT_EN, agentText } from "../form-engine/agent/builder/agent-texts-en.js";
import { LANGUAGES_EXCHANGE_EN } from "../form-engine/builder/languages/languages-exchange-texts-en.js";

// The core table and every lazy area's, read through one lookup the way the whole builder is.
const BUILDER_TEXTS_EN = { ...CORE_TEXTS_EN, ...JOURNEY_EN, ...JOURNEY_MAP_EN, ...JOURNEY_PREVIEW_EN, ...JOURNEY_AUTHORING_EN, ...DATA_EN, ...LANGUAGES_EN, ...PRINT_EN, ...LANGUAGES_EXCHANGE_EN, ...LOGIC_EN, ...OVERVIEW_EN, ...PALETTE_EN, ...FORMULA_EN, ...TRY_EN, ...PDF_EN, ...MOVE_EN, ...TESTS_EN, ...TESTS_PANEL_EN, ...TESTS_EDITOR_EN, ...AGENT_EN };
const { builderText, builderPlural, builderTemplateParts, formatListText } = areaText(BUILDER_TEXTS_EN);

const catalog: BuilderTextCatalog = {
  fr: {
    "rule.show.when": "Afficher {target} lorsque {condition}",
    "cond.eq": "{field} est {value}",
    "logic.group.form": "Ce formulaire"
  },
  "fr-CA": {
    "logic.group.form": "Ce formulaire-ci"
  }
};

describe("builderText", () => {
  it("reads English by default and fills the slots", () => {
    expect(builderText("rule.show.when", { target: "Agent", condition: "Type is B" })).toBe("Show Agent when Type is B");
    expect(builderText("problems.count.one", { count: 1 })).toBe("1 problem");
  });

  it("falls back key by key from fr-CA to fr to English", () => {
    const options = { locale: "fr-CA", catalog };
    expect(builderText("logic.group.form", undefined, options)).toBe("Ce formulaire-ci");
    expect(builderText("rule.show.when", { target: "A", condition: "B" }, options)).toBe("Afficher A lorsque B");
    expect(builderText("logic.group.outputs", undefined, options)).toBe("PDF layouts");
    expect(builderText("logic.group.form", undefined, { locale: "fr", catalog })).toBe("Ce formulaire");
    expect(builderText("logic.group.form", undefined, { locale: "de", catalog })).toBe("This form");
  });

  it("leaves a slot visible when its param is missing", () => {
    expect(builderText("rule.show.when", { target: "Agent" })).toBe("Show Agent when {condition}");
    expect(builderText("cond.eq")).toBe("{field} is {value}");
  });

  it("defines every key the Logic workspace names", () => {
    for (const key of [
      "rule.show.when",
      "rule.pdfLayout.when",
      "cond.noneOf",
      "logic.filter.pdf",
      "logic.diag.readsLaterStep",
      "logic.hidden.chip.clear",
      "logic.rules.count.other"
    ] as const) {
      expect(BUILDER_TEXTS_EN[key]).toBeTruthy();
    }
  });
});

describe("builderTemplateParts", () => {
  it("splits a template into text and slots, keeping the spaces", () => {
    expect(builderTemplateParts("rule.filter.where")).toEqual([
      { text: "Offer " },
      { slot: "target" },
      { text: "'s options where " },
      { slot: "condition" }
    ]);
  });

  it("follows the locale's order of slots", () => {
    expect(builderTemplateParts("cond.eq", { locale: "fr", catalog })).toEqual([
      { slot: "field" },
      { text: " est " },
      { slot: "value" }
    ]);
  });
});

describe("formatList", () => {
  const original = (Intl as unknown as { ListFormat?: unknown }).ListFormat;
  afterEach(() => {
    (Intl as unknown as { ListFormat?: unknown }).ListFormat = original;
  });

  it("formats through Intl.ListFormat as parts", () => {
    expect(formatList(["A", "B", "C"], { type: "disjunction" })).toEqual([
      { kind: "element", text: "A" },
      { kind: "literal", text: ", " },
      { kind: "element", text: "B" },
      { kind: "literal", text: ", or " },
      { kind: "element", text: "C" }
    ]);
    expect(formatListText(["A", "B"], { type: "conjunction" })).toBe("A and B");
    expect(formatListText(["A", "B", "C"], { type: "disjunction", locale: "fr" })).toBe("A, B ou C");
    expect(formatList([], { type: "conjunction" })).toEqual([]);
  });

  it("joins plainly without Intl.ListFormat", () => {
    (Intl as unknown as { ListFormat?: unknown }).ListFormat = undefined;
    expect(formatListText(["A", "B", "C"], { type: "disjunction" })).toBe("A, B or C");
    expect(formatListText(["A", "B"], { type: "conjunction" })).toBe("A and B");
    expect(formatListText(["A"], { type: "conjunction" })).toBe("A");
    expect(
      formatListText(["A", "B"], { type: "disjunction", locale: "fr", catalog: { fr: { "cond.join.or": "ou" } } })
    ).toBe("A ou B");
  });
});

describe("builderPlural", () => {
  it("picks .one or .other by the locale's plural rules", () => {
    expect(builderPlural("problems.count", 1)).toBe("1 problem");
    expect(builderPlural("problems.count", 0)).toBe("0 problems");
    expect(builderPlural("logic.rules.count", 3)).toBe("3 rules");
    // French counts 0 as singular.
    const fr: BuilderTextCatalog = { fr: { "logic.rules.count.one": "{count} règle", "logic.rules.count.other": "{count} règles" } };
    expect(builderPlural("logic.rules.count", 0, undefined, { locale: "fr", catalog: fr })).toBe("0 règle");
    expect(builderPlural("logic.rules.count", 2, undefined, { locale: "fr", catalog: fr })).toBe("2 règles");
  });

  it("reads a category the catalog has no key for as .other", () => {
    // Polish has a "few" form; the catalog's two forms still answer.
    expect(builderPlural("problems.count", 3, undefined, { locale: "pl" })).toBe("3 problems");
  });
});

describe("formula texts", () => {
  const CODES = [
    "unexpected",
    "expectedValue",
    "expectedValueHere",
    "expectedOperator",
    "unclosedParen",
    "unmatchedParen",
    "unterminatedString",
    "curlyQuote",
    "unterminatedName",
    "emptyName",
    "badChar",
    "unknownFunction",
    "arity",
    "arityMin",
    "betweenAnd",
    "inList",
    "intervalDots",
    "ifThen",
    "chainedCompare",
    "numberTooLarge",
    "badUnit",
    "tooDeep",
    "invalidRule",
    "runScope"
  ];

  it("defines a key for every parse and problem code, and the Logic editor words", () => {
    for (const code of CODES) {
      expect(BUILDER_TEXTS_EN[`formula.err.${code}` as keyof typeof BUILDER_TEXTS_EN], code).toBeTruthy();
    }
    for (const key of [
      "formula.unknownField",
      "formula.unknownField.hint",
      "formula.hyphenHint",
      "rule.hide.when",
      "rule.hideStep.when",
      "rule.calculate.branches",
      "rule.default.branches",
      "value.case",
      "value.otherwise",
      "rule.secret.sentence",
      "editor.field",
      "editor.function",
      "editor.helpers",
      "editor.reference",
      "editor.readsAs",
      "editor.placeholder",
      "editor.tryOne",
      "editor.failed",
      "editor.retry",
      "editor.suggest.footer",
      "editor.suggest.fields",
      "editor.suggest.functions",
      "editor.suggest.keywords",
      "editor.suggest.options",
      "run.both",
      "run.browser",
      "run.server",
      "run.secret",
      "run.both.hint",
      "run.browser.hint",
      "run.server.hint",
      "run.secret.hint",
      "run.fixedBrowser",
      "run.fixedBrowser.hint",
      "run.secret.note",
      "chip.serverOnly",
      "chip.secret",
      "try.bothSides",
      "try.serverOnly",
      "try.empty",
      "try.value",
      "snippet.isAnswered",
      "snippet.cases",
      "fn.group.text",
      "settings.formulaErrors.label",
      "settings.formulaErrors.warn"
    ] as const) {
      expect(BUILDER_TEXTS_EN[key]).toBeTruthy();
    }
    // The Logic surface's own words and findings (no English in its markup).
    for (const key of [
      "logic.diag.formulaInvalid",
      "logic.diag.serverCannotRun.host",
      "logic.diag.serverCannotRun.clock",
      "logic.diag.browserOnlyRequired",
      "logic.diag.secretReadsHidden",
      "logic.diag.showThem",
      "logic.ruleName.visibleWhen",
      "logic.ruleName.navigationGating",
      "logic.list.title",
      "logic.newRule",
      "logic.kind.rule",
      "logic.kind.hide",
      "logic.kind.hide.hint",
      "logic.kind.hide.lead",
      "logic.kind.hideStep.lead",
      "logic.kind.pdfLayout.hint",
      "logic.editor.field",
      "logic.editor.step",
      "logic.editor.runs",
      "logic.editor.asFormula",
      "logic.editor.formula",
      "logic.editor.paper",
      "logic.editor.hiddenAnswer",
      "logic.editor.remove",
      "logic.editor.notApplied",
      "logic.editor.discard",
      "logic.editor.close",
      "logic.editor.apply",
      "logic.problem.chooseField",
      "logic.problem.writeCondition",
      "logic.paper.note",
      "logic.announce.applied",
      "logic.announce.removed",
      "try.title",
      "try.today",
      "try.browserOnly",
      "try.hidden",
      "try.shown",
      "try.required",
      "try.notRequired",
      "try.disabled",
      "try.enabled",
      "try.readonly",
      "try.editable"
    ] as const) {
      expect(BUILDER_TEXTS_EN[key]).toBeTruthy();
    }
    expect(builderText("logic.kind.hide.lead", { field: "Email" })).toBe("Hide Email when");
    expect(builderText("logic.diag.browserOnlyRequired", { target: "Email" })).toBe(
      "Email's required rule runs in the browser only, so the server does not enforce it."
    );
    expect(builderText("settings.formulaErrors.warn.hint")).toBe("The rule is dropped and the run log says so");
    // The Form settings choice list is Fail (the default) and Warn; there is no ignore.
    expect(builderText("settings.formulaErrors.fail.hint")).toBe("The form refuses to run until the formula is fixed");
    expect(Object.keys(BUILDER_TEXTS_EN).filter((key) => key.startsWith("settings.formulaErrors.ignore"))).toEqual([]);
    expect(builderText("value.case", { value: "250", condition: "Province is Quebec" })).toBe("250 when Province is Quebec");
    expect(builderText("formula.unknownField", { name: "provnce" })).toBe("No field is called provnce.");
  });

  it("words a parse error from its code and params", () => {
    expect(formulaErrorText("expectedValue", {})).toBe("A value is missing at the end of the formula.");
    expect(formulaErrorText("expectedValueHere", { token: ")" })).toBe("A value is missing before ).");
    expect(formulaErrorText("unclosedParen", { expected: '")"' })).toBe('Missing ")" at the end of the formula.');
    expect(formulaErrorText("unclosedParen", { expected: '"," or ")"', token: "x" })).toBe('Expected "," or ")" but found x.');
    expect(formulaErrorText("unexpected", {})).toBe("The formula could not be read.");
    expect(formulaErrorText("unexpected", { token: "]" })).toBe("Unexpected ].");
    expect(formulaErrorText("ifThen", {})).toBe("Expected then after the condition.");
    expect(formulaErrorText("ifThen", { token: "else" })).toBe("Expected then after the condition, before else.");
    expect(formulaErrorText("badChar", { char: "😀" })).toBe("😀 is not part of a formula.");
    expect(formulaErrorText("tooDeep", { max: 100, token: "(" })).toBe("The formula nests more than 100 levels deep.");
  });

  it("picks the plural for an argument count and the range form for a range", () => {
    expect(formulaErrorText("arity", { name: "abs", expected: 1, min: 1, max: 1, got: 2 })).toBe("abs takes 1 argument, not 2.");
    expect(formulaErrorText("arity", { name: "clamp", expected: 3, min: 3, max: 3, got: 1 })).toBe("clamp takes 3 arguments, not 1.");
    expect(formulaErrorText("arity", { name: "substring", expected: "2 to 3", min: 2, max: 3, got: 1 })).toBe("substring takes 2 to 3 arguments, not 1.");
    expect(formulaErrorText("arityMin", { name: "min", min: 1, got: 0 })).toBe("min needs at least 1 arguments; 0 given.");
  });

  it("falls back to the code for one the catalog lacks, and takes the host's locale", () => {
    expect(formulaErrorText("somethingNew", { token: "x" })).toBe("somethingNew");
    const options = { locale: "fr", catalog: { fr: { "formula.err.unknownFunction": "Aucune fonction ne s'appelle {name}." } } };
    expect(formulaErrorText("unknownFunction", { name: "foo" }, options)).toBe("Aucune fonction ne s'appelle foo.");
  });

  it("words compile problems too", () => {
    expect(formulaProblemText("runScope", { key: "defaultValue", run: "server" })).toBe("The defaultValue rule runs in the browser by nature; it cannot run server.");
    expect(formulaProblemText("invalidRule", { key: "visibleWhen", got: "number" })).toBe("The visibleWhen rule is a number, not a formula.");
    expect(formulaProblemText("ifThen", {})).toBe("Expected then after the condition.");
  });
});

describe("the Variables panel keys per workspace", () => {
  it("defines the Data and Journeys groups and fills their slots", () => {
    expect(builderText("variables.data.group")).toBe("Saved values");
    expect(builderText("variables.data.note.key", { type: "text", id: "postcode", key: "zip" })).toBe("text, id postcode, data key zip");
    expect(builderText("variables.journey.pages")).toBe("Steps");
    expect(builderText("variables.journey.own.alias", { target: "email" })).toBe("Stands for the form field email");
    expect(builderText("variables.journey.pages", undefined, { locale: "fr", catalog: { fr: { "variables.journey.pages": "Pages du parcours" } } })).toBe("Pages du parcours");
  });
});

describe("the shell chrome keys", () => {
  const chromePrefixes = ["shell.", "components.", "outline.", "view.", "settings.", "variables.", "chrome.", "data.", "languages."];
  const keys = Object.keys(BUILDER_TEXTS_EN).filter((key) => chromePrefixes.some((prefix) => key.startsWith(prefix)));

  it("defines a non-empty English text for every key (English is the only locale the catalog ships)", () => {
    expect(keys.length).toBeGreaterThan(300);
    for (const key of keys) {
      expect(BUILDER_TEXTS_EN[key as keyof typeof BUILDER_TEXTS_EN].trim().length, key).toBeGreaterThan(0);
    }
  });

  it("gives every counted phrase a .one and a .other", () => {
    for (const key of keys.filter((entry) => entry.endsWith(".one"))) {
      expect(keys, key).toContain(`${key.slice(0, -4)}.other`);
    }
    for (const key of keys.filter((entry) => entry.endsWith(".other"))) {
      expect(keys, key).toContain(`${key.slice(0, -6)}.one`);
    }
  });

  it("names every strip panel, with a short name on the three that have one", () => {
    for (const id of ["form", "chrome", "components", "outline", "variables", "view", "settings"]) {
      expect(BUILDER_TEXTS_EN[`shell.panel.${id}.label` as keyof typeof BUILDER_TEXTS_EN], id).toBeTruthy();
      expect(BUILDER_TEXTS_EN[`shell.panel.${id}.title` as keyof typeof BUILDER_TEXTS_EN], id).toBeTruthy();
    }
    expect(keys.filter((key) => key.endsWith(".short")).sort()).toEqual(["shell.panel.chrome.short", "shell.panel.components.short", "shell.panel.form.short"]);
  });

  it("reads a host's French over the English, key by key", () => {
    const fr: BuilderTextCatalog = { fr: { "shell.panel.outline.label": "Plan", "settings.submit.hint": "Ces valeurs servent à Essayer." } };
    expect(builderText("shell.panel.outline.label", undefined, { locale: "fr", catalog: fr })).toBe("Plan");
    expect(builderText("shell.panel.outline.title", undefined, { locale: "fr", catalog: fr })).toBe("Outline");
    expect(builderText("settings.submit.hint", undefined, { locale: "fr-CA", catalog: fr })).toBe("Ces valeurs servent à Essayer.");
  });

  it("counts through the plural rules of the locale", () => {
    expect(builderPlural("data.fields", 1)).toBe("1 field");
    expect(builderPlural("data.fields", 3)).toBe("3 fields");
    expect(builderPlural("languages.coverage", 2, { translated: 1, total: 2 })).toBe("1 of 2 texts");
  });
});

describe("the area tables (each lazy surface's English in its own chunk)", () => {
  const tables: Record<string, Record<string, string>> = {
    "journey-texts-en": JOURNEY_EN,
    "journey-map-texts-en": JOURNEY_MAP_EN,
    "journey-preview-texts-en": JOURNEY_PREVIEW_EN,
    "journey-authoring-texts-en": JOURNEY_AUTHORING_EN,
    "data-texts-en": DATA_EN,
    "languages-texts-en": LANGUAGES_EN,
    "print-texts-en": PRINT_EN,
    "languages-exchange-texts-en": LANGUAGES_EXCHANGE_EN,
    "logic-texts-en": LOGIC_EN,
    "overview-texts-en": OVERVIEW_EN,
    "palette-texts-en": PALETTE_EN,
    "formula-texts-en": FORMULA_EN,
    "try-texts-en": TRY_EN,
    "pdf-texts-en": PDF_EN,
    "move-texts-en": MOVE_EN,
    "tests-texts-en": TESTS_EN,
    "tests-panel-texts-en": TESTS_PANEL_EN,
    "tests-editor-texts-en": TESTS_EDITOR_EN,
    // The builder agent tools: its table lives under agent/builder/, outside this walk.
    "agent-texts-en": AGENT_EN
  };
  const owner = new Map<string, string>();
  for (const key of Object.keys(CORE_TEXTS_EN)) {
    owner.set(key, "core");
  }

  it("holds every key in exactly one table", () => {
    const seen = new Map<string, string>();
    for (const key of Object.keys(CORE_TEXTS_EN)) {
      seen.set(key, "core");
    }
    for (const [name, table] of Object.entries(tables)) {
      for (const key of Object.keys(table)) {
        expect(seen.get(key), `${key} is in ${name} and ${seen.get(key)}`).toBeUndefined();
        seen.set(key, name);
        owner.set(key, name);
      }
    }
    expect(seen.size).toBeGreaterThan(1400);
  });

  const root = fileURLToPath(new URL("../form-engine/builder/", import.meta.url));
  const sources: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith("builder-texts.ts") && !entry.name.endsWith("-texts-en.ts")) {
        sources.push({ file: relative(root, path), text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root);

  it("lets only the area's own code read an area's key, through that area's module", () => {
    const quoted = /["'`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)["'`]/g;
    for (const { file, text } of sources) {
      const imports = new Set([...text.matchAll(/\/([a-z-]+-texts-en)\.js"/g)].map((match) => match[1] as string));
      for (const match of text.matchAll(quoted)) {
        const key = match[1] as string;
        const where = owner.get(key) ?? owner.get(`${key}.other`);
        if (where !== undefined && where !== "core") {
          expect(imports.has(where), `${file} names ${key}, which lives in ${where}: import the lookup from that module`).toBe(true);
        }
      }
    }
  });

  it("defines every key the builder's source names as a text", () => {
    const named = /(?:builderText|builderTemplateParts|\.text|\.html)\(\s*"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"|(?:builderPlural|\.plural)\(\s*"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g;
    for (const { file, text } of sources) {
      for (const match of text.matchAll(named)) {
        const key = (match[1] ?? match[2]) as string;
        const present = match[1] !== undefined ? key in BUILDER_TEXTS_EN : `${key}.other` in BUILDER_TEXTS_EN;
        expect(present, `${file} names ${key}, which no table defines`).toBe(true);
      }
    }
  });
});

describe("keys for the shared words the panels take over", () => {
  it("defines the skip, discard, move, keep-editing and stale-marker words in the core table", () => {
    expect(builderText("components.skip")).toBe("Skip to canvas");
    expect(builderText("confirm.unsaved.keep")).toBe("Keep editing");
    expect(builderText("canvas.action.move")).toBe("Move to…");
    expect(builderText("canvas.action.moveTip")).toBe("Move to… (M)");
    expect(builderText("inspector.pointer.done", { languages: "French · German" })).toBe("Translated in French · German");
    expect(builderText("inspector.pointer.missing", { language: "French", count: 2 })).toBe("French 2 missing");
    expect(builderText("inspector.pointer.open")).toBe("Open in Languages");
    expect(builderText("inspector.pointer.openPart", { part: "welcome" })).toBe("Open in Languages: welcome");
    expect(builderText("optionsEditor.discard.keep")).toBe("Keep editing");
    expect(builderText("optionsEditor.err.rowUnfinished", { n: 3 })).toBe("Row 3 is not finished: it has a key but no label. Add a label, or clear the key.");
    expect(builderPlural("optionsEditor.discard.title", 1)).toBe("Discard 1 change?");
    expect(builderPlural("optionsEditor.discard.title", 4)).toBe("Discard 4 changes?");
    expect(builderText("canvas.keys")).toContain("M asks where to");
    expect(builderText("optionsEditor.options.hint")).toContain("one option per line");
  });

  it("lets a host's catalog word a Move to... key (MOVE_EN is in BuilderTextKey)", () => {
    expect(builderText("move.confirm", undefined, { locale: "fr", catalog: { fr: { "move.confirm": "Déplacer" } } })).toBe("Déplacer");
  });
});

describe("the data grid's builder texts", () => {
  it("words the two row-bound problems in the core table, with the cap as a slot", () => {
    expect(builderText("inspector.problem.rowsCap", { max: 500 })).toBe("At most 500.");
    expect(builderText("inspector.problem.rowsMaxBelowMin")).toContain("Maximum rows is below the minimum");
    expect("inspector.problem.rowsCap" in CORE_TEXTS_EN).toBe(true);
    expect("inspector.problem.rowsMaxBelowMin" in CORE_TEXTS_EN).toBe(true);
    expect(builderText("inspector.problem.rowsCap", { max: 500 }, { locale: "fr", catalog: { fr: { "inspector.problem.rowsCap": "Au plus {max}." } } })).toBe("Au plus 500.");
  });

  it("no longer carries the refusal that a data grid's columns are configuration, not fields", () => {
    expect("dataModel.gen.dataGrid" in BUILDER_TEXTS_EN).toBe(false);
  });
});

describe("the builder agent tools' texts", () => {
  it("keeps every key under agent., each with words", () => {
    const keys = Object.keys(AGENT_EN);
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(key.startsWith("agent."), key).toBe(true);
      expect(AGENT_EN[key as keyof typeof AGENT_EN].trim().length, key).toBeGreaterThan(0);
    }
  });

  it("resolves an agent key through the merged lookup and through the area's own lookup", () => {
    expect(builderText("agent.session.started", { purpose: "Add a contact section" })).toBe(
      "An assistant started working on this form: Add a contact section. Press Stop to take over."
    );
    expect(builderPlural("agent.did.add", 1)).toBe("Assistant added 1 component");
    expect(builderPlural("agent.did.add", 5)).toBe("Assistant added 5 components");
    expect(agentText("agent.undoAll", { count: 3 })).toBe("Undo all (3)");
  });

  it("reads a host's catalog over the agent's English", () => {
    expect(agentText("agent.stop", undefined, { locale: "fr", catalog: { fr: { "agent.stop": "Arrêter" } } })).toBe("Arrêter");
  });
});
