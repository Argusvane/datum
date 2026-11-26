/**
 * The engine's own component types and the base type any other type is read as: the data half
 * of the kind registry (`registry/kinds.ts`), here in core because the validation kernel
 * (`validation/wasm/portable-kernel.ts`) and core's shared predicates (`answer-kinds.ts`, the
 * definition structure check) read it, and core imports no upper layer.
 *
 * A component type is either an engine type (the types the engine draws and validates with no
 * definition registered) or a type of a plugin or a design-system binding. A definition names
 * the base of each such type it uses in its `kinds` map (`FormDefinition.kinds`, type -> engine
 * type): a `gcds-date` with base `date` is validated as a date in the browser and in the
 * sandbox, from the definition alone, without the binding's code. An engine type is always its
 * own base: a `kinds` entry for one is refused by the structure check and never read. A type
 * that is neither an engine type nor mapped is read as itself (an unknown type).
 *
 * A base is one of two sorts. An answer base (`date`, `radio`, ...) is followed by every read:
 * the answer's validation, the kernel, the agent's field kinds, the PDF and the renderer. A
 * container base (`fieldset`, `panel`, `tabs`) is for a design system's own container drawn
 * by its own component (`gcds-tabs`, base `tabs`): only the drawing follows it (the presentation
 * fold, the renderer's adapter lookup, the PDF), and only for a component that holds children,
 * which every data read already treats as a group. The answer reads never follow a container
 * base, so a mapped container gains no place in the data and loses none.
 *
 * Kernel-shaped (see `validation/wasm/portable-kernel.ts`): top-level `kernel*` function
 * declarations that reference only each other and standard globals, no module constants,
 * records read through `hasOwnProperty`. {@link COMPONENT_KIND_FUNCTIONS} lists them for the
 * sandbox program.
 */

/**
 * The kind word of an engine component type — how its answer reads (`text`, `number`, `date`,
 * `boolean`, `choice`, `multichoice`, `collection`, `file`, `signature`, `group`), `""` for an
 * engine type that holds no answer (a button, static HTML, an image) — or `undefined` for a
 * type that is not an engine type. The type list is the engine's: its own controls and its own
 * containers (`ENGINE_COMPONENT_TYPES`) and the reserved `signature` type.
 */
export function kernelEngineKind(type: unknown): string | undefined {
  switch (type) {
    case "text":
    case "textarea":
      return "text";
    case "number":
      return "number";
    case "date":
      return "date";
    case "checkbox":
      return "boolean";
    case "select":
    case "radio":
      return "choice";
    case "checkboxes":
      return "multichoice";
    case "file":
      return "file";
    case "signature":
      return "signature";
    case "dataGrid":
      return "collection";
    case "form":
    case "fieldset":
    case "panel":
    case "tabs":
    case "container":
    case "button-group":
    case "grid":
    case "steps":
    case "step":
      return "group";
    case "button":
    case "html":
    case "image":
      return "";
    default:
      return undefined;
  }
}

/** Whether `type` is one of the engine's own component types ({@link kernelEngineKind}). */
export function kernelIsEngineType(type: unknown): boolean {
  return kernelEngineKind(type) !== undefined;
}

/**
 * Whether `base` is an answer base: an answer-bearing engine type, one whose kind is a value
 * kind (not `""`, `group` or `collection`). The value reads of the kernel, the browser and the
 * agent follow a type mapped to one of these.
 */
export function kernelIsAnswerBase(base: unknown): boolean {
  const kind = kernelEngineKind(base);
  return kind !== undefined && kind !== "" && kind !== "group" && kind !== "collection";
}

/**
 * Whether `base` is a container base: one of the engine's plain containers, whose drawing is all
 * its type means (`fieldset`, `panel`, `tabs`). The containers whose type means more than
 * drawing stay refused: the form root, a data-scoping `container`, a data grid's row template,
 * a steps container's navigation, a layout grid's columns, a button group's own check.
 */
export function kernelIsContainerBase(base: unknown): boolean {
  return base === "fieldset" || base === "panel" || base === "tabs";
}

/**
 * Whether `base` may stand as the base of another type in a definition's `kinds` map: an answer
 * base ({@link kernelIsAnswerBase}) or a container base ({@link kernelIsContainerBase}). A base
 * that holds no answer or holds data in a tree of its own (html, button, a data grid, a
 * data-scoping container) is refused rather than half honoured.
 */
export function kernelIsKindBase(base: unknown): boolean {
  return kernelIsAnswerBase(base) || kernelIsContainerBase(base);
}

/** The own entry the definition's `kinds` map gives `type`, read tolerantly; `undefined` for none (an engine type has none). */
export function kernelKindEntry(type: string, kinds: unknown): unknown {
  if (kinds === undefined || kinds === null || typeof kinds !== "object" || Array.isArray(kinds) || kernelIsEngineType(type)) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(kinds, type)) {
    return undefined;
  }
  return (kinds as Record<string, unknown>)[type];
}

/**
 * The type a component's answer is read as: `type` itself for an engine type; the answer base
 * the definition's `kinds` map gives it (an own entry naming one, {@link kernelIsAnswerBase});
 * else `type` (an unknown type stays unknown, and a type mapped to a container base is read as
 * itself, see {@link kernelContainerBase}). `kinds` is read tolerantly, as data that came through
 * JSON: anything that is not a plain record of strings maps nothing.
 */
export function kernelKindBase(type: string, kinds: unknown): string {
  const base = kernelKindEntry(type, kinds);
  return typeof base === "string" && kernelIsAnswerBase(base) ? base : type;
}

/**
 * The engine container a component of `type` that holds children is drawn as: the container base
 * the definition's `kinds` map gives it ({@link kernelIsContainerBase}), else `type`. For the
 * drawing alone (the presentation fold, the renderer's adapter lookup, the PDF), and only for a
 * component with children: a leaf of a container-mapped type stays a leaf of its own type.
 */
export function kernelContainerBase(type: string, kinds: unknown): string {
  const base = kernelKindEntry(type, kinds);
  return typeof base === "string" && kernelIsContainerBase(base) ? base : type;
}

/** This module's functions, for the kernel's `PORTABLE_KERNEL_FUNCTIONS`. */
export const COMPONENT_KIND_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelEngineKind,
  kernelIsEngineType,
  kernelIsAnswerBase,
  kernelIsContainerBase,
  kernelIsKindBase,
  kernelKindEntry,
  kernelKindBase,
  kernelContainerBase
];
