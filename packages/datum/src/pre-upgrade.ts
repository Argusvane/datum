/**
 * Properties a page assigned before an element was upgraded (a module script that ran before the
 * bundle finished loading) sit on the instance as own data properties and shadow the prototype
 * accessors. Each is taken off and assigned again through the setter, in prototype order, so
 * `definition`, `features`, `fileActions` and the rest behave as if set after upgrade. Setters
 * on superclass prototypes are covered too.
 */
export function adoptPreUpgradeProperties(element: HTMLElement): void {
  const target = element as unknown as Record<string, unknown>;
  const seen = new Set<string>();
  for (let proto = Object.getPrototypeOf(element) as object | null; proto && proto !== HTMLElement.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
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
