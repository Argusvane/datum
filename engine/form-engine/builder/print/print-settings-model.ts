/**
 * The Print workspace's settings card as a pure model: what it shows of the form's
 * `configuration.print` (`readPrintConfiguration`, defaults filled in) and the controller edits
 * each control makes. Every edit is a `{ propertyPath, value }` on the form root, written by the
 * surface through `controller.setProperties` so a change of several settings is one undo step;
 * `undefined` clears a setting back to its default. Touches no DOM.
 */
import {
  DEFAULT_PRINT_CONFIGURATION,
  PRINT_RENDITIONS,
  PRINT_SCALE_MAX,
  PRINT_SCALE_MIN,
  PRINT_TITLE_SLOT,
  readPrintConfiguration,
  type PrintRendition
} from "../../core/schema/print.js";
import { readComponentPrintSettings, type ComponentPrintSettings } from "../../render/core/print-options.js";
import { addressOf, resolveText, type FormTranslations, type TextSources, type TranslationCatalog } from "../../core/localization/translations.js";
import { buildValuePaths } from "../../core/tree/data-scope.js";
import { drawnBaseOf, kindOf } from "../../registry/kinds.js";
import type { ComponentNode } from "../../core/schema/types.js";

export type PrintRegion = "header" | "footer";
export type PrintSlotName = "start" | "end";

/** The four slots in the card's order. */
export const PRINT_SLOTS: ReadonlyArray<{ region: PrintRegion; slot: PrintSlotName }> = [
  { region: "header", slot: "start" },
  { region: "header", slot: "end" },
  { region: "footer", slot: "start" },
  { region: "footer", slot: "end" }
];

/** One edit of the form root's configuration. */
export interface PrintEdit {
  propertyPath: string;
  value: unknown;
}

/** One header or footer slot as the card shows it. */
export interface PrintSlotView {
  region: PrintRegion;
  slot: PrintSlotName;
  /** `print.header.start` and so on. */
  propertyPath: string;
  /** What prints there: the authored text, else the default's, so the author sees what prints. */
  value: string;
  /** The form says something of its own here (Reset is offered). */
  authored: boolean;
  /** What prints there while the form says nothing. */
  defaultText: string;
}

export interface PrintSettingsView {
  offered: PrintRendition[];
  defaultRendition: PrintRendition;
  titleOnFirstPage: boolean;
  /** The scale as a whole percent, 100 for the default. */
  scalePercent: number;
  slots: PrintSlotView[];
  journeyPageBreaks: boolean;
}

/** What the defaults print, in the words of the print's locale: the page number line is the engine's own. */
export interface PrintDefaultWords {
  /** "Page {{page}} of {{pages}}": the footer's end while the form says nothing. */
  pageNumber: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The form root's `print` block as stored, `{}` when it is not a record. */
function storedPrint(configuration: unknown): Record<string, unknown> {
  const print = isRecord(configuration) ? configuration.print : undefined;
  return isRecord(print) ? print : {};
}

/** The text a slot prints while the form says nothing there. */
export function defaultSlotText(region: PrintRegion, slot: PrintSlotName, words: PrintDefaultWords): string {
  if (region === "footer" && slot === "end") {
    return words.pageNumber;
  }
  return region === "header" ? DEFAULT_PRINT_CONFIGURATION.header[slot] : (DEFAULT_PRINT_CONFIGURATION.footer.start ?? PRINT_TITLE_SLOT);
}

/** The card's view of the form root's configuration. Never throws. */
export function printSettingsView(configuration: unknown, words: PrintDefaultWords): PrintSettingsView {
  const resolved = readPrintConfiguration(configuration);
  const stored = storedPrint(configuration);
  const slots = PRINT_SLOTS.map(({ region, slot }): PrintSlotView => {
    const block = isRecord(stored[region]) ? (stored[region] as Record<string, unknown>) : {};
    const authored = typeof block[slot] === "string";
    const defaultText = defaultSlotText(region, slot, words);
    return { region, slot, propertyPath: `print.${region}.${slot}`, value: authored ? (block[slot] as string) : defaultText, authored, defaultText };
  });
  return {
    offered: PRINT_RENDITIONS.filter((rendition) => resolved.renditions.includes(rendition)),
    defaultRendition: resolved.defaultRendition,
    titleOnFirstPage: resolved.titleOnFirstPage,
    scalePercent: Math.round(resolved.scale * 100),
    slots,
    journeyPageBreaks: resolved.journeyPageBreaks
  };
}

/**
 * Ticking or unticking a rendition. At least one stays offered: unticking the last is refused
 * (`undefined`). The default follows when its own rendition is unticked: the first one left. The
 * list is stored in the renditions' own order; offering only Answers is the default, so it is
 * cleared then, and so is a default that is the first of what is offered.
 */
export function renditionToggleEdits(configuration: unknown, rendition: PrintRendition, on: boolean): PrintEdit[] | undefined {
  const view = printSettingsView(configuration, { pageNumber: "" });
  const next = PRINT_RENDITIONS.filter((entry) => (entry === rendition ? on : view.offered.includes(entry)));
  if (next.length === 0) {
    return undefined;
  }
  if (next.length === view.offered.length && next.every((entry, index) => entry === view.offered[index])) {
    return [];
  }
  const sameAsDefault = next.length === DEFAULT_PRINT_CONFIGURATION.renditions.length && next.every((entry, index) => entry === DEFAULT_PRINT_CONFIGURATION.renditions[index]);
  const edits: PrintEdit[] = [{ propertyPath: "print.renditions", value: sameAsDefault ? undefined : next }];
  const stored = storedPrint(configuration).defaultRendition;
  const keepsDefault = next.includes(view.defaultRendition);
  if (!keepsDefault) {
    edits.push({ propertyPath: "print.defaultRendition", value: undefined });
  } else if (stored !== undefined && stored === next[0]) {
    // The default is what a form saying nothing would print: no need to say it.
    edits.push({ propertyPath: "print.defaultRendition", value: undefined });
  } else if (stored === undefined && view.defaultRendition !== next[0]) {
    // A new first rendition would move a default the form never wrote: it is written to stay put.
    edits.push({ propertyPath: "print.defaultRendition", value: view.defaultRendition });
  }
  return edits;
}

/** "Printed when none is asked for": one of the offered renditions (anything else changes nothing). */
export function defaultRenditionEdits(configuration: unknown, rendition: PrintRendition): PrintEdit[] {
  const view = printSettingsView(configuration, { pageNumber: "" });
  if (!view.offered.includes(rendition)) {
    return [];
  }
  // What an unwritten default reads as is the first rendition in the order stored, not the canonical one.
  return [{ propertyPath: "print.defaultRendition", value: rendition === readPrintConfiguration(configuration).renditions[0] ? undefined : rendition }];
}

/**
 * `edits` as the form root's `print` block settles them: the settings cleared (`undefined`) are
 * removed, and a header, a footer or the block itself left empty goes with them, so a form that
 * says nothing stores nothing (a bare `setProperty` of `undefined` would leave `print: {}` behind).
 * Only the keys that change are written, whole (`print.header` as it ends up); an edit that
 * changes nothing is dropped, so it leaves no undo step either.
 */
export function settledPrintEdits(configuration: unknown, edits: readonly PrintEdit[]): PrintEdit[] {
  const before = storedPrint(configuration);
  const after = structuredClone(before);
  for (const edit of edits) {
    const parts = edit.propertyPath.split(".");
    if (parts[0] !== "print" || parts.length < 2) {
      continue;
    }
    let at: Record<string, unknown> = after;
    for (const part of parts.slice(1, -1)) {
      if (!isRecord(at[part])) {
        if (edit.value === undefined) {
          at = {};
          break;
        }
        at[part] = {};
      }
      at = at[part] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1]!;
    if (edit.value === undefined) {
      delete at[last];
    } else {
      at[last] = edit.value;
    }
  }
  for (const region of ["header", "footer"]) {
    if (isRecord(after[region]) && Object.keys(after[region] as object).length === 0) {
      delete after[region];
    }
  }
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (Object.keys(after).length === 0) {
    return isRecord(isRecord(configuration) ? configuration.print : undefined) && !same(before, after) ? [{ propertyPath: "print", value: undefined }] : [];
  }
  const settled: PrintEdit[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!same(before[key], after[key])) {
      settled.push({ propertyPath: `print.${key}`, value: after[key] });
    }
  }
  return settled;
}

/** The form title on the first page; on is the default. */
export function titleOnFirstPageEdits(on: boolean): PrintEdit[] {
  return [{ propertyPath: "print.titleOnFirstPage", value: on ? undefined : false }];
}

/** Each journey page starts a new sheet; off is the default. */
export function journeyPageBreaksEdits(on: boolean): PrintEdit[] {
  return [{ propertyPath: "print.journeyPageBreaks", value: on ? true : undefined }];
}

/**
 * The scale box's text as a percent: a number within the printable range (25 to 200) is written
 * as a factor, 100 clears it; anything else writes nothing (`undefined`), so a half-typed number
 * never reaches the form.
 */
export function scaleEdits(text: string): PrintEdit[] | undefined {
  const trimmed = typeof text === "string" ? text.trim().replace(/%$/, "").trim() : "";
  if (!/^\d+(?:[.,]\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const percent = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(percent) || percent < PRINT_SCALE_MIN * 100 || percent > PRINT_SCALE_MAX * 100) {
    return undefined;
  }
  const factor = Math.round(percent * 100) / 10000;
  return [{ propertyPath: "print.scale", value: factor === 1 ? undefined : factor }];
}

/** A slot's text as typed: written as it is, `""` included (nothing prints there). */
export function slotEdits(region: PrintRegion, slot: PrintSlotName, text: string): PrintEdit[] {
  return [{ propertyPath: `print.${region}.${slot}`, value: typeof text === "string" ? text : "" }];
}

/** A slot back to what the form prints while it says nothing. */
export function slotResetEdits(region: PrintRegion, slot: PrintSlotName): PrintEdit[] {
  return [{ propertyPath: `print.${region}.${slot}`, value: undefined }];
}

/** The insert shortcuts beside a slot box (the receipt and field ones ask which value). */
export type PrintSlotInsert = "title" | "pages" | "date" | "receipt" | "field";

/** The placeholder text an insert puts in: `{{receipt.reference}}` for the receipt, `{{path}}` for a field. */
export function insertionText(insert: PrintSlotInsert, words: PrintDefaultWords, path?: string): string {
  switch (insert) {
    case "title":
      return PRINT_TITLE_SLOT;
    case "pages":
      return words.pageNumber;
    case "date":
      return "{{date}}";
    case "receipt":
      return `{{receipt.${path !== undefined && path !== "" ? path : "reference"}}}`;
    case "field":
      return path !== undefined && path !== "" ? `{{${path}}}` : "";
  }
}

/**
 * `insertion` put into `text` over the selection `start`..`end` (the caret when they are equal),
 * with a space between it and a word it would otherwise run into; the caret after it.
 */
export function insertAt(text: string, start: number, end: number, insertion: string): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after !== "" && !/^\s/.test(after) ? " " : "";
  const next = `${before}${lead}${insertion}${trail}${after}`;
  return { text: next, caret: before.length + lead.length + insertion.length };
}

/** What a component's name resolves through: the form's translations, then the host's catalog. */
export function labelSourcesOf(controller: { translations(): FormTranslations | undefined; translationCatalog(): TranslationCatalog | undefined }): TextSources {
  return { translations: controller.translations(), catalog: controller.translationCatalog() };
}

/** A component's name for the card: its label (or title, legend, heading) worded for `locale` through `sources`, else its id. */
export function componentLabel(node: Pick<ComponentNode, "id" | "configuration">, locale: string, sources: TextSources = {}): string {
  const configuration = isRecord(node.configuration) ? node.configuration : {};
  for (const key of ["label", "title", "legend", "heading", "text"]) {
    const value = configuration[key];
    if (typeof value !== "string" || value.trim() === "") {
      continue;
    }
    const text = resolveText(value, addressOf.component(node.id, key), locale, sources);
    if (text.trim() !== "") {
      return text.trim();
    }
  }
  return node.id;
}

/** A component whose print settings the form sets, for the "Page breaks and what prints" list. */
export interface ComponentPrintEntry {
  id: string;
  type: string;
  label: string;
  settings: ComponentPrintSettings;
}

/** Every component (the root aside) that says anything about how it prints, in the form's order. */
export function componentPrintEntries(root: ComponentNode, locale: string, sources: TextSources = {}): ComponentPrintEntry[] {
  const out: ComponentPrintEntry[] = [];
  const walk = (node: ComponentNode): void => {
    for (const group of Object.values(node.children ?? {})) {
      if (!Array.isArray(group)) {
        continue;
      }
      for (const child of group) {
        if (child === null || typeof child !== "object") {
          continue;
        }
        const settings = readComponentPrintSettings(child.configuration);
        if (settings.on !== "both" || settings.breakBefore || settings.keepTogether || settings.show !== "auto") {
          out.push({ id: child.id, type: child.type, label: componentLabel(child, locale, sources), settings });
        }
        walk(child);
      }
    }
  };
  if (root && typeof root === "object") {
    walk(root);
  }
  return out;
}

/** A component the card's picker offers: its id, name, type and depth in the form. */
export interface PrintPickerEntry {
  id: string;
  label: string;
  type: string;
  depth: number;
}

/**
 * Every component that can print (the root and buttons aside, which print nothing), in the
 * form's order: what the card's picker lists, so a component is reached without the sheet.
 */
export function printPickerEntries(root: ComponentNode, locale: string, kinds?: Readonly<Record<string, string>>, sources: TextSources = {}): PrintPickerEntry[] {
  const out: PrintPickerEntry[] = [];
  const walk = (node: ComponentNode, depth: number): void => {
    for (const group of Object.values(node.children ?? {})) {
      if (!Array.isArray(group)) {
        continue;
      }
      for (const child of group) {
        if (child === null || typeof child !== "object" || typeof child.id !== "string") {
          continue;
        }
        if (kindOf(drawnBaseOf(child, kinds), kinds)?.base !== "button") {
          out.push({ id: child.id, label: componentLabel(child, locale, sources), type: child.type, depth });
        }
        walk(child, depth + 1);
      }
    }
  };
  if (root && typeof root === "object") {
    walk(root, 0);
  }
  return out;
}

/** Clear on one entry of the list: its place, its breaks and its rule behaviour back to the defaults (its note stays), one undo step. */
export function clearComponentPrintEdits(componentId: string): Array<{ componentId: string; propertyPath: string; value: unknown }> {
  return ["print.on", "print.breakBefore", "print.keepTogether", "print.show"].map((propertyPath) => ({ componentId, propertyPath, value: undefined }));
}

/** A field the Field… insert offers: its value path, and its name. */
export interface PrintFieldOption {
  path: string;
  label: string;
}

/** The form's answers a slot can print, by value path: fields that hold an answer, outside a repeating section. */
export function printFieldOptions(root: ComponentNode, locale: string, kinds?: Readonly<Record<string, string>>, sources: TextSources = {}): PrintFieldOption[] {
  if (!root || typeof root !== "object") {
    return [];
  }
  let paths: Map<string, string>;
  try {
    paths = buildValuePaths(root);
  } catch {
    return [];
  }
  const out: PrintFieldOption[] = [];
  const walk = (node: ComponentNode): void => {
    for (const group of Object.values(node.children ?? {})) {
      if (!Array.isArray(group)) {
        continue;
      }
      for (const child of group) {
        if (child === null || typeof child !== "object" || child.collection !== undefined) {
          continue;
        }
        const entry = kindOf(drawnBaseOf(child, kinds), kinds);
        const path = paths.get(child.id);
        if (entry?.kind !== undefined && entry.kind !== "group" && entry.kind !== "collection" && path !== undefined) {
          out.push({ path, label: componentLabel(child, locale, sources) });
        }
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}
