/**
 * The Data workspace's schema table: one row for each
 * answer the form stores — where it is saved, what kind of value, whether it is required — read
 * from the form's data model (`dataModelFromForm`), with the step and the journey
 * pages each answer is on, for the table's filters. Pure: the surface draws it, node tests it.
 */
import type { Expression } from "../../core/expressions/expression.js";
import { journeyPageFormIds } from "../../core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import { dataModelFromForm, walkDataModel, type DataModelNode } from "../data-model/index.js";
import { expressionText } from "../logic/logic-model.js";
import type { BuilderWords } from "../logic/builder-texts.js";
import { areaWords } from "./data-texts-en.js";

/** Whether an answer is required, in the table's words. */
export type SchemaRequired = "yes" | "no" | "when" | "calculated";

export interface SchemaRow {
  /** Where the answer is saved (`business.legal_name`, `owners[].name`). */
  path: string;
  componentId: string;
  componentType: string;
  label: string;
  /** The kind of value in words: "Text", "One of 3", "Number", "Date", "File", "Text, repeating". */
  typeText: string;
  required: SchemaRequired;
  /** "Yes", "No", "When employees > 0", "—" for a calculated answer. */
  requiredText: string;
  /** Marks beside the field: shown by a rule, calculated, a data-key warning. */
  badges: Array<{ kind: "rule" | "calculated" | "warning"; text: string }>;
  /** The step the answer is on, when the form has steps. */
  stepId?: string | undefined;
  /** The journey pages that draw it, as `<journeyId>/<pageId>`. */
  pages: string[];
}

/** A filter chip or option: a step of the form, or a page of a journey. */
export interface SchemaFilter {
  /** `step:<id>` or `page:<journeyId>/<pageId>`. */
  id: string;
  label: string;
  /** For a page: the journey's name, to group the options by. */
  group?: string | undefined;
}

export interface SchemaTable {
  rows: SchemaRow[];
  steps: SchemaFilter[];
  pages: SchemaFilter[];
}

export interface SchemaTableOptions {
  locale?: string | undefined;
  /** The builder's words for the table's labels, in its locale and catalog; English when absent. */
  words?: BuilderWords | undefined;
  /** The whole definition, for the journeys' pages. */
  definition?: FormDefinition | undefined;
}

/** A definition text as the table names things by: the string in the form's default language. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function rulesOf(node: ComponentNode | undefined): Record<string, unknown> {
  return (node?.rules as Record<string, unknown> | undefined) ?? {};
}

/** The value's kind in words, as the table's Type column says it. */
export function schemaTypeText(node: DataModelNode, repeating: boolean, words: BuilderWords = areaWords()): string {
  let base: string;
  // A checkboxes group or a multiselect takes several of its options; a choice takes one.
  const several = node.format === "flags" || node.kind === "object" || node.kind === "array";
  if (node.options && node.options.length > 0) {
    base = words.text(several ? "schemaRows.type.anyOf" : "schemaRows.type.oneOf", { count: node.options.length });
  } else if (node.optionsSource) {
    base = words.text(several ? "schemaRows.type.anyOfList" : "schemaRows.type.oneOfList");
  } else {
    switch (node.kind) {
      case "string":
        base = words.text(
          node.format === "date"
            ? "schemaRows.type.date"
            : node.format === "date-time"
              ? "schemaRows.type.dateTime"
              : node.format === "time"
                ? "schemaRows.type.time"
                : node.format === "email"
                  ? "schemaRows.type.email"
                  : node.format === "multiline"
                    ? "schemaRows.type.longText"
                    : "schemaRows.type.text"
        );
        break;
      case "number":
        base = words.text("schemaRows.type.number");
        break;
      case "integer":
        base = words.text("schemaRows.type.wholeNumber");
        break;
      case "boolean":
        base = words.text("schemaRows.type.yesNo");
        break;
      case "file":
        base = words.text("schemaRows.type.file");
        break;
      case "array":
        base = words.text("schemaRows.type.list");
        break;
      case "object":
        base = words.text("schemaRows.type.group");
        break;
      default:
        base = words.text("schemaRows.type.value");
    }
  }
  const limits: string[] = [];
  if (node.minLength !== undefined && node.maxLength !== undefined) {
    limits.push(words.text("data.checks.length.between", { min: node.minLength, max: node.maxLength }));
  } else if (node.maxLength !== undefined) {
    limits.push(words.text("data.checks.length.max", { max: node.maxLength }));
  } else if (node.minLength !== undefined) {
    limits.push(words.text("data.checks.length.min", { min: node.minLength }));
  }
  if (repeating) {
    limits.push(words.text("schemaRows.type.repeating"));
  }
  const sep = words.text("dataModel.sep");
  return limits.length > 0 ? `${base}${sep}${limits.join(sep)}` : base;
}

/**
 * The table: every place in the data a component holds, in the data model's order. A
 * checkboxes group (an object of flags) is one row, and so is a list of plain values (a
 * multiselect, a file field taking several files); a repeating section's fields are rows
 * inside its entries (`owners[].name`), marked repeating.
 */
export function buildSchemaTable(root: ComponentNode, options: SchemaTableOptions = {}): SchemaTable {
  const locale = options.locale ?? "en";
  const words = areaWords(options.words);
  const model = dataModelFromForm(root, { locale });

  // The tree, by id, with each node's parent: rules up the tree, the step a field is on.
  const nodeById = new Map<string, ComponentNode>();
  const parentOf = new Map<string, string>();
  const index = (node: ComponentNode): void => {
    nodeById.set(node.id, node);
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        parentOf.set(child.id, node.id);
        index(child);
      }
    }
  };
  index(root);
  const labelOf = (id: string): string => {
    const node = nodeById.get(id);
    const configuration = (node?.configuration ?? {}) as Record<string, unknown>;
    return text(configuration.label) ?? text(configuration.title) ?? id;
  };
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) {
      out.push(at);
    }
    return out;
  };

  // The form's steps: the first steps container's.
  const steps: SchemaFilter[] = [];
  const stepIds = new Set<string>();
  const findSteps = (node: ComponentNode): boolean => {
    if (node.type === "steps") {
      for (const group of Object.values(node.children ?? {})) {
        for (const step of group) {
          steps.push({ id: `step:${step.id}`, label: labelOf(step.id) });
          stepIds.add(step.id);
        }
      }
      return true;
    }
    return Object.values(node.children ?? {}).some((group) => group.some(findSteps));
  };
  findSteps(root);

  // The journeys' pages: which components each draws (each brings its subtree).
  const pages: SchemaFilter[] = [];
  const pagesOf = new Map<string, string[]>();
  for (const journey of options.definition?.journey?.journeys ?? []) {
    const journeyName = text(journey.name) ?? journey.id;
    journey.pages.forEach((page, pageIndex) => {
      const key = `${journey.id}/${page.id}`;
      const ids = journeyPageFormIds(page);
      const title = text(page.title) ?? (ids[0] !== undefined ? labelOf(ids[0]) : undefined) ?? words.text("schemaRows.page", { number: pageIndex + 1 });
      pages.push({ id: `page:${key}`, label: title, group: journeyName });
      for (const id of ids) {
        pagesOf.set(id, [...(pagesOf.get(id) ?? []), key]);
      }
    });
  }

  const labelOfPath = (path: string): string | undefined => (nodeById.has(path) ? labelOf(path) : undefined);
  const rows: SchemaRow[] = [];
  walkDataModel(model, (node) => {
    const componentId = node.componentId;
    // A list of entries (a repeating section's, a data grid's) is no answer of its own: its
    // entry's fields are the rows. A list of plain values (a multiselect, several files) is one.
    const isEntries = node.kind === "array" && node.items?.kind === "object";
    const isLeaf = (node.kind !== "object" || node.format === "flags") && !isEntries;
    if (!componentId || !isLeaf) {
      return node.kind === "object" && node.format === "flags" ? "skip" : undefined;
    }
    const component = nodeById.get(componentId);
    const chain = [componentId, ...ancestors(componentId)];
    const own = rulesOf(component);
    const calculated = own.value !== undefined;
    const ruleShown = chain.some((id) => rulesOf(nodeById.get(id)).visibleWhen !== undefined);
    const requiredWhen = own.requiredWhen as Expression | undefined;
    const required: SchemaRequired = calculated ? "calculated" : node.required ? "yes" : requiredWhen !== undefined ? "when" : "no";
    const requiredText =
      required === "calculated"
        ? "—"
        : required === "yes"
          ? words.text("schemaRows.required.yes")
          : required === "when" && requiredWhen
            ? words.text("schemaRows.required.when", { expression: expressionText(requiredWhen, labelOfPath) })
            : words.text("schemaRows.required.no");
    const badges: SchemaRow["badges"] = [];
    if (ruleShown) {
      badges.push({ kind: "rule", text: words.text("schemaRows.badge.rule") });
    }
    if (calculated) {
      badges.push({ kind: "calculated", text: words.text("schemaRows.badge.calculated") });
    }
    for (const note of node.notes ?? []) {
      if (note.level === "warning") {
        badges.push({ kind: "warning", text: note.message });
      }
    }
    const step = chain.find((id) => stepIds.has(id));
    const onPages = [...new Set(chain.flatMap((id) => pagesOf.get(id) ?? []))];
    rows.push({
      path: node.path,
      componentId,
      componentType: component?.type ?? node.componentType ?? "",
      label: node.label ?? labelOf(componentId),
      typeText: schemaTypeText(node, node.path.includes("[]"), words),
      required,
      requiredText,
      badges,
      ...(step !== undefined ? { stepId: step } : {}),
      pages: onPages
    });
    return node.kind === "object" || node.kind === "array" ? "skip" : undefined;
  });
  return { rows, steps, pages };
}

/** The rows a filter keeps: `all`, `step:<id>` or `page:<journeyId>/<pageId>`. */
export function filterSchemaRows(table: SchemaTable, filter: string): SchemaRow[] {
  if (filter.startsWith("step:")) {
    const step = filter.slice("step:".length);
    return table.rows.filter((row) => row.stepId === step);
  }
  if (filter.startsWith("page:")) {
    const page = filter.slice("page:".length);
    return table.rows.filter((row) => row.pages.includes(page));
  }
  return table.rows;
}
