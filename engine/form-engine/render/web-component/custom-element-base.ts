/**
 * DOM-optional base for the engine's custom elements.
 *
 * `class X extends HTMLElement` is evaluated when its module is *imported*, not when the
 * element is used — so a bare `extends HTMLElement` makes the whole `@argusvane/datum-engine/render`
 * barrel (and therefore the root barrel) throw `ReferenceError: HTMLElement is not defined`
 * in any non-DOM environment. The engine is explicitly isomorphic (`runtime/server`,
 * `validation/server`, `data/server`, and plugins declaring `environments: ["browser",
 * "server"]`), so importing the barrel under Node must stay safe.
 *
 * Extending this instead keeps the class declarations evaluable everywhere. In a non-DOM
 * environment the resulting classes are inert placeholders — nothing can construct or
 * register them, which is exactly right, since custom elements are meaningless without a
 * document.
 */
const NoopElementBase = class {} as unknown as typeof HTMLElement;

export const HTMLElementBase: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? NoopElementBase : HTMLElement;

/** Whether this environment has a custom-element registry to define elements against. */
export function canDefineCustomElements(): boolean {
  return typeof customElements !== "undefined";
}

/**
 * Properties a page assigned before an element was upgraded (a script that set `el.runtime`
 * before the module defining the element ran) sit on the instance as own data properties and
 * shadow the prototype's accessors. Each is taken off and assigned again through its setter, in
 * prototype order, so they behave as if set after the upgrade. Setters on superclass prototypes
 * are covered too. Called from `connectedCallback`.
 */
export function adoptPreUpgradeProperties(element: HTMLElement): void {
  const target = element as unknown as Record<string, unknown>;
  const seen = new Set<string>();
  for (let proto = Object.getPrototypeOf(element) as object | null; proto && proto !== HTMLElementBase.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const accessor = Object.getOwnPropertyDescriptor(proto, name);
      if (!accessor?.set || !Object.prototype.hasOwnProperty.call(element, name)) {
        continue;
      }
      const value = target[name];
      delete target[name];
      target[name] = value;
    }
  }
}
