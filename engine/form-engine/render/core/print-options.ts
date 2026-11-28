/**
 * How a component prints: where it is drawn (`configuration.print.on`), what a live
 * print does while a rule hides it (`print.show`), the breaks around it on paper
 * (`print.breakBefore`, `print.keepTogether`), and the note beside a field that prints while a
 * rule hides it. A read-only form prints what it shows: it ignores `print.show` and reads only
 * the breaks and `print.on: "screen"`, which leaves a component off paper in every case.
 */
import { resolveText, type TextAddress, type TextSources } from "../../core/localization/translations.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { drawnBaseOf, kindOf } from "../../registry/kinds.js";

/**
 * `auto` (absent): as on screen — a field a rule hides is left off. `always`: printed whatever
 * the rules say, with its note while a rule hides it, its contents with it. `answered`: printed
 * only when it holds an answer.
 */
export type ComponentPrintShow = "auto" | "always" | "answered";

/**
 * Where a component is drawn. `both` (absent): on screen and on paper. `screen`: on screen
 * only, never printed, its contents with it. `paper`: printed only (see {@link paperOnlyApplies}).
 */
export type ComponentPrintOn = "both" | "screen" | "paper";

/** A component's print settings, every choice made. */
export interface ComponentPrintSettings {
  on: ComponentPrintOn;
  show: ComponentPrintShow;
  /** It starts a new sheet. */
  breakBefore: boolean;
  /** A container that is never split across sheets where it fits on one. */
  keepTogether: boolean;
}

const SHOWS: readonly ComponentPrintShow[] = ["auto", "always", "answered"];
const ONS: readonly ComponentPrintOn[] = ["both", "screen", "paper"];

function printBlock(configuration: unknown): Record<string, unknown> {
  const own = (configuration as Record<string, unknown> | undefined)?.print;
  return own && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Reads a component's `configuration.print`, defaults filled in. Never throws. */
export function readComponentPrintSettings(configuration: unknown): ComponentPrintSettings {
  const block = printBlock(configuration);
  return {
    on: pick(block.on, ONS, "both"),
    show: pick(block.show, SHOWS, "auto"),
    breakBefore: block.breakBefore === true,
    keepTogether: block.keepTogether === true
  };
}

export function readComponentPrintShow(configuration: unknown): ComponentPrintShow {
  return pick(printBlock(configuration).show, SHOWS, "auto");
}

/** The containers a person moves through on screen: a steps container, its steps, a tabs container (whose panels are its slots). */
const NAVIGABLE_BASES: ReadonlySet<string> = new Set(["steps", "step", "tabs"]);

/**
 * Whether `on: "paper"` takes effect for `node`: only a component that carries no answer and
 * holds none (static content, an image, a container of only those). Anything a person answers
 * stays on screen whatever it says, so paper-only never hides a question from the person
 * filling the form; nor does a button, which is something the person does, not something they
 * read, and which prints nothing; nor does a step, a steps container or a tabs container, which
 * a person moves through. A type the engine cannot read (unknown, or mapped to no answer base or
 * container) is read as one that may carry an answer.
 */
export function paperOnlyApplies(node: Pick<ComponentNode, "type" | "children" | "collection">, kinds?: Readonly<Record<string, string>> | undefined): boolean {
  if (node === null || typeof node !== "object" || typeof node.type !== "string") {
    return false;
  }
  // A container is read as the container it is drawn as; a type the engine cannot read is unknown.
  const entry = kindOf(drawnBaseOf(node, kinds));
  // A repeating section is a container that holds the rows' answers. A steps container, a step
  // and a tabs container are what a person moves through: left off a screen, a step would be an
  // empty stop on the way, so they are drawn on screen whatever they hold.
  if (
    entry === undefined ||
    (entry.kind !== undefined && entry.kind !== "group") ||
    entry.base === "button" ||
    NAVIGABLE_BASES.has(entry.base) ||
    node.collection !== undefined
  ) {
    return false;
  }
  const children = node.children;
  if (children === undefined || children === null || typeof children !== "object") {
    return true;
  }
  return Object.values(children).every((list) => !Array.isArray(list) || list.every((child) => paperOnlyApplies(child, kinds)));
}

/**
 * Whether `print.keepTogether` takes effect for `node`: a container that holds other content (a
 * group, panel, fieldset, step, repeating section or data grid, named or not). A tabs or steps
 * container is not one: on paper each of its tabs or steps is a section of its own, and a step
 * keeps itself together. The inspector offers the box only where this holds; print reads it the same.
 */
export function keepTogetherApplies(node: Pick<ComponentNode, "type" | "children"> | undefined, kinds?: Readonly<Record<string, string>> | undefined): boolean {
  if (node === null || typeof node !== "object" || typeof node.type !== "string") {
    return false;
  }
  const entry = kindOf(drawnBaseOf(node, kinds), kinds);
  return entry !== undefined && (entry.kind === "group" || entry.kind === "collection") && entry.base !== "tabs" && entry.base !== "steps" && entry.base !== "form";
}

/**
 * Whether a screen leaves `node` out: it asks for paper only (`print.on: "paper"`) and
 * {@link paperOnlyApplies} holds. The live fold's reading (`surface: "screen"`), and the one a
 * builder canvas marks a kept node by.
 */
export function leftOffScreen(node: Pick<ComponentNode, "type" | "children" | "collection" | "configuration">, kinds?: Readonly<Record<string, string>> | undefined): boolean {
  return readComponentPrintSettings(node?.configuration).on === "paper" && paperOnlyApplies(node, kinds);
}

/**
 * The note the author wrote for paper, in `locale`; `undefined` when none. The note is a string in
 * the form's default language, translated at `components › <id> › print › note`.
 */
export function readComponentPrintNote(componentId: string, configuration: unknown, locale: string, sources: TextSources = {}): string | undefined {
  const authored = printBlock(configuration).note;
  if (typeof authored !== "string") {
    return undefined;
  }
  const address: TextAddress = { kind: "components", owner: componentId, path: ["print", "note"] };
  const note = resolveText(authored, address, locale, sources);
  return note.trim() !== "" ? note : undefined;
}

/** What a live print does with one component: draw it whatever the rules say, leave it off, or follow the screen. */
export type LivePrintDecision = "keep" | "drop" | undefined;

/**
 * No answer given, as the printed field reads one (`render/print/field-answer.ts`) and validation
 * does (`isEmptyValue`): text of spaces alone and a number that is not finite are none, as is an
 * unticked lone checkbox.
 */
function isEmptyAnswer(value: unknown): boolean {
  if (value === undefined || value === null || value === false) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim() === "";
  }
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    // A checkboxes group: nothing ticked.
    return Object.values(value as Record<string, unknown>).every((entry) => entry !== true);
  }
  return false;
}

/** Whether `value` holds an answer: not blank (spaces alone are blank), not an empty list, not a checkboxes group with nothing ticked. */
export function holdsPrintAnswer(value: unknown): boolean {
  return !isEmptyAnswer(value);
}

/** The decisions of a print, from {@link livePrintPlan}. */
export interface LivePrintPlan {
  /**
   * What to do with one component. `answered`: whether it holds an answer, a container when any
   * field inside it does (only read for an `answered` component).
   */
  decide(componentId: string, answered: boolean): LivePrintDecision;
  /** An `always` component: it carries its note while a rule hides it. */
  hasNote(componentId: string): boolean;
  /**
   * A container that holds an `always` component (not under a screen-only one): printed as structure
   * around it while a rule hides the container, its other contents left off.
   */
  holdsKept(componentId: string): boolean;
}

/**
 * The decisions for a live print of `root`: every `always` component and its contents
 * kept (bar its own screen-only ones), every screen-only one (`on: "screen"`) dropped with all its contents (a journey page
 * that lists one of them by id does not bring it back), an `answered` one kept while it holds an
 * answer and dropped otherwise; the rest follow the screen. The `always` components themselves
 * carry the note while a rule hides them; the containers around one are its way onto paper.
 * `readOnly`: a read-only form's print ignores `print.show`, so only the screen-only components
 * (and their contents) are dropped and nothing is kept, noted or held for a rule.
 */
export function livePrintPlan(root: ComponentNode, readOnly = false): LivePrintPlan {
  const keep = new Set<string>();
  const drop = new Set<string>();
  const answered = new Set<string>();
  const always = new Set<string>();
  const holders = new Set<string>();
  /** Walks `node`; whether its subtree holds an `always` component that prints. */
  const walk = (node: ComponentNode, keptAbove: boolean, droppedAbove: boolean): boolean => {
    const settings = readComponentPrintSettings(node.configuration);
    const show = readOnly ? "auto" : settings.show;
    const dropped = droppedAbove || settings.on === "screen";
    let kept = keptAbove;
    if (dropped) {
      drop.add(node.id);
    } else if (show === "always") {
      always.add(node.id);
      kept = true;
    }
    if (!dropped) {
      if (show === "answered") {
        answered.add(node.id);
      } else if (kept) {
        keep.add(node.id);
      }
    }
    let holds = false;
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        holds = walk(child, kept, dropped) || holds;
      }
    }
    if (holds) {
      holders.add(node.id);
    }
    return !dropped && (holds || show === "always");
  };
  walk(root, false, false);
  return {
    decide(componentId, isAnswered) {
      if (drop.has(componentId)) {
        return "drop";
      }
      if (answered.has(componentId)) {
        return isAnswered ? "keep" : "drop";
      }
      return keep.has(componentId) ? "keep" : undefined;
    },
    hasNote: (componentId) => always.has(componentId),
    holdsKept: (componentId) => holders.has(componentId)
  };
}
