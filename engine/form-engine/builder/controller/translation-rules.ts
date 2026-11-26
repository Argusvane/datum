/**
 * The builder's rules for the translations map that depend on what a node's
 * configuration holds, as pure functions: which texts a configuration carries beyond the fields
 * the inspector declares (inline options, validation messages, tab captions, header and footer
 * parts), where a text sits in the configuration to write it, and what an edit of the
 * configuration does to the map (a deleted option, message code, tab or part prunes its
 * entries; an option whose value was retyped, or a part whose id was, moves them). The controller wraps the result in a
 * history command; nothing here touches the tree.
 */
import { isInlineOption } from "../../core/schema/inline-options.js";
import { moveTranslations, pruneTranslations, type FormTranslations, type TextAddress, type TranslationKind } from "../../core/localization/translations.js";
import type { ChromeTextProperty } from "../../core/schema/form-chrome.js";
import { kernelMaxComponentDepth } from "../../core/expressions/compile.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An id the form re-keyed, as the change event announces it (translations are addressed by id): a
 * host keeping a catalog under the same addresses renames its entries with it. `kind` is the
 * map's kind the id lives under. A top-level owner (a component, a header or footer part, a
 * journey, a layout) has neither `owner` nor `within`; a key that lives inside an owner (an
 * option's value, a journey page's id, a layout node's id) names it: `owner` is the owner's id
 * and `within` the level below it (`options`, `pages`, `nodes`), so `from` and `to` are told
 * apart from the owners' ids.
 */
export interface RenamedTextId {
  kind: TranslationKind;
  from: string;
  to: string;
  owner?: string;
  within?: string;
}

/** A stable key for an address, to find a text by where it lives. */
export function addressKey(address: TextAddress): string {
  return JSON.stringify([address.kind, address.owner ?? null, ...address.path]);
}

/**
 * How deep the walks below follow a group inside a group: the nesting a definition may have at
 * most (the renderer's reader stops there too), so a chrome nested without end is read to that
 * level and no further instead of exhausting the stack.
 */
const CHROME_DEPTH = kernelMaxComponentDepth();

const CHROME_TEXT_PROPERTIES: readonly ChromeTextProperty[] = ["label", "src", "alt", "href", "text", "html"];

/** One text of a header or footer part, with the builder's property path to it on the form root. */
export interface ChromeTextRow {
  /** `chrome.header.0.text`, or `chrome.header.0.parts.1.text` inside a group. */
  propertyPath: string;
  partId: string;
  partType: string;
  property: ChromeTextProperty;
  text: string;
}

/** Every text of the root's header and footer parts, in reading order; parts without an id are not translatable and are passed over. */
export function chromeTextRows(configuration: unknown): ChromeTextRow[] {
  const chrome = isRecord(configuration) ? configuration.chrome : undefined;
  const rows: ChromeTextRow[] = [];
  if (!isRecord(chrome)) {
    return rows;
  }
  const walk = (parts: unknown, path: string, depth: number): void => {
    if (!Array.isArray(parts) || depth > CHROME_DEPTH) {
      return;
    }
    parts.forEach((part, index) => {
      if (!isRecord(part)) {
        return;
      }
      const here = `${path}.${index}`;
      if (typeof part.id === "string" && part.id.length > 0) {
        for (const property of CHROME_TEXT_PROPERTIES) {
          const value = part[property];
          if (typeof value === "string") {
            rows.push({ propertyPath: `${here}.${property}`, partId: part.id, partType: String(part.type), property, text: value });
          }
        }
      }
      walk(part.parts, `${here}.parts`, depth + 1);
    });
  };
  walk(chrome.header, "chrome.header", 1);
  walk(chrome.footer, "chrome.footer", 1);
  return rows;
}

/** The ids of every authored header and footer part (groups included), in reading order. */
export function chromePartIds(configuration: unknown): string[] {
  const chrome = isRecord(configuration) ? configuration.chrome : undefined;
  const ids: string[] = [];
  if (!isRecord(chrome)) {
    return ids;
  }
  const walk = (parts: unknown, depth: number): void => {
    if (!Array.isArray(parts) || depth > CHROME_DEPTH) {
      return;
    }
    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }
      if (typeof part.id === "string" && part.id.length > 0) {
        ids.push(part.id);
      }
      walk(part.parts, depth + 1);
    }
  };
  walk(chrome.header, 1);
  walk(chrome.footer, 1);
  return ids;
}

/**
 * The part ids that occur more than once across the header and footer (unique
 * across both, since a part's translations are keyed by it), in reading order, each once.
 */
export function repeatedChromeIds(configuration: unknown): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const id of chromePartIds(configuration)) {
    if (seen.has(id) && !repeated.includes(id)) {
      repeated.push(id);
    }
    seen.add(id);
  }
  return repeated;
}

/**
 * A part id `after` repeats that `before` did not: the one a write must refuse. An id the two
 * regions already shared is not made worse by a write that leaves it alone, so only a repeated
 * id the committed chrome did not have counts (the same rule the agent's writes apply).
 */
export function newlyRepeatedChromeId(before: unknown, after: unknown): string | undefined {
  const shared = new Set(repeatedChromeIds(before));
  return repeatedChromeIds(after).find((id) => !shared.has(id));
}

/** One authored header or footer part with where it sits: its region, its position among its siblings (groups nest) and its type. */
interface ChromePartSlot {
  id: string;
  type: string;
  /** `header/0`, `footer/1/parts/0`: the same slot before and after an edit names the same place. */
  slot: string;
}

/** Whether the form root's configuration words a print header or footer slot itself (a non-empty string). */
function printSlotWritten(configuration: unknown, band: "header" | "footer", slot: "start" | "end"): boolean {
  const print = isRecord(configuration) ? configuration.print : undefined;
  const region = isRecord(print) ? print[band] : undefined;
  const text = isRecord(region) ? region[slot] : undefined;
  return typeof text === "string" && text !== "";
}

/** Every authored part (groups included) with its slot, in reading order. */
function chromePartSlots(configuration: unknown): ChromePartSlot[] {
  const chrome = isRecord(configuration) ? configuration.chrome : undefined;
  const slots: ChromePartSlot[] = [];
  if (!isRecord(chrome)) {
    return slots;
  }
  const walk = (parts: unknown, path: string, depth: number): void => {
    if (!Array.isArray(parts) || depth > CHROME_DEPTH) {
      return;
    }
    parts.forEach((part, index) => {
      if (!isRecord(part)) {
        return;
      }
      const here = `${path}/${index}`;
      if (typeof part.id === "string" && part.id.length > 0) {
        slots.push({ id: part.id, type: String(part.type), slot: here });
      }
      walk(part.parts, `${here}/parts`, depth + 1);
    });
  };
  walk(chrome.header, "header", 1);
  walk(chrome.footer, "footer", 1);
  return slots;
}

/**
 * The parts whose id was retyped: an id that went away and a new id that appeared at the same
 * slot (region, position, nesting) with the same type. Pairs `[old, new]`, each id used once.
 */
function renamedPartIds(before: unknown, after: unknown): Array<[string, string]> {
  const was = chromePartSlots(before);
  const now = chromePartSlots(after);
  const wasIds = new Set(was.map((part) => part.id));
  const nowIds = new Set(now.map((part) => part.id));
  const nowBySlot = new Map(now.map((part) => [part.slot, part] as const));
  const pairs: Array<[string, string]> = [];
  const taken = new Set<string>();
  for (const part of was) {
    const there = nowBySlot.get(part.slot);
    if (nowIds.has(part.id) || there === undefined || wasIds.has(there.id) || taken.has(there.id) || there.type !== part.type) {
      continue;
    }
    taken.add(there.id);
    pairs.push([part.id, there.id]);
  }
  return pairs;
}

/** The inline options a configuration lists, in order (an entry that is no option is passed over). */
function inlineOptionsOf(configuration: unknown): Array<{ value: string; label: string }> | undefined {
  const options = isRecord(configuration) ? configuration.options : undefined;
  return Array.isArray(options) ? options.filter(isInlineOption).map((option) => ({ value: option.value, label: option.label })) : undefined;
}

/** The `value` of every inline option a configuration lists, in order (an entry that is no option is passed over). */
export function optionValues(configuration: unknown): string[] | undefined {
  const options = isRecord(configuration) ? configuration.options : undefined;
  return Array.isArray(options) ? options.filter(isInlineOption).map((option) => option.value) : undefined;
}

/** The codes of the validation messages a configuration words (string values only). */
export function messageCodes(configuration: unknown): string[] {
  const messages = isRecord(configuration) ? configuration.messages : undefined;
  return isRecord(messages) ? Object.entries(messages).filter(([, value]) => typeof value === "string").map(([code]) => code) : [];
}

/** The ids of the tabs a configuration declares. */
export function tabIds(configuration: unknown): string[] {
  const tabs = isRecord(configuration) ? configuration.tabs : undefined;
  return Array.isArray(tabs) ? tabs.filter(isRecord).map((tab) => tab.id).filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/** Where a tab's caption is translated: the tab's own id, never its position. */
export function tabLabelAddress(ownerId: string, tabId: string): TextAddress {
  return { kind: "components", owner: ownerId, path: ["tabs", tabId, "label"] };
}

/**
 * `map` after the configuration of `ownerId` went from `before` to `after`: the
 * entries of an option, message, tab or header/footer part the edit took away are pruned in
 * every locale. An option list of the same length whose value changed at one place (and whose
 * old value is gone, new value is new) is a retyped key: its entries move with it, and so does
 * an option that vanished while a new value carries the same label (a retype in a write that
 * also deleted another option). A header or footer part whose id changed at the same slot (region,
 * position, type) moves its entries to the new id. The form
 * root (`isRoot`) keeps its messages under `form`, and owns the header and footer parts. A
 * text that merely changed wording is not touched: its entries go stale on their own (`source`).
 * Each id this moves is pushed on `renamed` when the caller passes a list, for the change event.
 */
export function sweepConfigurationTexts(
  map: FormTranslations,
  ownerId: string,
  isRoot: boolean,
  before: unknown,
  after: unknown,
  renamed?: RenamedTextId[]
): FormTranslations {
  let next = map;
  const inComponent = (path: readonly string[]) => ({ kind: "components" as const, owner: ownerId, path });

  if (!isRoot) {
    const was = optionValues(before);
    if (was !== undefined) {
      const now = optionValues(after) ?? [];
      const moved = new Set<string>();
      const claimed = new Set<string>();
      const wasLabels = inlineOptionsOf(before) ?? [];
      const nowLabels = inlineOptionsOf(after) ?? [];
      if (was.length === now.length) {
        was.forEach((value, index) => {
          const to = now[index]!;
          // By position only when the label at this index is unchanged: a value and a label
          // rewritten together (a whole new list of the same length) is a different option, and
          // the old one's words must not follow the new value. The label-twin
          // rule below still moves an option whose label stands somewhere else.
          if (value !== to && !now.includes(value) && !was.includes(to) && wasLabels[index]?.label === nowLabels[index]?.label) {
            next = moveTranslations(next, inComponent(["options", value]), inComponent(["options", to]));
            renamed?.push({ kind: "components", owner: ownerId, within: "options", from: value, to });
            moved.add(value);
            claimed.add(to);
          }
        });
      }
      // A write that retypes one value and drops another is a different length, so the position
      // rule above cannot see the retyped one: an option that vanished and whose label stands
      // unchanged at a value that is new is the same option under a new key.
      const wasOptions = inlineOptionsOf(before) ?? [];
      const nowOptions = inlineOptionsOf(after) ?? [];
      for (const old of wasOptions) {
        if (now.includes(old.value) || moved.has(old.value) || old.label === "") {
          continue;
        }
        const twin = nowOptions.find((option) => !was.includes(option.value) && !claimed.has(option.value) && option.label === old.label);
        if (twin !== undefined) {
          claimed.add(twin.value);
          next = moveTranslations(next, inComponent(["options", old.value]), inComponent(["options", twin.value]));
          renamed?.push({ kind: "components", owner: ownerId, within: "options", from: old.value, to: twin.value });
          moved.add(old.value);
        }
      }
      for (const value of was) {
        if (!now.includes(value) && !moved.has(value)) {
          next = pruneTranslations(next, inComponent(["options", value]));
        }
      }
    }
    const nowTabs = new Set(tabIds(after));
    for (const id of tabIds(before)) {
      if (!nowTabs.has(id)) {
        next = pruneTranslations(next, inComponent(["tabs", id]));
      }
    }
  }

  const nowCodes = new Set(messageCodes(after));
  for (const code of messageCodes(before)) {
    if (!nowCodes.has(code)) {
      next = pruneTranslations(next, isRoot ? { kind: "form", path: ["messages", code] } : inComponent(["messages", code]));
    }
  }

  if (isRoot) {
    // A part whose id was retyped (same slot and type) carries its entries to the new id.
    const movedParts = new Set<string>();
    for (const [from, to] of renamedPartIds(before, after)) {
      next = moveTranslations(next, { kind: "chrome", owner: from }, { kind: "chrome", owner: to });
      renamed?.push({ kind: "chrome", from, to });
      movedParts.add(from);
    }
    const nowParts = new Set(chromePartIds(after));
    for (const id of chromePartIds(before)) {
      if (!nowParts.has(id) && !movedParts.has(id)) {
        next = pruneTranslations(next, { kind: "chrome", owner: id });
      }
    }
    // A print header or footer slot emptied or reset to its default has no words of the author's
    // left: its translations go with the words.
    for (const band of ["header", "footer"] as const) {
      for (const slot of ["start", "end"] as const) {
        if (printSlotWritten(before, band, slot) && !printSlotWritten(after, band, slot)) {
          next = pruneTranslations(next, { kind: "form", path: ["print", band, slot] });
        }
      }
    }
  }
  return next;
}

/**
 * `configuration` with `value` written at the builder's `propertyPath`. A validation message is
 * written by its code as a whole (a code may hold a dot no path could address); everything else
 * steps through the path, numeric segments indexing a list. Returns the same object.
 */
export function writeTextInConfiguration(configuration: Record<string, unknown>, propertyPath: string, value: string): Record<string, unknown> {
  if (propertyPath.startsWith("messages.")) {
    const code = propertyPath.slice("messages.".length);
    const messages = isRecord(configuration.messages) ? { ...configuration.messages } : {};
    messages[code] = value;
    configuration.messages = messages;
    return configuration;
  }
  const parts = propertyPath.split(".").filter(Boolean);
  const last = parts.pop();
  if (last === undefined) {
    return configuration;
  }
  let cursor: unknown = configuration;
  for (const part of parts) {
    cursor = Array.isArray(cursor) && /^\d+$/.test(part) ? cursor[Number(part)] : isRecord(cursor) ? cursor[part] : undefined;
    if (cursor === undefined || cursor === null || typeof cursor !== "object") {
      return configuration;
    }
  }
  if (Array.isArray(cursor) && /^\d+$/.test(last)) {
    cursor[Number(last)] = value;
  } else if (isRecord(cursor)) {
    cursor[last] = value;
  }
  return configuration;
}
