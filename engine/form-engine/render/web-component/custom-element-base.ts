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
