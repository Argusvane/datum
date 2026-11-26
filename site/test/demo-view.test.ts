import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { examples } from "../src/demo-forms";
import { VIEW_WORDS, applyAgentAttributes, demoBundleUrls, followSiteScheme, loadDemoBundles, viewOptions, viewPicker, type JourneyOptionLike, type ViewForm } from "../src/render-demo";
import { readJourneys } from "../../engine/form-engine/core/schema/journey";

// The live demo's View picker, over stand-ins for the two elements: the site runs its tests
// without a DOM, so the few nodes the picker makes are faked here (an element is an
// EventTarget with attributes and children; a select's value is its selected option's, as in a
// browser). The elements themselves are the bundles' and are checked in a browser.

class FakeElement extends EventTarget {
  className = "";
  textContent: string | null = "";
  hidden = false;
  children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {
    super();
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = [...nodes];
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeOption extends FakeElement {
  value = "";
}

/** A single select: the first option is selected once there is one; a value no option has selects none. */
class FakeSelect extends FakeElement {
  private selected = -1;

  get options(): FakeOption[] {
    return this.children as FakeOption[];
  }

  get value(): string {
    return this.options[this.selected]?.value ?? "";
  }

  set value(value: string) {
    this.selected = this.options.findIndex((option) => option.value === value);
  }

  override append(...nodes: FakeElement[]): void {
    super.append(...nodes);
    if (this.selected < 0 && this.children.length > 0) this.selected = 0;
  }

  override replaceChildren(...nodes: FakeElement[]): void {
    super.replaceChildren(...nodes);
    this.selected = nodes.length > 0 ? 0 : -1;
  }
}

/** `<datum-form>` as the picker sees it: the `journey` attribute, `journeys()` and `datum-ready`. */
class FakeForm extends FakeElement {
  declared: JourneyOptionLike[] = [];

  constructor() {
    super("datum-form");
  }

  journeys(): JourneyOptionLike[] {
    return this.declared.map((journey) => ({ ...journey }));
  }

  /** A new definition taken up: what it declares now, then `datum-ready`, as the element does. */
  ready(declared: JourneyOptionLike[] = this.declared): void {
    this.declared = declared;
    this.dispatchEvent(new Event("datum-ready"));
  }
}

const fakeDocument = {
  createElement(tag: string): FakeElement {
    if (tag === "select") return new FakeSelect(tag);
    if (tag === "option") return new FakeOption(tag);
    return new FakeElement(tag);
  }
};

const journey = (id: string, label: string): JourneyOptionLike => ({ id, label });
const ELIGIBILITY = journey("eligibility", "Check and apply");
const QUICK = journey("quick", "Quick apply");

/** A definition the builder emits, declaring these journeys (the picker reads their ids). */
const definitionWith = (...ids: string[]): unknown => ({ id: "energy-rebate", journey: { journeys: ids.map((id) => ({ id, pages: [] })) } });

function mountPicker() {
  const form = new FakeForm();
  const builder = new FakeElement("datum-form-builder");
  const picker = viewPicker(form as unknown as ViewForm, builder as unknown as HTMLElement);
  const select = picker.select as unknown as FakeSelect;
  const control = picker.control as unknown as FakeElement;
  const entries = (): Array<[string, string | null]> => select.options.map((option) => [option.value, option.textContent]);
  const choose = (value: string): void => {
    select.value = value;
    select.dispatchEvent(new Event("change"));
  };
  const builderEmits = (definition: unknown): void => {
    builder.dispatchEvent(new CustomEvent("datum-builder-change", { detail: { definition } }));
  };
  return { form, builder, picker, select, control, entries, choose, builderEmits };
}

beforeEach(() => {
  vi.stubGlobal("document", fakeDocument);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the demo's View picker", () => {
  it("lists the form's own choice, the whole form, then each journey by name, in the order declared", () => {
    expect(viewOptions([])).toEqual([]);
    expect(viewOptions([QUICK, ELIGIBILITY, journey("renew", "Renew")])).toEqual([
      { value: "", label: "As the form opens" },
      { value: "form", label: "Whole form" },
      { value: "quick", label: "Quick apply" },
      { value: "eligibility", label: "Check and apply" },
      { value: "renew", label: "Renew" }
    ]);
    // An id offered once: a second journey under it cannot be opened, and the keywords are the picker's own.
    expect(viewOptions([ELIGIBILITY, journey("eligibility", "Again"), journey("form", "Form"), journey("journey", "Journey")]).map((entry) => entry.value)).toEqual([
      "",
      "form",
      "eligibility"
    ]);
  });

  it("offers example 6's two journeys, as <datum-form> lists them", () => {
    const rebate = examples.find((entry) => entry.id === "rebate")?.definition as { journey?: unknown };
    // What journeys() returns for it: the id and the name in the form's language.
    const listed = readJourneys(rebate).map((presentation) => ({
      id: presentation.id,
      label: presentation.name as string
    }));
    expect(viewOptions(listed)).toEqual([
      { value: "", label: "As the form opens" },
      { value: "form", label: "Whole form" },
      { value: "eligibility", label: "Check and apply" },
      { value: "quick", label: "Quick apply" }
    ]);
    // Every other example has neither, so no picker.
    for (const entry of examples.filter((other) => other.id !== "rebate")) {
      expect(readJourneys(entry.definition as { journey?: unknown }), entry.id).toEqual([]);
    }
  });

  it("is a labelled native select in the bar's control shape, shown only while the form has journeys", () => {
    const { form, control, select, entries } = mountPicker();
    expect(control.tagName).toBe("label");
    expect(control.className).toBe("demo__control");
    expect(control.children[0]?.textContent).toBe(VIEW_WORDS.label);
    expect(control.children[1]).toBe(select);
    expect(select.className).toBe("demo__select");
    expect(select.getAttribute("aria-label")).toBe("View");
    // Hidden until the form says what it declares, and while it declares nothing.
    expect(control.hidden).toBe(true);
    form.ready([]);
    expect(control.hidden).toBe(true);
    expect(entries()).toEqual([]);

    form.ready([ELIGIBILITY, QUICK]);
    expect(control.hidden).toBe(false);
    expect(entries()).toEqual([
      ["", "As the form opens"],
      ["form", "Whole form"],
      ["eligibility", "Check and apply"],
      ["quick", "Quick apply"]
    ]);
    expect(select.value).toBe("");
    expect(form.getAttribute("journey")).toBeNull();
  });

  it("sets the form's journey attribute to the pick, and removes it for the form's own choice", () => {
    const { form, select, choose } = mountPicker();
    form.ready([ELIGIBILITY, QUICK]);
    choose("quick");
    expect(form.getAttribute("journey")).toBe("quick");
    choose("form");
    expect(form.getAttribute("journey")).toBe("form");
    choose("eligibility");
    expect(form.getAttribute("journey")).toBe("eligibility");
    choose("");
    expect(form.getAttribute("journey")).toBeNull();
    expect(select.value).toBe("");
  });

  it("follows the builder: a journey added, renamed or removed, and a pick that goes falls back to the form's own choice", () => {
    const { form, select, control, entries, choose, builderEmits } = mountPicker();
    form.ready([ELIGIBILITY]);
    choose("eligibility");

    // Added: the one-page journey joins the list; the pick stays.
    builderEmits(definitionWith("eligibility", "quick"));
    expect(form.getAttribute("journey")).toBe("eligibility");
    form.ready([ELIGIBILITY, QUICK]);
    expect(entries().map(([value]) => value)).toEqual(["", "form", "eligibility", "quick"]);
    expect(select.value).toBe("eligibility");

    // Renamed: the new name, the same pick. An edit that changes nothing listed leaves the options be.
    const before = select.options[2];
    form.ready([ELIGIBILITY, QUICK]);
    expect(select.options[2]).toBe(before);
    builderEmits(definitionWith("eligibility", "quick"));
    form.ready([journey("eligibility", "Check first, then apply"), QUICK]);
    expect(entries()[2]).toEqual(["eligibility", "Check first, then apply"]);
    expect(select.value).toBe("eligibility");
    expect(form.getAttribute("journey")).toBe("eligibility");

    // Removed: the pick is dropped as the builder's change arrives, before the form takes up
    // the definition, and the list no longer offers it.
    builderEmits(definitionWith("quick"));
    expect(form.getAttribute("journey")).toBeNull();
    form.ready([QUICK]);
    expect(entries().map(([value]) => value)).toEqual(["", "form", "quick"]);
    expect(select.value).toBe("");

    // A pick the form stops listing by itself (a journey it cannot read) falls back too.
    choose("quick");
    form.ready([]);
    expect(form.getAttribute("journey")).toBeNull();
    expect(control.hidden).toBe(true);
    // And the whole form is the form's whatever the builder does to its journeys.
    form.ready([QUICK]);
    choose("form");
    builderEmits(definitionWith());
    expect(form.getAttribute("journey")).toBe("form");
  });

  it("goes back to the form's own choice on reset (a new example, or Reset)", () => {
    const { form, picker, select, choose } = mountPicker();
    form.ready([ELIGIBILITY, QUICK]);
    choose("quick");
    picker.reset();
    expect(form.getAttribute("journey")).toBeNull();
    expect(select.value).toBe("");
  });
});

describe("the Try-it bar above the builder", () => {
  // The site's tests lay nothing out (the rows were measured in Chrome: two at 1400px with View
  // shown, Reset at the far end; the phone's stack unchanged). What keeps them so is checked
  // here: Reset is last among the bar's wrapping controls.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/render-demo.ts", import.meta.url), "utf8");
  const phoneAt = css.indexOf("@media (max-width: 640px)", css.indexOf(".demo__bar-end"));
  /** The declarations of the first rule for exactly `selector` in `sheet`, by property. */
  const rule = (sheet: string, selector: string): Record<string, string> => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
    const body = new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(sheet)?.[1];
    expect(body, selector).toBeDefined();
    return Object.fromEntries(
      body!
        .split(";")
        .map((declaration) => declaration.split(":").map((part) => part.trim()))
        .filter(([property]) => property)
        .map(([property, ...value]) => [property, value.join(":")])
    );
  };

  it("keeps Reset last among the controls, so Reset never takes a row of its own", () => {
    expect(source).toMatch(/const end = el\("div", "demo__bar-end"\);\s*end\.append\(reset\);/);
    expect(source).toMatch(/topControls\.append\(example\.control, view\.control, end\);\s*topBar\.append\(topControls\);/);

    const wide = css.slice(0, phoneAt);
    expect(rule(wide, ".demo__bar > .demo__actions")).toMatchObject({ flex: "1 1 auto" });
    const pair = rule(wide, ".demo__bar-end");
    expect(pair).toMatchObject({ flex: "1 0 auto", display: "flex", "justify-content": "flex-end" });
    expect(pair["flex-wrap"]).toBeUndefined();

    // On a phone the row spans the bar and wraps.
    const phone = css.slice(phoneAt, css.indexOf("}\n}", phoneAt) + 3);
    expect(rule(phone, ".demo__bar-end")).toMatchObject({ flex: "1 1 100%", "flex-wrap": "wrap", "row-gap": "12px" });
    expect(rule(phone, ".demo__control")).toMatchObject({ flex: "1 1 100%" });
  });
});

describe("the live forms and builders on the dark site", () => {
  // A form whose binding paints no surface of its own draws its dark ink on whatever page it sits
  // on, and the builder's language select is a light box whose text a dark colour scheme turns
  // white: on the dark site both measured about 1.1:1 in Chrome (the demo's renderer drawn light, the demo's builder). The site keeps their pages
  // light; what does so is checked here, since the site's tests lay nothing out.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/render-demo.ts", import.meta.url), "utf8");
  /** The rule whose declarations contain `marker`: its selectors and its declarations. */
  const ruleWith = (marker: string): { selectors: string[]; body: string } => {
    const at = css.indexOf(marker);
    expect(at, marker).toBeGreaterThan(-1);
    const open = css.lastIndexOf("{", at);
    const before = Math.max(css.lastIndexOf("}", open), css.lastIndexOf("*/", open) + 1);
    const selectors = css
      .slice(before + 1, open)
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean);
    return { selectors, body: css.slice(open + 1, css.indexOf("}", at)) };
  };
  const SHEETS = ['.demo__sheet[data-scheme="light"]'];

  it("gives the light palette to every page a light-drawn form sits on, in either site theme", () => {
    const light = ruleWith("--bg: #fafaf9;");
    expect(light.selectors).toEqual([":root", ...SHEETS]);
    expect(light.body).toMatch(/color-scheme: light;/);
    // The dark palette is the page's alone; the sheets above set their own.
    expect(ruleWith("--bg: #0e0e0e;").selectors).toEqual([':root[data-theme="dark"]']);
  });

  it("paints the demo's renderer section from the site's scheme, and keeps the builder's controls light", () => {
    expect(source).toMatch(/form\.colorScheme = site;\s*sheet\.dataset\.scheme = site;/);
    const sheet = ruleWith("padding: 24px; border-top: var(--border) solid var(--line-strong);");
    expect(sheet.selectors).toEqual([".demo__sheet"]);
    expect(sheet.body).toMatch(/background: var\(--raised\);/);
    expect(sheet.body).toMatch(/color: var\(--fg\);/);
    const builder = ruleWith("height: 640px; min-height: 460px;");
    expect(builder.selectors).toEqual([".demo__builder"]);
    expect(builder.body).toMatch(/color-scheme: light;/);
  });
});

describe("the demo's builder follows the site's light and dark mode, one way", () => {
  it("hands the builder the site's theme as its scheme, at once and each time the site's changes", () => {
    const builder = new FakeElement("datum-form-builder");
    let theme: "light" | "dark" = "dark";
    const apply = followSiteScheme(builder as unknown as HTMLElement, () => theme);
    expect(builder.getAttribute("scheme")).toBe("dark");
    theme = "light";
    apply();
    expect(builder.getAttribute("scheme")).toBe("light");
  });

  it("brings a builder switched from its own menu back in step on the site's next change", () => {
    const builder = new FakeElement("datum-form-builder");
    let theme: "light" | "dark" = "light";
    const apply = followSiteScheme(builder as unknown as HTMLElement, () => theme);
    // The builder's own Dark mode item: the element reflects it on its attribute.
    builder.setAttribute("scheme", "dark");
    theme = "dark";
    apply();
    expect(builder.getAttribute("scheme")).toBe("dark");
    theme = "light";
    apply();
    expect(builder.getAttribute("scheme")).toBe("light");
  });

  it("never lets the builder choose the site's theme", () => {
    const source = readFileSync(new URL("../src/render-demo.ts", import.meta.url), "utf8");
    // Wired before the builder connects, and again on every change of the site's theme.
    expect(source).toMatch(/const applyScheme = followSiteScheme\(builder, siteTheme\);[\s\S]*?builderBox\.append\(builder\);/);
    expect(source).toMatch(/new MutationObserver\(\(\) => \{\s*applyScheme\(\);\s*applyTheme\(\);\s*\}\)\.observe\(document\.documentElement, \{ attributes: true, attributeFilter: \["data-theme"\] \}\);/);
    // The builder's scheme event is not listened for, and the demo imports no way to set the site's theme.
    expect(source).not.toMatch(/addEventListener\("datum-builder-scheme-change"/);
    expect(source).not.toMatch(/chooseSiteTheme|applySiteTheme|localStorage/);
    // The header's toggle alone chooses, through the module that stores the choice.
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/chooseSiteTheme\(siteTheme\(\) === "dark" \? "light" : "dark"\)/);
  });
});

describe("the demo's browser assistants", () => {
  it("loads the renderer bundle before the builder bundle only where the browser has WebMCP", () => {
    const withWebMcp = demoBundleUrls(true);
    expect(withWebMcp).toHaveLength(2);
    expect(withWebMcp[0]!.endsWith("demo/datum-form.js")).toBe(true);
    expect(withWebMcp[1]!.endsWith("demo/datum-builder.js")).toBe(true);
    const without = demoBundleUrls(false);
    expect(without).toHaveLength(1);
    expect(without[0]!.endsWith("demo/datum-builder.js")).toBe(true);
    expect(without.some((url) => url.endsWith("datum-form.js"))).toBe(false);
  });

  it("allows the tools on the demo form once the renderer bundle is there, and touches nothing before", () => {
    const form = new FakeElement("datum-form");
    applyAgentAttributes(form as unknown as HTMLElement, true);
    expect(form.getAttribute("features")).toBe("all agent");
    expect(form.getAttribute("agent-access")).toBe("always");
    const bare = new FakeElement("datum-form");
    applyAgentAttributes(bare as unknown as HTMLElement, false);
    expect(bare.getAttribute("features")).toBeNull();
    expect(bare.getAttribute("agent-access")).toBeNull();
  });

  it("gives the demo builder no features attribute (the builder takes no part in the form's switch)", () => {
    const source = readFileSync(new URL("../src/render-demo.ts", import.meta.url), "utf8");
    const builderLines = source.split("\n").filter((line) => /\bbuilder\.setAttribute\(/.test(line));
    expect(builderLines.length).toBeGreaterThan(0);
    expect(builderLines.some((line) => /"features"|"agent-access"/.test(line))).toBe(false);
    // The helper is the other way in: it is applied to the form, once, with what the load found,
    // and never to the builder (section 7 row 10: the demo builder gets no token).
    expect(source.match(/applyAgentAttributes\(form, agentBundleLoaded\);/g)).toHaveLength(1);
    expect(source.match(/applyAgentAttributes\(/g)).toHaveLength(2); // the declaration and the one call
    expect(source).not.toMatch(/applyAgentAttributes\(builder/);
  });

  it("feeds the loader the browser's WebMCP detect and keeps what it reports for the form", () => {
    const source = readFileSync(new URL("../src/render-demo.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const hasWebMcp = "modelContext" in document;/);
    expect(source.match(/loadDemoBundles\(hasWebMcp\)/g)).toHaveLength(1);
    expect(source).toMatch(/agentBundleLoaded = await loadDemoBundles\(hasWebMcp\);/);
  });
});

describe("loading the demo's bundles", () => {
  const recorder = (failing: (url: string) => boolean = () => false) => {
    const calls: string[] = [];
    const load = (url: string): Promise<void> => {
      calls.push(url.replace(/^.*\//, ""));
      return failing(url) ? Promise.reject(new Error("no")) : Promise.resolve();
    };
    return { calls, load };
  };

  it("loads the renderer bundle, then the builder's, where WebMCP exists, and reports the renderer loaded", async () => {
    const { calls, load } = recorder();
    await expect(loadDemoBundles(true, load)).resolves.toBe(true);
    expect(calls).toEqual(["datum-form.js", "datum-builder.js"]);
  });

  it("still loads the builder when the renderer bundle fails, and reports it not loaded", async () => {
    const { calls, load } = recorder((url) => url.endsWith("datum-form.js"));
    await expect(loadDemoBundles(true, load)).resolves.toBe(false);
    expect(calls).toEqual(["datum-form.js", "datum-builder.js"]);
  });

  it("loads the builder bundle alone, never the renderer's, where WebMCP is missing", async () => {
    const { calls, load } = recorder();
    await expect(loadDemoBundles(false, load)).resolves.toBe(false);
    expect(calls).toEqual(["datum-builder.js"]);
  });

  it("lets a builder bundle failure reject, so the page keeps its fallback", async () => {
    const { load } = recorder((url) => url.endsWith("datum-builder.js"));
    await expect(loadDemoBundles(true, load)).rejects.toThrow();
    await expect(loadDemoBundles(false, load)).rejects.toThrow();
  });
});
