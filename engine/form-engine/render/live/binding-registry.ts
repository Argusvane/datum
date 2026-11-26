/**
 * The page's bindings by id: what `<datum-form-renderer binding="gcds">` (or `binding = "gcds"`)
 * names. A host registers a design-system binding once (`registerBinding(createBinding(lit,
 * datum))`, the web components' `bindings.register`); an element naming its id draws with it, and
 * one already mounted under that id draws again when it is registered or replaced.
 *
 * `datum` is never stored: it is the Datum binding, which every element has without registering
 * it (and which stands behind every other binding as its fallback). Registering a binding under
 * the id `datum` is refused with a console error, so no registration can take Datum's place.
 *
 * A binding may be registered with its design system's files (`registerBinding(binding, { assets })`):
 * what an element naming the binding by id draws it with when the host gives that element no
 * `assets` of its own, and what the builder's picker draws the canvas with when the author picks
 * it, so a registered binding is never drawn without its stylesheets. The files stay the host's
 * (the binding itself never carries them); one design system's files never style another's form.
 *
 * Held on the global object under a registered symbol, as the journey render kit's default is:
 * the form and builder bundles each carry a copy of this module, and one registration should
 * reach every element on the page. Types only from the contract: nothing here reaches lit.
 */
import type { LiveAssets, LiveBinding } from "./contract.js";

/** The id the Datum binding answers to; never a registered binding's. */
const DATUM_ID = "datum";

const REGISTRY_KEY = Symbol.for("datum.bindings.registry");

interface Registry {
  bindings: Map<string, LiveBinding>;
  /** The design system's files each registered binding draws with, by id; an id registered without any has none. */
  assets: Map<string, LiveAssets>;
  listeners: Set<() => void>;
}

/** What a registration may carry beside the binding. */
export interface BindingRegistration {
  /**
   * The design system's files (stylesheets, fonts, scripts) the binding draws with as the host
   * serves them: used by an element that names the binding by id and has no `assets` of its own,
   * and by the builder's canvas when the binding is picked. Left out, the binding has none
   * registered (a registration replaces what an earlier one under the id said).
   */
  assets?: LiveAssets | undefined;
}

type RegistryHolder = { [REGISTRY_KEY]?: Registry };

function registry(): Registry {
  const holder = globalThis as RegistryHolder;
  return (holder[REGISTRY_KEY] ??= { bindings: new Map(), assets: new Map(), listeners: new Set() });
}

function isBinding(value: unknown): value is LiveBinding {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<LiveBinding>;
  return typeof candidate.id === "string" && candidate.id.trim() !== "" && candidate.components !== null && typeof candidate.components === "object";
}

/**
 * Registers a binding (or several), each under its `id`; a binding registered under an id already
 * held replaces it, its files with it (`registration.assets`, given to each binding of the call).
 * Something that is not a binding (no id, no components) and a binding under the id `datum` are
 * refused with a console error. Every listener hears one change per call.
 */
export function registerBinding(input: LiveBinding | readonly LiveBinding[], registration: BindingRegistration = {}): void {
  const list: readonly unknown[] = Array.isArray(input) ? input : [input];
  const { bindings, assets, listeners } = registry();
  const files = registration !== null && typeof registration === "object" && registration.assets !== null && typeof registration.assets === "object" ? registration.assets : undefined;
  let changed = false;
  for (const binding of list) {
    if (!isBinding(binding)) {
      console.error("[datum bindings] Not a binding (it needs an id and components); nothing was registered for it.");
      continue;
    }
    if (binding.id === DATUM_ID) {
      console.error(`[datum bindings] "${DATUM_ID}" is the Datum binding, which every form has: a binding under that id is not registered.`);
      continue;
    }
    if (bindings.get(binding.id) !== binding) {
      bindings.set(binding.id, binding);
      changed = true;
    }
    if (assets.get(binding.id) !== files) {
      if (files === undefined) {
        assets.delete(binding.id);
      } else {
        assets.set(binding.id, files);
      }
      changed = true;
    }
  }
  if (changed) {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (thrown) {
        console.error("[datum bindings] A listener failed", thrown);
      }
    }
  }
}

/** The binding registered under `id`; `undefined` for `datum` (the Datum binding is never stored) and for an id nothing registered. */
export function bindingById(id: string): LiveBinding | undefined {
  return id === DATUM_ID ? undefined : registry().bindings.get(id);
}

/** The design system's files the binding under `id` was registered with; `undefined` for none, for `datum` and for an id nothing registered. */
export function bindingAssetsById(id: string): LiveAssets | undefined {
  return id === DATUM_ID ? undefined : registry().assets.get(id);
}

/** Every registered binding, in the order first registered. */
export function registeredBindings(): readonly LiveBinding[] {
  return [...registry().bindings.values()];
}

/** Hears every registration that changed what an id names; returns what stops it. */
export function onBindingsChanged(listener: () => void): () => void {
  const { listeners } = registry();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
