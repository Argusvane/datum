// What the two axe audits share: the states the fixture form is audited in, the
// axe options, how a finding is attributed to a component of the fixture, and the shape a
// result is stored in. Plain ESM so the browser page (`audit.html`), the jsdom test and the
// report script load the same file — nothing here touches a DOM until it is handed a node.

/** WCAG 2.2 level A + AA, as axe tags them. Best-practice rules are not the standard. */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * The states the fixture is audited in: an interactive form after an invalid submit (summary,
 * inline errors, `aria-invalid`, described-by, the focus target), the readonly review, and
 * the French rendering (theme `texts`, `lang` attributes, the language switcher's links).
 */
export const AUDIT_STATES = [
  { id: "interactive", mode: "interactive", locale: "en", invalid: true, label: "Interactive, after an invalid submit" },
  { id: "readonly", mode: "readonly", locale: "en", invalid: false, label: "Readonly review" },
  { id: "fr-CA", mode: "interactive", locale: "fr-CA", invalid: true, label: "French (fr-CA), after an invalid submit" }
];

/** axe options: the WCAG rules alone; colour contrast only where a browser lays out and paints. */
export function axeRunOptions({ colour }) {
  return {
    runOnly: { type: "tag", values: WCAG_TAGS },
    rules: colour ? {} : { "color-contrast": { enabled: false } },
    resultTypes: ["violations", "incomplete", "passes"],
    // `node.element` on every result node, which `attributeNode` walks to a component.
    elementRef: true
  };
}

/** `wcag143` → `1.4.3`; other tags (`cat.color`, `best-practice`) are dropped. */
export function criteriaFromTags(tags) {
  const criteria = [];
  for (const tag of tags ?? []) {
    const match = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (match) criteria.push(`${match[1]}.${match[2]}.${match[3]}`);
  }
  return criteria.sort();
}

/**
 * The parts of the fixture a finding is filed under — the columns of the tracking document.
 * A component id maps to one; markup outside any component (the summary, a notice, the
 * chrome) maps by class.
 */
export const FIXTURE_PARTS = [
  { id: "text", label: "Text field", components: ["fullName", "hiddenLabel", "disabledField", "readOnlyField", "street", "city", "email", "phone", "employer", "nickname", "jobTitle"] },
  { id: "number", label: "Number + affixes", components: ["amount"] },
  { id: "textarea", label: "Textarea + count", components: ["bio", "notes"] },
  { id: "select", label: "Select", components: ["province"] },
  { id: "date", label: "Date", components: ["birthDate"] },
  { id: "file", label: "File upload", components: ["attachment"] },
  { id: "radio", label: "Radio group", components: ["contactMethod"] },
  { id: "checkboxes", label: "Checkbox group", components: ["interests"] },
  { id: "checkbox", label: "Checkbox", components: ["agree", "resident", "consent"] },
  { id: "html", label: "HTML content", components: ["intro"] },
  { id: "image", label: "Image", components: ["logo"] },
  { id: "buttons", label: "Buttons", components: ["submit", "buttonSecondary", "buttonSuccess", "buttonDanger", "buttonWarning", "buttonInfo", "buttonLight", "buttonDark", "buttonLink", "buttonSmall", "buttonGroup"] },
  { id: "fieldset", label: "Fieldset", components: ["group"] },
  { id: "grid", label: "Grid", components: ["grid"] },
  { id: "panel", label: "Panel", components: ["panel"] },
  { id: "tabs", label: "Tabs", components: ["tabs"] },
  { id: "steps", label: "Steps", components: ["steps", "step_1", "step_2"] },
  { id: "container", label: "Container", components: ["container"] },
  { id: "summary", label: "Error summary", components: [] },
  { id: "notice", label: "Notice / status", components: [] },
  { id: "chrome", label: "Chrome + language switcher", components: [] },
  { id: "form", label: "Form root", components: [] }
];

const PART_BY_COMPONENT = new Map();
for (const part of FIXTURE_PARTS) {
  for (const component of part.components) PART_BY_COMPONENT.set(component, part.id);
}

const PART_BY_CLASS = [
  ["datum-form__summary", "summary"],
  ["datum-form__notice", "notice"],
  ["datum-form__status", "notice"],
  ["datum-form__header", "chrome"],
  ["datum-form__footer", "chrome"],
  ["datum-form__language", "chrome"],
  ["datum-form__chrome", "chrome"],
  ["datum-form__steps", "steps"],
  ["datum-form__step", "steps"],
  ["datum-form__tabs", "tabs"],
  ["datum-form__tab", "tabs"],
  ["datum-form__panel", "panel"],
  ["datum-form__file", "file"]
];

/** Whether a class is `name` itself or a `name-` modifier or part of it (never `name__other`). */
function classMatches(classes, name) {
  return classes.split(/\s+/).some((entry) => entry === name || entry.startsWith(`${name}-`));
}

function ancestors(node) {
  const chain = [];
  let element = node;
  while (element) {
    if (element.nodeType === 1) chain.push(element);
    element = element.parentNode ?? element.host ?? null;
  }
  return chain;
}

/**
 * Which component and part a DOM node belongs to. First pass, outward: the nearest
 * `data-component-id` / `data-container-id`, or an id the engine derived from a component's
 * (`bio__count`, `contactMethod__1`), a field label's `for`, a count's `data-count-for`.
 * Second pass, for markup outside any component (the summary, a notice, the chrome, a step
 * indicator's own controls): the nearest part-bearing class. Walks out of shadow roots.
 */
export function attributeNode(node) {
  const chain = ancestors(node);
  for (const element of chain) {
    const componentId = element.getAttribute("data-component-id") ?? element.getAttribute("data-container-id");
    if (componentId) return { componentId, part: PART_BY_COMPONENT.get(componentId) ?? "form" };
    for (const derived of [element.getAttribute("id"), element.getAttribute("for"), element.getAttribute("data-count-for")]) {
      const base = derived ? derived.split("__")[0] : undefined;
      if (base && PART_BY_COMPONENT.has(base)) return { componentId: base, part: PART_BY_COMPONENT.get(base) };
    }
  }
  for (const element of chain) {
    const classes = element.getAttribute("class") ?? "";
    for (const [className, part] of PART_BY_CLASS) {
      if (classMatches(classes, className)) return { componentId: undefined, part };
    }
  }
  return { componentId: undefined, part: "form" };
}

function sortBy(keys) {
  return (a, b) => {
    for (const key of keys) {
      const left = String(a[key] ?? "");
      const right = String(b[key] ?? "");
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  };
}

/**
 * An axe result reduced to what the baseline keeps: one entry per (rule, node), attributed
 * to a component and part, with the rule's criteria, impact, axe's summary of what failed
 * and — for colour contrast — the measured pair. Sorted and free of anything that changes
 * run to run (no timestamps, no html snippets, no engine-internal ids). `resolve` maps a
 * result node to its DOM element (`node.element` in the same window).
 */
export function normaliseAxeResults(results, resolve) {
  const entries = (list) =>
    list.flatMap((rule) =>
      rule.nodes.map((node) => {
        const element = resolve(node);
        const where = element ? attributeNode(element) : { componentId: undefined, part: "form" };
        const check = [...(node.any ?? []), ...(node.all ?? []), ...(node.none ?? [])].find((entry) => entry.data && typeof entry.data === "object");
        const data = check?.data ?? {};
        const entry = {
          ruleId: rule.id,
          impact: node.impact ?? rule.impact ?? "unknown",
          criteria: criteriaFromTags(rule.tags),
          part: where.part,
          componentId: where.componentId,
          target: Array.isArray(node.target) ? node.target.map(String).join(" ") : String(node.target),
          summary: (node.failureSummary ?? rule.help ?? "").replace(/\s+/g, " ").trim()
        };
        if (rule.id === "color-contrast" && data.fgColor) {
          entry.contrast = {
            foreground: data.fgColor,
            background: data.bgColor,
            ratio: typeof data.contrastRatio === "number" ? Math.round(data.contrastRatio * 100) / 100 : data.contrastRatio,
            expected: data.expectedContrastRatio,
            fontSize: data.fontSize,
            fontWeight: data.fontWeight
          };
        }
        return entry;
      })
    );
  return {
    violations: entries(results.violations ?? []).sort(sortBy(["ruleId", "part", "componentId", "target"])),
    incomplete: entries(results.incomplete ?? []).sort(sortBy(["ruleId", "part", "componentId", "target"])),
    passes: [...new Set((results.passes ?? []).map((rule) => rule.id))].sort()
  };
}
