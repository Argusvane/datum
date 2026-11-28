/**
 * A form component's rename followed into the journeys' stored block: the
 * configuration-level half of `journey-references.ts`, kept out of the Journeys mode's chunk.
 * `<datum-form-builder>` rewrites the definition's journeys with it whenever its
 * Journeys mode is not registered — `journeys="off"`, a hidden workspace, the chunk still coming
 * or failed — so a rename is followed whether or not the mode ever loads. The mode itself reaches
 * the same functions through `journey-references.ts`, which re-exports them.
 *
 * Pure: every function returns what it was given, the same object, when nothing in it names the
 * old id. Static and free of work at import.
 */
import {
  PRESENTATION_REFERENCE_TYPE,
  PRESENTATION_VALUE_TYPE,
  validateJourneyShape,
  type Journey,
  type JourneyConfiguration,
  type JourneyPage,
  type JourneyPageEntry
} from "../../core/schema/journey.js";
import { journeyLeadingSegment } from "../../core/journey/journey-shared.js";
import { renamePathsInFormula } from "../formula/rename.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A path read from outside the form's answers: an entry's, an ancestor's, the host's or the component's own. */
export function isScopedPath(path: string): boolean {
  return (
    path === "component" ||
    path.startsWith("component.") ||
    path.startsWith("row.") ||
    path.startsWith("ancestor.") ||
    path.startsWith("host.")
  );
}

/** `path` with its leading segment `from` replaced by `to`; `path` itself when it does not lead with `from`. */
export function renamePathSegment(path: string, from: string, to: string): string {
  if (from === "" || from === to || isScopedPath(path) || journeyLeadingSegment(path) !== from) {
    return path;
  }
  return `${to}${path.slice(from.length)}`;
}

/**
 * A condition with every form-scoped `path` node that leads with `from` renamed to lead with
 * `to`, all the way down, whatever the expression's shape; the condition itself when none does.
 */
export function renameConditionPaths<T>(condition: T, from: string, to: string): T {
  if (from === "" || from === to) {
    return condition;
  }
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      // A formula string: a condition on its own, or the object form's `formula` (see below).
      return renamePathsInFormula(value, from, to);
    }
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const renamed = typeof item === "string" ? item : visit(item);
        changed ||= renamed !== item;
        return renamed;
      });
      return changed ? next : value;
    }
    if (!isRecord(value)) {
      return value;
    }
    if (value.kind === "path" && typeof value.path === "string") {
      const path = renamePathSegment(value.path, from, to);
      return path === value.path ? value : { ...value, path };
    }
    // Strings inside a tree are literals and names; only the object form's `formula` is a
    // formula (a node has a `kind`, the object form has none).
    const formulaKey = value.kind === undefined && typeof value.formula === "string" ? "formula" : undefined;
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const renamed = key === formulaKey || typeof item !== "string" ? visit(item) : item;
      changed ||= renamed !== item;
      return [key, renamed] as const;
    });
    // Defined, not assigned: a key such as `__proto__` stays a key of the copy, as written.
    return changed ? Object.fromEntries(entries) : value;
  };
  return typeof condition === "string" ? (renamePathsInFormula(condition, from, to) as T) : (visit(condition) as T);
}

/** The rules of a node a presentation owns whose form-scoped paths follow a rename. */
export const OWN_RULE_KEYS: readonly string[] = ["visibleWhen", "enabledWhen", "readonlyWhen", "requiredWhen"];

/**
 * One entry of a page with the component `from` renamed to `to`: an id, or a node
 * the presentation owns with everything under it — its references, what it fills or works out,
 * and the form paths its rules read. The entry itself when nothing in it names `from`; a node
 * that does is copied with its keys in their order, every other key as it was.
 */
export function renameEntry(entry: JourneyPageEntry, from: string, to: string): JourneyPageEntry {
  if (typeof entry === "string") {
    return entry === from ? to : entry;
  }
  const visit = (node: unknown): unknown => {
    if (!isRecord(node)) {
      return node;
    }
    let next: Record<string, unknown> | undefined;
    const put = (key: string, value: unknown): void => {
      next ??= { ...node };
      next[key] = value;
    };
    const configuration = isRecord(node.configuration) ? node.configuration : undefined;
    if (node.type === PRESENTATION_REFERENCE_TYPE) {
      if (configuration?.componentId === from) {
        put("configuration", { ...configuration, componentId: to });
      }
      return next ?? node;
    }
    if (configuration !== undefined) {
      let settings = configuration;
      if (settings.fills === from) {
        settings = { ...settings, fills: to };
      }
      if (node.type === PRESENTATION_VALUE_TYPE && settings.to === from) {
        settings = { ...settings, to };
      }
      if (settings !== configuration) {
        put("configuration", settings);
      }
    }
    if (isRecord(node.rules)) {
      const rules = node.rules;
      let nextRules: Record<string, unknown> | undefined;
      for (const key of OWN_RULE_KEYS) {
        const rule = rules[key];
        const renamed = rule === undefined ? rule : renameConditionPaths(rule, from, to);
        if (renamed !== rule) {
          nextRules ??= { ...rules };
          nextRules[key] = renamed;
        }
      }
      if (nextRules !== undefined) {
        put("rules", nextRules);
      }
    }
    if (isRecord(node.children)) {
      const children = node.children;
      let nextChildren: Record<string, unknown> | undefined;
      for (const [slot, held] of Object.entries(children)) {
        if (!Array.isArray(held)) {
          continue;
        }
        let slotChanged = false;
        const renamed = held.map((child: unknown) => {
          const visited = visit(child);
          slotChanged ||= visited !== child;
          return visited;
        });
        if (slotChanged) {
          nextChildren ??= { ...children };
          nextChildren[slot] = renamed;
        }
      }
      if (nextChildren !== undefined) {
        put("children", nextChildren);
      }
    }
    return next ?? node;
  };
  return visit(entry) as JourneyPageEntry;
}

/** `labels` with the key `from` renamed `to`, in its place; the same object when it has no such key. A Check answers step words its rows by component id. */
export function renameReviewLabels<T extends Record<string, unknown>>(labels: T, from: string, to: string): T {
  if (!Object.prototype.hasOwnProperty.call(labels, from)) {
    return labels;
  }
  return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key === from ? to : key, value])) as T;
}

function renamePage(page: JourneyPage, from: string, to: string): JourneyPage {
  let changed = false;
  const next: JourneyPage = { ...page };
  // A Check answers step's row wording is keyed by the form field it words.
  const labels = page.review?.labels;
  if (page.review !== undefined && labels !== undefined && labels !== null && typeof labels === "object") {
    const renamed = renameReviewLabels(labels, from, to);
    if (renamed !== labels) {
      next.review = { ...page.review, labels: renamed };
      changed = true;
    }
  }
  if (page.components !== undefined) {
    let entriesChanged = false;
    const components = page.components.map((entry) => {
      const renamed = renameEntry(entry, from, to);
      entriesChanged ||= renamed !== entry;
      return renamed;
    });
    if (entriesChanged) {
      next.components = components;
      changed = true;
    }
  }
  if (page.routes !== undefined) {
    let routesChanged = false;
    const routes = page.routes.map((route) => {
      if (route.when === undefined) {
        return route;
      }
      const when = renameConditionPaths(route.when, from, to);
      if (when === route.when) {
        return route;
      }
      routesChanged = true;
      return { ...route, when };
    });
    if (routesChanged) {
      next.routes = routes;
      changed = true;
    }
  }
  return changed ? next : page;
}

/**
 * One journey with the component `from` renamed to `to` in its pages' components — ids, and the
 * nodes the presentation owns — and conditions.
 */
export function renameJourneyReferences(journey: Journey, from: string, to: string): Journey {
  if (from === "" || from === to) {
    return journey;
  }
  let changed = false;
  const pages = journey.pages.map((page) => {
    const renamed = renamePage(page, from, to);
    changed ||= renamed !== page;
    return renamed;
  });
  return changed ? { ...journey, pages } : journey;
}

/**
 * The block with the component `from` renamed to `to` in every usable journey it declares,
 * listed or not (a later journey sharing an id is still a journey someone wrote); unreadable
 * journeys and every other key are kept as they are.
 */
export function renameReferencesInConfiguration(
  configuration: JourneyConfiguration | undefined,
  from: string,
  to: string
): JourneyConfiguration | undefined {
  const declared = configuration?.journeys as unknown;
  if (!Array.isArray(declared) || from === "" || from === to) {
    return configuration;
  }
  let changed = false;
  const journeys = declared.map((entry: unknown) => {
    if (validateJourneyShape(entry).length > 0) {
      return entry;
    }
    const renamed = renameJourneyReferences(entry as Journey, from, to);
    changed ||= renamed !== entry;
    return renamed;
  });
  return changed ? ({ ...configuration, journeys } as JourneyConfiguration) : configuration;
}
