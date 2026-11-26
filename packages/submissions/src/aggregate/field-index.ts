import { ComponentTree, buildValuePaths, type ComponentNode, type FormDefinition } from "@argusvane/datum-engine";

/**
 * The fields a form's answers have, as statistics see them: every
 * value-bearing component, its path in the answers, and what kind of value it holds — so a
 * count can be taken over a choice, a mean over a number, a completion rate over anything.
 * Classified by the component type's well-known name; a host with types of its own hands in
 * a `classify` of its own.
 */
export type FieldKind = "text" | "number" | "date" | "boolean" | "choice" | "multi" | "file" | "group" | "other";

export interface FieldDescriptor {
  componentId: string;
  /**
   * Where the value sits in the answers — the flat key a submission's `values` hold it under:
   * the component's data key (else its id), prefixed by the data-scoping containers above it
   * (`billing.street`).
   */
  valuePath: string;
  type: string;
  kind: FieldKind;
  label?: string;
  /** For a choice: the values an author listed inline, when any. */
  options?: string[];
}

const KINDS: Record<string, FieldKind> = {
  text: "text",
  email: "text",
  tel: "text",
  url: "text",
  textarea: "text",
  password: "text",
  number: "number",
  currency: "number",
  rating: "number",
  date: "date",
  time: "date",
  datetime: "date",
  checkbox: "boolean",
  toggle: "boolean",
  select: "choice",
  radio: "choice",
  checkboxes: "multi",
  multiselect: "multi",
  file: "file",
  image: "other",
  html: "other",
  button: "other",
  signature: "other",
  form: "group",
  container: "group",
  panel: "group",
  fieldset: "group",
  step: "group",
  tabs: "group",
  tab: "group",
  grid: "group",
  repeatingSection: "group",
  // A data grid holds no value of its own: its rows are entries of a collection and its
  // children are the row's fields. Named here so a grid with no field dropped in yet (no children
  // to fall back on in classifyComponent) is still a group and never a column of its own.
  dataGrid: "group"
};

/** The default classification: the engine's standard types, and `group` for anything with children. */
export function classifyComponent(node: ComponentNode): FieldKind {
  const known = KINDS[node.type];
  if (known) {
    return known;
  }
  return node.children && Object.keys(node.children).length > 0 ? "group" : "other";
}

function labelOf(node: ComponentNode): string | undefined {
  const label = (node.configuration as { label?: unknown } | undefined)?.label;
  if (typeof label === "string") {
    return label;
  }
  if (label && typeof label === "object" && typeof (label as { default?: unknown }).default === "string") {
    return (label as { default: string }).default;
  }
  return undefined;
}

function optionsOf(node: ComponentNode): string[] | undefined {
  const options = (node.configuration as { options?: unknown } | undefined)?.options;
  if (!Array.isArray(options)) {
    return undefined;
  }
  const values = options.map((option) => (typeof option === "string" ? option : option && typeof option === "object" && "value" in option ? String((option as { value: unknown }).value) : undefined)).filter((value): value is string => value !== undefined);
  return values.length > 0 ? values : undefined;
}

/** Every value-bearing field of the definition, in document order; groups are left out. */
export function walkValueFields(definition: FormDefinition, classify: (node: ComponentNode) => FieldKind = classifyComponent): FieldDescriptor[] {
  const root = definition.root;
  const paths = buildValuePaths(root);
  const tree = new ComponentTree(root);
  const fields: FieldDescriptor[] = [];
  for (const node of tree.descendantsOf(root.id)) {
    const kind = classify(node);
    if (kind === "group") {
      continue;
    }
    const label = labelOf(node);
    const options = optionsOf(node);
    fields.push({
      componentId: node.id,
      valuePath: paths.get(node.id) ?? node.id,
      type: node.type,
      kind,
      ...(label ? { label } : {}),
      ...(options ? { options } : {})
    });
  }
  return fields;
}
