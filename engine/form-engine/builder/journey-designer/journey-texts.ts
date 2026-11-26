/**
 * Writing the journeys' default texts back. A journey's name, a page's title and
 * description and the wording of either are plain strings in the form's default language; their
 * translations are the definition's map (`journeys › <journey id> › …`), written by the form's
 * controller and never by this module. What a language change still has to rewrite *here* is the
 * default strings: Make default promotes a translation to be the default, and the journeys'
 * block must hold the new one in the same undo step (`BuilderController.setOutsideDocuments`).
 *
 * A text is addressed as the map addresses it: the journey, a page below it, a property path
 * below either (`journeyTextAddress`), or a page-only node under its own id
 * (`components › <node id> ›`), the way the renderer resolves it.
 */
import type { BuilderCommand } from "../history/command-history.js";
import { writeTextInConfiguration, type RenamedTextId } from "../controller/translation-rules.js";
import { setPathValue, type OutsideDefaultEdit } from "../../core/localization/locale-documents.js";
import type { FormTranslations } from "../../core/localization/translations.js";
import { PRESENTATION_REFERENCE_TYPE, type Journey, type JourneyConfiguration } from "../../core/schema/journey.js";
import { JOURNEY_TEXT_FIELDS } from "./journey-catalog.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The own node `id` among a page's components, however deeply it sits in the layouts the nodes hold. */
function findOwnNode(entries: unknown, id: string): Record<string, unknown> | undefined {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isRecord(entry)) {
      continue;
    }
    if (entry.id === id && typeof entry.type === "string") {
      return entry;
    }
    for (const held of isRecord(entry.children) ? Object.values(entry.children) : []) {
      const found = findOwnNode(held, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

const JOURNEY_PATHS: ReadonlySet<string> = new Set(JOURNEY_TEXT_FIELDS.journey.map((field) => field.propertyPath));
const PAGE_PATHS: ReadonlySet<string> = new Set(JOURNEY_TEXT_FIELDS.page.map((field) => field.propertyPath));

/**
 * Writes `value` at `path` of a page-only node's configuration: a property, an inline option's
 * text by its `value`, a validation message by its code, the note printed beside a hidden field
 * (`print.note`) or a tab's caption by the tab's `id` — every address `addressOfPropertyPath`
 * can name on a component. The path is turned back into the builder's property path and written
 * by the form tree's own writer, so the two grammars cannot drift apart. `false` when the path
 * names nothing the node holds.
 */
function writeOwnText(node: Record<string, unknown>, path: readonly string[], value: string): boolean {
  const configuration = isRecord(node.configuration) ? node.configuration : (node.configuration = {});
  const holder = configuration as Record<string, unknown>;
  if (path.length === 1) {
    setPathValue(holder, path[0]!, value);
    return true;
  }
  if (path.length === 3 && path[0] === "options") {
    const option = (Array.isArray(holder.options) ? holder.options : []).find((entry) => isRecord(entry) && entry.value === path[1]);
    if (!isRecord(option) || (path[2] !== "label" && path[2] !== "description")) {
      return false;
    }
    option[path[2]] = value;
    return true;
  }
  if (path.length === 2 && path[0] === "messages") {
    const messages = isRecord(holder.messages) ? holder.messages : (holder.messages = {});
    Object.defineProperty(messages, path[1]!, { value, enumerable: true, writable: true, configurable: true });
    return true;
  }
  if (path.length === 2 && path[0] === "print" && path[1] === "note") {
    // The holder is made when the node carries no `print` yet; its other words (`show`) stay.
    if (!isRecord(holder.print)) {
      holder.print = {};
    }
    writeTextInConfiguration(holder, "print.note", value);
    return true;
  }
  if (path.length === 3 && path[0] === "tabs" && path[2] === "label") {
    const index = (Array.isArray(holder.tabs) ? holder.tabs : []).findIndex((entry) => isRecord(entry) && entry.id === path[1]);
    if (index < 0) {
      return false;
    }
    writeTextInConfiguration(holder, `tabs.${index}.label`, value);
    return true;
  }
  return false;
}

/**
 * `configuration` with the default strings of `edits` written (a copy: the input is untouched).
 * An edit whose journey, page or node is no longer there, or whose path is not a text the
 * designer edits, is dropped; the input itself comes back when nothing lands.
 */
export function setJourneyDefaults(configuration: JourneyConfiguration | undefined, edits: readonly OutsideDefaultEdit[]): JourneyConfiguration | undefined {
  if (!configuration || edits.length === 0) {
    return configuration;
  }
  const next = structuredClone(configuration);
  const journeys = (Array.isArray(next.journeys) ? next.journeys : []).filter((entry): entry is Journey => isRecord(entry) && typeof entry.id === "string");
  let landed = false;
  for (const { address, default: text } of edits) {
    if (address.kind === "journeys" && address.owner !== undefined) {
      const journey = journeys.find((entry) => entry.id === address.owner);
      if (!journey) {
        continue;
      }
      if (address.path[0] === "pages" && address.path.length >= 3) {
        const page = (Array.isArray(journey.pages) ? journey.pages : []).find((entry) => entry.id === address.path[1]);
        const rest = address.path.slice(2).join(".");
        if (page && PAGE_PATHS.has(rest)) {
          setPathValue(page as unknown as Record<string, unknown>, rest, text);
          landed = true;
        }
      } else if (JOURNEY_PATHS.has(address.path.join("."))) {
        setPathValue(journey as unknown as Record<string, unknown>, address.path.join("."), text);
        landed = true;
      }
      continue;
    }
    if (address.kind === "components" && address.owner !== undefined) {
      for (const journey of journeys) {
        for (const page of Array.isArray(journey.pages) ? journey.pages : []) {
          const node = findOwnNode((page as { components?: unknown }).components, address.owner);
          if (node && writeOwnText(node, address.path, text)) {
            landed = true;
          }
        }
      }
    }
  }
  return landed ? next : configuration;
}

/**
 * What the Journeys mode asks of the form's controller to reach the definition's translations:
 * the committed map (`translations`), and one undo step on the form's history that
 * runs a pure rewrite over it (`rewriteTranslations`: a prune, a move, a copy). Reached through this
 * shape so the journey code names only what it uses, and leaves the map alone on a controller
 * without them.
 */
export interface FormTranslationsAccess {
  translations?(): FormTranslations | undefined;
  rewriteTranslations?(update: (map: FormTranslations) => FormTranslations, alongside?: BuilderCommand, renamed?: readonly RenamedTextId[]): boolean;
  /** A change the mode already made to its block, as a step of the form's history (`BuilderController.recordStep`). */
  recordStep?(command: BuilderCommand): void;
}

/** The definition's translations as the form holds them now; `undefined` when it has none. */
export function formTranslationsOf(form: object): FormTranslations | undefined {
  return (form as FormTranslationsAccess).translations?.();
}

/**
 * Runs `rewrite` over the form's translations as one step of the form's history, when the
 * controller offers it. `alongside` is the journeys' block change composed into the same step
 * and `renamed` the re-keyed ids the change event announces (`BuilderController.rewriteTranslations`).
 * Whether a step was made: none when the map stays as it was.
 */
export function rewriteFormTranslations(
  form: object,
  rewrite: (map: FormTranslations) => FormTranslations,
  alongside?: BuilderCommand,
  renamed?: readonly RenamedTextId[]
): boolean {
  return (form as FormTranslationsAccess).rewriteTranslations?.(rewrite, alongside, renamed) === true;
}

/**
 * The ids of a journey's page-only nodes, at any depth: the owners of the texts they
 * word, which live under `components › <node id>` because the renderer resolves a page-only node
 * under its own id. A reference to a form component is not one of them.
 */
export function ownNodeIdsOf(journey: Journey | undefined): Set<string> {
  const ids = new Set<string>();
  const stack: unknown[] = [];
  for (const page of Array.isArray(journey?.pages) ? journey.pages : []) {
    stack.push(...(Array.isArray(page.components) ? page.components : []));
  }
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node) || node.type === PRESENTATION_REFERENCE_TYPE || typeof node.id !== "string" || typeof node.type !== "string") {
      continue;
    }
    ids.add(node.id);
    for (const held of isRecord(node.children) ? Object.values(node.children) : []) {
      if (Array.isArray(held)) {
        stack.push(...held);
      }
    }
  }
  return ids;
}
