import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";

/**
 * Ladder forms and the rule corpus for the FEEL performance harness (engine/scripts/bench-feel.mjs)
 * and its counts test (tests/feel-perf-counts.test.ts). Plain data builders, no timing.
 */

const KINDS = ["text", "number", "select", "checkboxes", "date"] as const;

function field(id: string, kind: (typeof KINDS)[number], rules?: Record<string, unknown>): ComponentNode {
  const configuration: Record<string, unknown> = { label: id };
  if (kind === "select" || kind === "checkboxes") {
    configuration.options = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
      { value: "c", label: "C" }
    ];
  }
  return { id, type: kind, configuration, ...(rules !== undefined ? { rules } : {}) } as ComponentNode;
}

/** A formula for field `i` that reads only earlier fields (so no cycles), cycling rule shapes. */
function ruleFor(i: number): Record<string, unknown> {
  const a = `f${Math.max(0, i - 1)}`;
  const b = `f${Math.max(0, i - 2)}`;
  switch (i % 5) {
    case 0:
      return { visibleWhen: `not(empty(${a}))` };
    case 1:
      return { requiredWhen: `${a} = "a" or ${b} = "b"` };
    case 2:
      return { enabledWhen: `not(empty(${a})) and not(empty(${b}))` };
    case 3:
      return { readonlyWhen: `empty(${a})` };
    default:
      return { visibleWhen: `if empty(${a}) then false else true` };
  }
}

export interface LadderOptions {
  /** Number of fields f0..f(n-1), kinds cycling text, number, select, checkboxes, date. */
  fields: number;
  /** Share of fields carrying a formula-string rule (default 0.3). */
  ruleShare?: number;
  /** Rows to leave out; the repeating section `rows` is added when `repeating` is true. */
  repeating?: boolean;
  /** Calculation (value) rules over a repeating section: `rows.total` = sum of the row field. */
  extra?: ComponentNode[];
}

export function ladderRoot(options: LadderOptions): ComponentNode {
  const share = options.ruleShare ?? 0.3;
  const every = share <= 0 ? Number.POSITIVE_INFINITY : Math.max(1, Math.round(1 / share));
  const content: ComponentNode[] = [];
  for (let i = 0; i < options.fields; i += 1) {
    const kind = KINDS[i % KINDS.length] as (typeof KINDS)[number];
    content.push(field(`f${String(i)}`, kind, i > 1 && i % every === 0 ? ruleFor(i) : undefined));
  }
  if (options.repeating === true) {
    content.push({
      id: "rows",
      type: "repeatingSection",
      configuration: { label: "Rows" },
      collection: { itemFields: ["rowText", "rowAmount"] },
      children: {
        content: [
          { id: "rowText", type: "text", configuration: { label: "Text" } },
          {
            id: "rowAmount",
            type: "number",
            configuration: { label: "Amount" },
            rules: { visibleWhen: "not(empty(row.rowText))" }
          }
        ]
      }
    } as ComponentNode);
  }
  content.push(...(options.extra ?? []));
  return { id: "root", type: "form", configuration: {}, children: { content } } as ComponentNode;
}

export function ladderForm(options: LadderOptions): FormDefinition {
  return {
    id: "ladder",
    version: "1",
    schemaVersion: "1",
    root: ladderRoot(options),
    localization: { defaultLocale: "en-CA" }
  } as FormDefinition;
}

/**
 * A form where `hub` is read by exactly `readers` rules, and `filler` other fields carry rules
 * that do not read it. Lets a keystroke on `hub` be compared with one on `quiet`.
 */
export function readersForm(readers: number, filler = 100): FormDefinition {
  const content: ComponentNode[] = [field("hub", "text"), field("quiet", "text")];
  for (let i = 0; i < readers; i += 1) {
    content.push(field(`r${String(i)}`, "text", { visibleWhen: "not(empty(hub))" }));
  }
  for (let i = 0; i < filler; i += 1) {
    const id = `g${String(i)}`;
    content.push(field(id, "text", i % 3 === 0 ? { requiredWhen: `${i === 0 ? "quiet" : `g${String(i - 1)}`} = "x"` } : undefined));
  }
  return {
    id: "readers",
    version: "1",
    schemaVersion: "1",
    root: { id: "root", type: "form", configuration: {}, children: { content } } as ComponentNode,
    localization: { defaultLocale: "en-CA" }
  } as FormDefinition;
}

/** Pattern templates for the corpus, in the style of the demo forms (site/src/demo-forms.ts, intake). */
const TEMPLATES: readonly ((a: string, b: string, c: string) => string)[] = [
  (a) => `${a}`,
  (a) => `not(empty(${a}))`,
  (a, b) => `not(empty(${a})) and not(empty(${b})) and ${b} < ${a}`,
  (a, b) => `not(empty(${a})) and ${a} > ${b}`,
  (a) => `${a} = "a"`,
  (a) => `${a} != "a"`,
  (a, b) => `${a} = "a" or ${b} = "b"`,
  (a) => `len(${a}) > 3`,
  (a, b, c) => `sum(${a}, ${b}, ${c})`,
  (a, b) => `sum(${a}, 1) * 45 + ${b}`,
  (a, b) => `min(round(sum(${a}, ${b}) * 0.25), 5000)`,
  (a) => `if ${a} > 50000 then ${a} * 0.2 else ${a} * 0.25`,
  (a, b) => `concat(${a}, " ", ${b})`,
  (a) => `upper(trim(${a}))`,
  (a) => `contains(${a}, "x")`,
  (a) => `startsWith(${a}, "A") and endsWith(${a}, "z")`,
  (a) => `matches(${a}, "^[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9]$")`,
  (a) => `coalesce(${a}, "none")`,
  (a, b) => `${a} + ${b} * 2 - 1`,
  (a) => `round(${a} / 3)`,
  (a, b) => `any(${a}, ${b})`,
  (a) => `empty(${a}) or ${a} = ""`,
  (a, b, c) => `not(empty(${a})) and (${b} = "a" or ${c} = "b") and not(empty(${c}))`,
  (a) => `isNumber(${a}) and ${a} >= 0`,
  (a, b) => `${a} = ${b}`
];

/** 100 realistic rule texts reading fields f0..f(fieldCount-1). */
export function ruleCorpus(count = 100, fieldCount = 50): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = TEMPLATES[i % TEMPLATES.length] as (a: string, b: string, c: string) => string;
    const n = (k: number): string => `f${String((i * 7 + k * 13) % fieldCount)}`;
    out.push(t(n(0), n(1), n(2)));
  }
  return out;
}

export function andChain(terms: number): string {
  return Array.from({ length: terms }, (_, i) => `not(empty(f${String(i % 50)}))`).join(" and ");
}

export function ifLadder(depth: number): string {
  let text = '"end"';
  for (let i = depth - 1; i >= 0; i -= 1) {
    text = `if f${String(i % 50)} = "a" then "v${String(i)}" else ${text}`;
  }
  return text;
}

export function wideFormula(fields: number): string {
  return `sum(${Array.from({ length: fields }, (_, i) => `f${String(i)}`).join(", ")})`;
}

/** Values for ids f0..f(n-1), shaped to each field kind. */
export function ladderValues(n: number): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (let i = 0; i < n; i += 1) {
    const kind = KINDS[i % KINDS.length];
    values[`f${String(i)}`] =
      kind === "number" ? i : kind === "select" ? "a" : kind === "checkboxes" ? ["a", "b"] : kind === "date" ? "2026-03-01" : `text ${String(i)}`;
  }
  return values;
}
