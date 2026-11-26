import type { ComponentDefinition } from "../core/schema/contracts.js";
import { extendBinding, type Adapter, type AdapterEntry, type AdapterKind, type LiveBinding } from "../render/live/contract.js";
import type { Lit } from "../render/live/lit.js";
import { offeredKinds } from "../registry/kinds.js";

/**
 * How the component types a host or a plugin defines are drawn: each
 * `ComponentDefinition.adapter` is the live renderer's adapter for its type, laid over whatever
 * binding draws the form (`extendBinding`), so the type draws under every binding, and its
 * `css` is adopted after the binding's own rules. The form element reads the definitions from its
 * runtime's component registry; the builder's canvas from the controller's.
 *
 * An adapter is an `AdapterEntry`, or a factory of one, `(lit, datum) => AdapterEntry`
 * ({@link ComponentAdapterFactory}): what a plugin package built apart from the engine writes, so
 * it draws with the renderer's one lit copy and never imports lit by specifier, as a
 * binding's `createBinding(lit, datum)` does. The host that draws calls it once per definition.
 *
 * Types and pure functions over them, plus a cache keyed by object identity: nothing here draws.
 */

/**
 * A definition's adapter as a factory: given the renderer's lit namespace and the Datum binding
 * (to wrap one of its adapters), the entry that draws the type.
 */
export type ComponentAdapterFactory = (lit: Lit, datum: LiveBinding) => AdapterEntry;

/** What a factory is called with: what the drawing host has. */
export interface ComponentAdapterContext {
  lit: Lit;
  datum: LiveBinding;
}

/** The adapters, stylesheets and bases a set of component definitions brings. */
export interface ComponentDrawing {
  /** Adapter entries by component type. */
  readonly adapters: Readonly<Record<string, AdapterEntry>>;
  /** The definitions' own stylesheets, in definition order. */
  readonly css: readonly string[];
  /**
   * The engine type each definition's own type reads as (`ComponentDefinition.base`, a usable
   * base only): laid over the binding's `kinds`, so the form draws the type as its base, and
   * reports it while the definition's `kinds` map lacks its entry.
   */
  readonly kinds: Readonly<Record<string, string>>;
}

const ADAPTER_KINDS: ReadonlySet<string> = new Set<AdapterKind>(["field", "group", "tabs", "grid", "steps"]);

/** Whether `value` is one adapter the renderer can draw with: an object of a known `kind` with a `template` function. */
export function isComponentAdapter(value: unknown): value is Adapter {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const { kind, template } = value as { kind?: unknown; template?: unknown };
  return typeof kind === "string" && ADAPTER_KINDS.has(kind) && typeof template === "function";
}

/**
 * What is wrong with a definition's `adapter`, in a line that names it; `undefined` when it is
 * absent, one adapter, a non-empty list of them, or a factory (whose result is checked when it is
 * called).
 */
export function componentAdapterProblem(value: unknown): string | undefined {
  if (value === undefined || typeof value === "function") {
    return undefined;
  }
  const kinds = [...ADAPTER_KINDS].map((kind) => `"${kind}"`).join(", ");
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "adapter must not be an empty list";
    }
    const index = value.findIndex((entry) => !isComponentAdapter(entry));
    return index === -1 ? undefined : `adapter[${index}] must be an adapter: an object with a kind of ${kinds} and a template function`;
  }
  return isComponentAdapter(value) ? undefined : `adapter must be an adapter (an object with a kind of ${kinds} and a template function) or a list of them`;
}

const EMPTY: ComponentDrawing = Object.freeze({ adapters: Object.freeze({}), css: Object.freeze([]) as readonly string[], kinds: Object.freeze({}) });

/**
 * The drawing `definitions` bring: each one's adapter under its type (a later definition of a
 * type replacing an earlier one's) and each stylesheet. A factory is called with `context`, and
 * left out without one. A definition whose `adapter` is not an adapter (or whose factory throws or
 * returns none) is left out, said once on the console, so one bad definition never stops a form.
 */
export function componentDrawingOf(definitions: readonly ComponentDefinition[], context?: ComponentAdapterContext): ComponentDrawing {
  const adapters: Record<string, AdapterEntry> = {};
  const css: string[] = [];
  const bases: Record<string, unknown> = {};
  for (const definition of definitions) {
    if (definition === null || typeof definition !== "object" || typeof definition.type !== "string") {
      continue;
    }
    if (typeof definition.base === "string") {
      Object.defineProperty(bases, definition.type, { value: definition.base, enumerable: true, writable: true, configurable: true });
    }
    let adapter = definition.adapter;
    if (typeof adapter === "function") {
      if (context === undefined) {
        adapter = undefined;
      } else {
        try {
          adapter = (adapter as ComponentAdapterFactory)(context.lit, context.datum);
        } catch (thrown) {
          warnOnce(`[datum] Component "${definition.type}" is not drawn by its definition: its adapter factory threw (${thrown instanceof Error ? thrown.message : String(thrown)})`);
          adapter = undefined;
        }
        if (adapter === undefined || typeof adapter === "function") {
          adapter = adapter === undefined ? undefined : null;
        }
      }
    }
    if (adapter !== undefined) {
      const problem = componentAdapterProblem(adapter);
      if (problem === undefined) {
        // Defined, not assigned: a type named `__proto__` is an entry, not a prototype.
        Object.defineProperty(adapters, definition.type, { value: adapter as AdapterEntry, enumerable: true, writable: true, configurable: true });
      } else {
        warnOnce(`[datum] Component "${definition.type}" is not drawn by its definition: ${problem}`);
      }
    }
    for (const sheet of Array.isArray(definition.css) ? definition.css : []) {
      if (typeof sheet === "string" && sheet.trim() !== "" && !css.includes(sheet)) {
        css.push(sheet);
      }
    }
  }
  const kinds = offeredKinds(bases);
  return Object.keys(adapters).length === 0 && css.length === 0 && Object.keys(kinds).length === 0 ? EMPTY : { adapters, css, kinds };
}

/** Whether a drawing adds nothing. */
export function isEmptyDrawing(drawing: ComponentDrawing | undefined): boolean {
  return drawing === undefined || (Object.keys(drawing.adapters).length === 0 && drawing.css.length === 0 && Object.keys(drawing.kinds ?? {}).length === 0);
}

const laid = new WeakMap<LiveBinding, WeakMap<ComponentDrawing, { withCss: LiveBinding | undefined; adaptersOnly: LiveBinding | undefined }>>();

/**
 * `binding` with `drawing` laid over it: each adapter replacing the binding's own entry for its
 * type, and (unless `css` is `false`) the stylesheets after the binding's own rules. The same
 * object for the same binding and drawing, so a host comparing bindings does not mount again;
 * `binding` itself when the drawing adds nothing.
 */
export function withComponentDrawing(binding: LiveBinding, drawing: ComponentDrawing | undefined, options: { css?: boolean } = {}): LiveBinding {
  if (drawing === undefined || isEmptyDrawing(drawing)) {
    return binding;
  }
  const withCss = options.css !== false && drawing.css.length > 0;
  const ownKinds = drawing.kinds ?? {};
  if (!withCss && Object.keys(drawing.adapters).length === 0 && Object.keys(ownKinds).length === 0) {
    return binding;
  }
  let byDrawing = laid.get(binding);
  if (byDrawing === undefined) {
    byDrawing = new WeakMap();
    laid.set(binding, byDrawing);
  }
  let memo = byDrawing.get(drawing);
  if (memo === undefined) {
    memo = { withCss: undefined, adaptersOnly: undefined };
    byDrawing.set(drawing, memo);
  }
  const cached = withCss ? memo.withCss : memo.adaptersOnly;
  if (cached !== undefined) {
    return cached;
  }
  const css = withCss ? [binding.css, ...drawing.css].filter((sheet): sheet is string => typeof sheet === "string" && sheet !== "").join("\n") : undefined;
  // The definitions' own types read as their bases over whatever the binding says of them.
  const kinds = Object.keys(ownKinds).length > 0 ? offeredKinds(ownKinds, binding.kinds) : undefined;
  const next = extendBinding(binding, { components: drawing.adapters, ...(css !== undefined ? { css } : {}), ...(kinds !== undefined ? { kinds } : {}) });
  if (withCss) {
    memo.withCss = next;
  } else {
    memo.adaptersOnly = next;
  }
  return next;
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (!warned.has(message)) {
    warned.add(message);
    console.warn(message);
  }
}
