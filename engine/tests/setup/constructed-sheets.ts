/*
 * A document or shadow root that takes no constructed sheets: `adoptedStyleSheets` is absent, as in
 * a browser without constructable stylesheets. The renderer then places its rules as `<style>`
 * elements, and the tests that read those elements' text name the case by calling this in a
 * `beforeEach`. jsdom itself has the property, so without this call the rules would sit in
 * sheets whose text is re-serialised and no `<style>` would exist.
 *
 * Only the global window's prototypes are changed; an iframe's document has its own.
 */
export function hideConstructedSheets(): () => void {
  const owners = [Document.prototype, ShadowRoot.prototype];
  const saved = owners.map((owner) => [owner, Object.getOwnPropertyDescriptor(owner, "adoptedStyleSheets")] as const);
  for (const [owner] of saved) delete (owner as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
  return () => {
    for (const [owner, descriptor] of saved) {
      if (descriptor !== undefined) Object.defineProperty(owner, "adoptedStyleSheets", descriptor);
    }
  };
}
