import { AXE_VERSION, GITHUB_BINDINGS, bindingById, datumNumbers, numbersOf, referenceBindings, type BindingHost, type BindingNumbers, type HostScript, type ReferenceBinding, type TestNumbers } from "./bindings";
import { examples } from "./demo-forms";
import { loadModule } from "./load-module";
import { NON_AFFILIATION } from "./non-affiliation";
import { siteTheme } from "./site-theme";

/**
 * The binding pages: `bindings.html` (Datum's own theme beside the nine reference bindings) and one
 * page per binding, each filled from src/bindings.ts and the numbers `kit:check` measured. The pages
 * keep the scope: `datum` is the one official theme; a design-system binding is a
 * reference, a demo and a starting point, and nothing here calls one accessible or supported.
 * Every page also says Datum is not affiliated with or endorsed by a design system's owner, and
 * what the design system's own files fetch from a third party.
 */

const BASE = import.meta.env.BASE_URL;
const DEMO = `${BASE}demo/`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(href: string, text: string, className?: string): HTMLAnchorElement {
  const anchor = el("a", className, text);
  anchor.href = href;
  return anchor;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The page of a binding, relative so the site works under any base. */
export const pageOf = (id: string): string => `./binding-${id}.html`;

// ---------- the numbers ----------

/** What the conformance check measured, as the pages word it. */
export function conformanceLine(numbers: TestNumbers): string {
  const { pass, fail, skip, pending, known = 0 } = numbers.conformance;
  return `${pass} pass, ${fail} fail, ${skip} skipped, ${pending} pending${known > 0 ? `, ${known} known` : ""}`;
}

/** What the behaviour check measured: a known defect of the design system is counted apart, never as a pass or a fail. */
export function behaviourLine(numbers: TestNumbers): string {
  const { pass, fail, known = 0 } = numbers.behaviour;
  return `${pass} pass, ${fail} fail${known > 0 ? `, ${known} known` : ""}`;
}

/** The sentence under the numbers when a binding declares known defects. */
export const KNOWN_NOTE = "Known means the case fails because of a defect in the design system itself. The binding reports it with its reason instead of working around it or hiding it.";

/** One sentence per known defect: the case, its suite and the reason, so a visitor sees the binding reports a design-system defect rather than hides it. */
export function knownLines(numbers: TestNumbers): string[] {
  return (numbers.knownDefects ?? []).map((defect) => `${defect.case} (${defect.suite}): ${defect.reason}`);
}

export function equalityLine(numbers: BindingNumbers): string {
  const { pass, fail, tier1, tier2 } = numbers.equality;
  return `${pass} of ${pass + fail} cases (${tier1} against the design system's own markup, ${tier2} against the binding's own pictures)`;
}

/** The index card's equality: the tier-1 cases only, the ones compared with the design system's own markup. */
export function cardEqualityLine(name: string, numbers: BindingNumbers): string {
  const { tier1, tier1Pass } = numbers.equality;
  return `${tier1Pass} of ${tier1} against ${name} markup`;
}

/** The index card's tier-2 row: pictures compared with the binding's own, which are not equality with the design system. */
export function cardPicturesLine(numbers: BindingNumbers): string {
  const { tier2 } = numbers.equality;
  return tier2 === 0 ? "None" : `${tier2} against the binding's own pictures`;
}

/** The one sentence every binding page and the index carry about the design systems' owners (src/non-affiliation.ts). */
export { NON_AFFILIATION };

/** What a binding's files fetch from third parties, for the index card: the hosts, or "Nothing". */
export function networkCardLine(network: BindingHost[]): string {
  return network.length === 0 ? "Nothing" : network.map((entry) => entry.host).join(", ");
}

/** The same, for the page: each host and why, or the statement that there is nothing. */
export function networkDetail(network: BindingHost[]): Node | string {
  if (network.length === 0) return "Nothing: the design system's files, once served by the host, ask no one else for anything.";
  return list(network.map((entry) => `${entry.host}: ${entry.reason}`), "binding-list binding-list--tight");
}

export function sizeLine(numbers: BindingNumbers): string {
  return `${numbers.gzipKb} KB gzip of a ${numbers.budgetKb} KB budget`;
}

function facts(rows: Array<[string, Node | string]>): HTMLDListElement {
  const list = el("dl", "binding-facts");
  for (const [term, value] of rows) {
    const row = el("div");
    row.append(el("dt", undefined, term));
    const detail = el("dd");
    detail.append(value);
    row.append(detail);
    list.append(row);
  }
  return list;
}

function head(eyebrow: string, title: string, id: string): HTMLElement {
  const wrap = el("div", "section-head");
  const text = el("div", "section-head__text");
  text.append(el("span", "eyebrow", eyebrow));
  const heading = el("h2", "section-title", title);
  heading.id = `${id}-heading`;
  text.append(heading);
  wrap.append(text);
  return wrap;
}

function section(id: string, eyebrow: string, title: string): HTMLElement {
  const node = el("section", "section container");
  node.id = id;
  node.setAttribute("aria-labelledby", `${id}-heading`);
  node.append(head(eyebrow, title, id));
  return node;
}

function list(items: string[], className = "binding-list"): HTMLUListElement {
  const node = el("ul", className);
  for (const item of items) node.append(el("li", undefined, item));
  return node;
}

// ---------- the index ----------

const SCOPE =
  `Datum ships one official theme, its own. The nine bindings below draw a form in a design system's own markup and components: they are references, demos and starting points, with no support promise, and Datum claims nothing about their accessibility. A design system is the authority for its own look, markup and accessibility. ${NON_AFFILIATION} Each card lists what the design system's own files fetch from a third party; Datum and its own theme fetch nothing.`;

function indexCard(name: string, by: string, summary: string, href: string, rows: Array<[string, string]>, official: boolean): HTMLElement {
  const card = el("article", official ? "binding-card binding-card--official" : "binding-card");
  const title = el("h3", "binding-card__title");
  title.append(link(href, name));
  card.append(title, el("p", "binding-card__by", by), el("p", "binding-card__summary", summary));
  card.append(facts(rows));
  return card;
}

function renderIndex(root: HTMLElement): void {
  const official = section("datum", "Official", "Datum's own theme.");
  const grid = el("div", "binding-cards");
  grid.append(
    indexCard(
      "Datum",
      "The built-in theme",
      "Every form draws in it with nothing to load: light and dark, tokens for colour, type, spacing and geometry, header and footer frames.",
      pageOf("datum"),
      [["Conformance", conformanceLine(datumNumbers)], ["Fetches from", "Nothing"]],
      true
    )
  );
  official.append(grid);

  const references = section("bindings", "Reference bindings", "Nine design systems.");
  references.append(el("p", "binding-lede", SCOPE));
  const cards = el("div", "binding-cards");
  for (const binding of referenceBindings) {
    const numbers = numbersOf(binding.id);
    cards.append(
      indexCard(
        binding.name,
        `${binding.by} · ${numbers.release}`,
        binding.summary,
        pageOf(binding.id),
        [
          ["Equality", cardEqualityLine(binding.name, numbers)],
          ["Tier-2 pictures", cardPicturesLine(numbers)],
          ["Size", sizeLine(numbers)],
          ["Fetches from", networkCardLine(binding.network)]
        ],
        false
      )
    );
  }
  references.append(cards);
  root.replaceChildren(official, references);
}

// ---------- one binding ----------

export function snippet(binding: ReferenceBinding): string {
  const files = (names: string[]): string => names.map((name) => `{ url: "/design-system/${name}" }`).join(", ");
  const script = (entry: string | HostScript): string => {
    if (typeof entry === "string") return `{ url: "/design-system/${entry}" }`;
    const attributes = entry.attributes ? `, attributes: { ${Object.entries(entry.attributes).map(([key, value]) => `"${key}": "${value}"`).join(", ")} }` : "";
    return `{ url: "/design-system/${entry.file}", classic: true${attributes} }`;
  };
  const assets = [`stylesheets: [${files(binding.host.stylesheets)}]`, ...(binding.host.scripts.length > 0 ? [`scripts: [${binding.host.scripts.map(script).join(", ")}]`] : [])].join(",\n    ");
  return [
    `import { bindings } from "./datum-form.js";`,
    `// bindings/${binding.id}/dist/${binding.id}.js, built in Datum's repository (npm run build in bindings/${binding.id});`,
    `// the binding is not published as a package.`,
    `import { createBinding } from "./bindings/${binding.id}.js";`,
    ``,
    `// fromFactory calls the binding's factory with the page's lit and Datum's own binding.`,
    `const binding = bindings.fromFactory(createBinding);`,
    `bindings.register(binding, {`,
    `  assets: {`,
    `    ${assets}`,
    `  }`,
    `});`,
    ``,
    `// binding is a property, not an attribute.`,
    `document.querySelector("datum-form").binding = "${binding.id}";`
  ].join("\n");
}

function renderBinding(root: HTMLElement, id: string): void {
  const binding = bindingById(id);
  if (binding === undefined) throw new Error(`no binding page for "${id}"`);
  const numbers = numbersOf(id);

  const intro = el("section", "intro container");
  const crumb = el("span", "eyebrow");
  crumb.append(link("./bindings.html", "Bindings"));
  intro.append(crumb, el("h1", "section-title", binding.name), el("p", "intro__lede", binding.lede));
  intro.append(el("p", "binding-scope", `A reference binding, not an official Datum theme. Datum makes no accessibility claim for it: ${binding.name} is the authority for its own look, markup and accessibility. Datum is not affiliated with or endorsed by the design system's owner, ${binding.by}.`));

  const top = el("section", "container binding-top");
  const siteLink = link(binding.site, binding.site.replace(/^https:\/\//, "").replace(/\/$/, ""));
  top.append(
    facts([
      ["Design system", siteLink],
      ["Design system by", binding.by],
      ["Pinned to", `${binding.pinned} (release ${numbers.release})`],
      ["Binding size", sizeLine(numbers)],
      ["Fetches from", networkDetail(binding.network)],
      ["Equality", equalityLine(numbers)],
      ["Behaviour", behaviourLine(numbers)],
      ["Conformance", conformanceLine(numbers)],
      ["Measured", `${numbers.browser}, ${numbers.measuredOn}`]
    ])
  );

  const knownLinesOf = knownLines(numbers);
  if (knownLinesOf.length > 0) top.append(el("p", "binding-note", KNOWN_NOTE), list(knownLinesOf));

  const draws = section("draws", "What it draws", "The design system's components, where it has them.");
  draws.append(el("h3", "binding-subtitle", "Its own components (tier 1)"), list(binding.official));
  if (binding.tier2.length > 0) draws.append(el("h3", "binding-subtitle", "Datum's component in its markup and tokens (tier 2)"), list(binding.tier2));
  draws.append(el("h3", "binding-subtitle", "Datum's own, tinted with its colours"), el("p", "binding-lede", binding.own));
  draws.append(
    el(
      "p",
      "binding-note",
      "Equality compares the drawing with the markup the design system's own templates produce. Tier-2 pictures are compared with the binding's own earlier pictures, because the design system has nothing to compare with; the first set was signed off by a person. Conformance is Datum's check that the binding carries what Datum owns through the design system: rules and errors, the summary, journeys, grids, translations, read-only and disabled, print and PDF, and the builder canvas drawn with the binding. Skipped means there is nothing of the binding to check."
    )
  );

  const demo = section("live", "Live", "A Datum form drawn in it.");
  const frame = el("div", "binding-demo");
  frame.dataset.bindingDemo = id;
  frame.append(el("p", "binding-demo__fallback", "The live form needs JavaScript and the demo files this site is built beside. The binding's source and its host files are listed below."));
  demo.append(frame);

  const use = section("use", "Use", "Register it, name it.");
  use.append(el("p", "binding-lede", `The binding lives in Datum's repository, bindings/${id}, and is not published as a package: build it there and serve its module. The host serves the design system's files and registers them with the binding once; every form on the page can then name the binding through its binding property.`));
  const code = el("pre", "code", snippet(binding));
  code.dataset.lang = "js";
  use.append(code);

  const notes = section("notes", "Notes", "What to know before you use it.");
  const noteList = el("div", "binding-notes");
  for (const note of binding.notes) {
    const item = el("div", "binding-notes__item");
    item.append(el("h3", "binding-subtitle", note.title), el("p", "binding-lede", note.text));
    noteList.append(item);
  }
  notes.append(noteList);

  const sources = section("sources", "Sources", "Where it lives.");
  const sourceLinks = el("p", "binding-lede");
  sourceLinks.append("The binding's source, reference markup and tests: ", link(`${GITHUB_BINDINGS}/${id}`, `bindings/${id}`), ". The design system: ", siteLink.cloneNode(true), ". The files this page loads are copied from the pinned release as it ships them, with each package's licence beside them.");
  sources.append(sourceLinks);

  const more = el("section", "container");
  const band = el("div", "band");
  const text = el("div", "band__text");
  text.append(el("span", "eyebrow", "Bindings"), el("h2", "section-title", "The others."));
  const actions = el("div", "band__actions");
  actions.append(link("./bindings.html", "All bindings", "btn btn--primary"), link("./binding-datum.html", "Datum's theme", "btn"));
  band.append(text, actions);
  more.append(band);

  root.replaceChildren(intro, top, draws, demo, use, notes, sources, more);
}

// ---------- Datum's own page ----------

const DATUM_USE = [
  `<script type="module" src="datum-form.js"></script>`,
  ``,
  `<datum-form src="/forms/intake.json"></datum-form>`
].join("\n");

function renderDatum(root: HTMLElement): void {
  const intro = el("section", "intro container");
  const crumb = el("span", "eyebrow");
  crumb.append(link("./bindings.html", "Bindings"));
  intro.append(crumb, el("h1", "section-title", "Datum"));
  intro.append(el("p", "intro__lede", "The one official theme. It is built in: a form draws in it with nothing to load and nothing to name, light and dark, scoped to the form so nothing leaks into the page."));

  const top = el("section", "container binding-top");
  top.append(
    facts([
      ["Conformance", conformanceLine(datumNumbers)],
      ["Measured", `${datumNumbers.browser}, ${datumNumbers.measuredOn}`],
      ["Accessibility", `No automated findings (axe ${AXE_VERSION}) in the light and dark looks. Automated checks only: no manual audit and no screen reader is part of the check.`],
      ["Fetches from", "Nothing: the theme is built in and every asset is a file served with the form."]
    ])
  );

  const draws = section("draws", "What it is", "Tokens and a stylesheet.");
  draws.append(
    list([
      "Tokens for colour, type, spacing and geometry, and the stylesheet that draws them, scoped to the form.",
      "A dark set that follows the page's colour scheme.",
      "Frames for the background a form sits on: seamless in the page, outlined, or paper.",
      "Header and footer parts: logo, organisation name, title, text and the language switcher, set once by the host and merged with the form's own.",
      "Every customisation seam a host needs, as options of the Datum binding, so a form can be restyled without writing a binding."
    ])
  );

  const demo = section("live", "Live", "A Datum form in its own look.");
  const frame = el("div", "binding-demo");
  frame.dataset.bindingDemo = "datum";
  frame.append(el("p", "binding-demo__fallback", "The live form needs JavaScript and the demo files this site is built beside."));
  demo.append(frame);

  const use = section("use", "Use", "Nothing to load.");
  const code = el("pre", "code", DATUM_USE);
  code.dataset.lang = "html";
  use.append(code);

  const other = section("others", "Other design systems", "Matching one is a binding's work.");
  const text = el("p", "binding-lede");
  text.append("A binding draws the form's fields in a design system's own markup and components. Nine reference bindings show the range, and the ", link("./docs/bindings", "binding guide"), " says how to write another. The design systems are their owners' own; Datum is not affiliated with or endorsed by them.");
  other.append(text, link("./bindings.html", "The nine reference bindings", "btn btn--primary"));

  root.replaceChildren(intro, top, draws, demo, use, other);
}

// ---------- the live form ----------

interface ManifestEntry {
  global: string;
  script: string;
  stylesheets: Array<{ url: string }>;
  scripts: Array<{ url: string; classic?: boolean; attributes?: Record<string, string> }>;
  bodyClass?: string;
}

interface DatumFormLike extends HTMLElement {
  definition: unknown;
  binding: unknown;
  assets: unknown;
  colorScheme: "light" | "dark" | undefined;
  texts: Record<string, unknown> | undefined;
  setNotice(notice: { kind?: "success" | "info"; title?: string; message?: string } | undefined): void;
}

interface FormModule {
  bindings: { register(binding: unknown, registration?: { assets?: unknown }): void; fromFactory(factory: unknown): unknown };
}

/** A classic script, for the bindings' IIFE bundles: the page reads their globals. */
function loadClassic(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error(`could not load ${url}`)), { once: true });
    document.head.append(script);
  });
}

/**
 * The form bundle's exports. The bundle is loaded as a module script (as every page loads it); the
 * import below gets the same module instance. Written with the Function constructor so the
 * development server leaves the address alone (it would add `?import`, which it refuses for files
 * under public/); a built site would take a plain import().
 */
function importModule(url: string): Promise<FormModule> {
  return new Function("url", "return import(url)")(url) as Promise<FormModule>;
}

const resolveAgainst = (base: string, value: string): string => (value.startsWith("./") ? new URL(value, base).href : value);

/**
 * Registers one reference binding with the page, once: its script and the files it names. The binding
 * is made with datum-form.js's own `bindings.fromFactory`, as a host makes it, so the page's one lit
 * and Datum's binding go into its factory and no second lit is loaded.
 */
async function registerBinding(id: string): Promise<void> {
  const manifestUrl = new URL(`${DEMO}bindings/manifest.json`, location.href).href;
  const manifest = (await (await fetch(manifestUrl)).json()) as Record<string, ManifestEntry>;
  const entry = manifest[id];
  if (entry === undefined) throw new Error(`the demo files have no binding "${id}"`);
  const form = await importModule(new URL(`${DEMO}datum-form.js`, location.href).href);
  await loadClassic(new URL(entry.script, manifestUrl).href);
  const module = (globalThis as unknown as Record<string, { createBinding: unknown }>)[entry.global]!;
  if (entry.bodyClass) document.body.classList.add(entry.bodyClass);
  const assets = {
    stylesheets: entry.stylesheets.map((file) => ({ url: resolveAgainst(manifestUrl, file.url) })),
    scripts: entry.scripts.map((file) => ({
      url: resolveAgainst(manifestUrl, file.url),
      ...(file.classic ? { classic: true } : {}),
      ...(file.attributes ? { attributes: Object.fromEntries(Object.entries(file.attributes).map(([key, value]) => [key, resolveAgainst(manifestUrl, value)])) } : {})
    }))
  };
  form.bindings.register(form.bindings.fromFactory(module.createBinding), { assets });
}

/** The form, its example picker and its receipt, in the frame. `binding` is the id to name; Datum's own names none. */
function mountForm(frame: HTMLElement, id: string): void {
  frame.querySelectorAll(".binding-demo__fallback").forEach((node) => node.remove());
  const own = id === "datum";

  const bar = el("div", "demo__bar");
  const label = el("label", "demo__control");
  label.append(el("span", "label", "Example"));
  const select = el("select", "demo__select");
  select.setAttribute("aria-label", "Example form");
  for (const example of examples) {
    const option = el("option", undefined, example.label);
    option.value = example.id;
    select.append(option);
  }
  label.append(select);
  bar.append(label);

  const surface = el("div", own ? "binding-demo__surface binding-demo__surface--own" : "binding-demo__surface binding-demo__surface--light");
  const form = document.createElement("datum-form") as DatumFormLike;
  if (!own) form.binding = id;
  surface.append(form);
  frame.append(bar, surface);

  const load = (): void => {
    const example = examples.find((entry) => entry.id === select.value) ?? examples[0]!;
    form.texts = example.texts;
    form.definition = example.definition;
    form.setNotice(undefined);
  };
  select.addEventListener("change", load);
  const follow = (): void => {
    if (own) form.colorScheme = siteTheme();
  };
  follow();
  new MutationObserver(follow).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  load();

  // No server behind this page: an accepted submit gets its receipt after a beat, and says nothing was sent.
  form.addEventListener("datum-submit", (event) => {
    const detail = (event as CustomEvent<{ accepted: boolean; waitUntil(done: Promise<unknown>): void }>).detail;
    if (!detail.accepted) return;
    detail.waitUntil(
      new Promise<void>((resolve) => setTimeout(resolve, 400)).then(() => {
        form.setNotice({ kind: "success", title: "Received", message: "This page has no server behind it, so nothing was sent." });
      })
    );
  });
}

function loadDemo(frame: HTMLElement): void {
  const id = frame.dataset.bindingDemo ?? "";
  loadModule(`${DEMO}datum-form.js`)
    .then(() => (id === "datum" ? undefined : registerBinding(id)))
    .then(() => customElements.whenDefined("datum-form"))
    .then(() => mountForm(frame, id))
    .catch((error: unknown) => {
      if (import.meta.env.DEV) console.info("The live binding demo has no files to load: run `npm run demo-assets` after building packages/datum and bindings/*.", error);
    });
}

/** Loads each live form once its section is near the viewport; the fallback paragraph stays until then. */
function observeDemos(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[data-binding-demo]").forEach((frame) => {
    if (!("IntersectionObserver" in window)) {
      loadDemo(frame);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        loadDemo(frame);
      },
      { rootMargin: "300px" }
    );
    observer.observe(frame);
  });
}

export function renderBindings(root: ParentNode = document): void {
  const index = root.querySelector<HTMLElement>("[data-binding-index]");
  if (index) renderIndex(index);
  const page = root.querySelector<HTMLElement>("[data-binding-page]");
  if (page) {
    const id = page.dataset.bindingPage ?? "";
    if (id === "datum") renderDatum(page);
    else renderBinding(page, id);
    observeDemos(page);
  }
}
