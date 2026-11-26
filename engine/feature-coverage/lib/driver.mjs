// The scenario API: what a scenario script is handed (`t`). It drives one Playwright page
// holding the host page (host/entry.ts, `window.fc`) and reads the drawn form the ways a person
// and an assistive technology meet it:
//
//   await t.load("single", { mode, locale, preset, binding })   mount a corpus fixture (shared assertions run)
//   await t.type(target, "text")    real clicks and key presses into a control
//   await t.click(target); await t.key("Enter")
//   await t.drawn()                 wait until every change so far is drawn
//   await t.validate()              the element's validate(): check, draw, focus the errors
//   await t.active()                the deep active element (through shadow roots), described
//   await t.expectFocus({ valuePath: "name" }, "why")
//   await t.ax()                    Chromium's full AX tree (CDP Accessibility.getFullAXTree)
//   await t.liveText(); await t.announcements()   live regions now / what they came to say
//   await t.composedText(selector); await t.composedHtml(); await t.query(selector); await t.facts(selector)
//   t.check(name, ok, detail); t.equal(actual, expected, name)   soft checks: a scenario fails on any
//   await t.shared("label")         the shared assertions (lib/shared.mjs) at this state
//
// A target is a CSS selector (Playwright's CSS pierces open shadow roots) or `{ path }` for the
// first control of the field wrapper whose data-value-path is `path`, `{ path, nth }` for another.
import { sharedAssertions } from "./shared.mjs";

const CONTROL = ":is(input:not([type=hidden]),select,textarea,button)";

export function controlSelector(path) {
  return `[data-value-path="${path}"] ${CONTROL}`;
}

export class Scenario {
  constructor(page, cdp, record) {
    this.page = page;
    this.cdp = cdp;
    this.record = record;
    this.pageErrors = [];
    page.on("pageerror", (error) => this.pageErrors.push(String(error?.message ?? error).slice(0, 500)));
  }

  // ── Checks ────────────────────────────────────────────────────────────────────────────────

  check(name, ok, detail) {
    const entry = { name, ok: !!ok };
    if (!ok && detail !== undefined) entry.detail = detail;
    this.record.checks.push(entry);
    return !!ok;
  }

  equal(actual, expected, name) {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    return this.check(name, same, same ? undefined : { actual, expected });
  }

  /** Stops the scenario here when `ok` is false (a step the rest depends on). */
  require(name, ok, detail) {
    if (!this.check(name, ok, detail)) throw new ScenarioStop(name);
  }

  // ── The page ──────────────────────────────────────────────────────────────────────────────

  /** Calls `window.fc[name](...args)` in the page. */
  fc(name, ...args) {
    return this.page.evaluate(([n, a]) => window.fc[n](...a), [name, args]);
  }

  async load(fixture, options = {}) {
    const loaded = await this.fc("load", { fixture, ...options });
    this.record.fixtures.push({ fixture, source: loaded.source, options });
    await this.shared(`loaded ${fixture}`);
    return loaded;
  }

  locator(target) {
    if (typeof target === "string") return this.page.locator(target).first();
    if (target && typeof target.path === "string") return this.page.locator(controlSelector(target.path)).nth(target.nth ?? 0);
    throw new Error(`Not a target: ${JSON.stringify(target)}`);
  }

  async drawn() {
    return this.fc("updated");
  }

  async type(target, text) {
    await this.locator(target).click();
    await this.page.keyboard.type(text);
    await this.drawn();
  }

  async click(target) {
    await this.locator(target).click();
    await this.drawn();
  }

  async key(key) {
    await this.page.keyboard.press(key);
    await this.drawn();
  }

  validate() {
    return this.fc("validate");
  }

  active() {
    return this.fc("active");
  }

  /** Checks the deep active element has every member of `match` (componentId, valuePath, tag, id, region …). */
  async expectFocus(match, name) {
    const active = await this.active();
    const ok = active !== null && Object.entries(match).every(([key, value]) => active[key] === value);
    return this.check(name, ok, ok ? undefined : { expected: match, active });
  }

  values() {
    return this.fc("values");
  }
  errors() {
    return this.fc("errors");
  }
  liveText() {
    return this.fc("liveText");
  }
  announcements() {
    return this.fc("announcements");
  }
  composedText(selector) {
    return this.fc("composedText", selector);
  }
  composedHtml() {
    return this.fc("composedHtml");
  }
  query(selector) {
    return this.fc("query", selector);
  }
  facts(selector) {
    return this.fc("facts", selector);
  }
  events() {
    return this.fc("events");
  }

  // ── Accessibility tree (Chromium) ────────────────────────────────────────────────────────

  /** The page's full AX tree, flattened: `{ role, name, ignored, properties, backendId }` per node. */
  async ax() {
    const { nodes } = await this.cdp.send("Accessibility.getFullAXTree");
    return nodes.map((node) => ({
      role: String(node.role?.value ?? "").toLowerCase(),
      name: String(node.name?.value ?? ""),
      ignored: node.ignored === true,
      properties: Object.fromEntries((node.properties ?? []).map((p) => [p.name, p.value?.value])),
      backendId: node.backendDOMNodeId
    }));
  }

  /** The DOM element behind an AX node, described by the page (`fc.describe`). */
  async describeBackend(backendId) {
    if (backendId === undefined) return null;
    try {
      const { object } = await this.cdp.send("DOM.resolveNode", { backendNodeId: backendId });
      const { result } = await this.cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function () { const el = this.nodeType === 1 ? this : this.parentElement; return window.fc.describe(el); }",
        returnByValue: true
      });
      await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => undefined);
      return result.value ?? null;
    } catch {
      return null;
    }
  }

  takePageErrors() {
    return this.pageErrors.splice(0);
  }

  async shared(label) {
    const checks = await sharedAssertions(this);
    this.record.shared.push({ label, checks });
    return checks.every((c) => c.ok);
  }
}

export class ScenarioStop extends Error {}
