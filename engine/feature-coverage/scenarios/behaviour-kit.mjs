// Helpers the behaviour scenarios share: the host's controls (host/behaviours.ts, `window.fcx`)
// and a few reads of the drawn form.

/** Calls `window.fcx[name](...args)` in the page. */
export const fcx = (t, name, ...args) => t.page.evaluate(([n, a]) => window.fcx[n](...a), [name, args]);

/** The attributes of the first element matching `selector` (deep), or `{}`. */
export const attributes = async (t, selector) => (await t.facts(selector))?.attributes ?? {};

/** A field wrapper's attributes by value path. */
export const wrapperOf = (t, path) => attributes(t, `[data-value-path="${path}"]`);

/** The form element's attributes. */
export const formOf = (t) => attributes(t, "form");

/** Waits (bounded) until `test()` answers true, drawing between tries. */
export async function until(t, test, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    await t.drawn();
    if (await test()) return true;
    await t.page.waitForTimeout(40);
  }
  return false;
}

/** Whether an attribute map carries `name` (a boolean attribute is present with an empty value). */
export const has = (attrs, name) => name in attrs;

/**
 * Mounts `fixture` and returns once its first draw is ready, without waiting for every change to be
 * drawn: what a form with a data source still out needs (`t.drawn()` waits for the sources). The
 * shared assertions run on the first draw.
 */
export async function mountHeld(t, fixture, options = {}) {
  const { behaviours = {}, ...rest } = options;
  const loaded = await t.fc("load", { fixture, ...rest, behaviours: { ...behaviours, hold: true } });
  t.record.fixtures.push({ fixture, source: loaded.source, options });
  const fields = await fcx(t, "whenReady");
  await t.shared(`loaded ${fixture} (held)`);
  return fields;
}
