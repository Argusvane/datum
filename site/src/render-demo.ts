import { DEFAULT_EXAMPLE_ID, examples } from "./demo-forms";
import { highlightBlock } from "./highlight";
import { loadModule } from "./load-module";
import { demo, type DemoChoice } from "./pillars";
import { siteTheme, type SiteTheme } from "./site-theme";
import { wireTabs } from "./tabs";

/**
 * The home page's live demo: the real builder over the real form, from the bundles
 * `scripts/copy-demo-assets.mjs` copies into `public/demo/`. The module is loaded when the
 * section nears the viewport, under the site's base path; when it is not there (a checkout
 * without the bundles built), the fallback paragraph stays and nothing else happens.
 *
 * The builder keeps its own controls. New, Open and Download lead its bar: New and
 * Open replace the example in the builder, the change reaches the form below like any other,
 * and Reset brings the example back. Its strip's View panel holds the canvas's controls. Its
 * light and dark mode starts as the site's and follows the header's toggle (followSiteScheme);
 * its own Dark mode item changes the builder alone, never the site. The
 * page's bar above it picks the example, and, for a form with journeys, which of
 * them the form below shows (its `journey` attribute). The renderer section under it carries
 * the page's: tabs for the form, its data and the schema, Reset, Print and a PDF preview.
 *
 * The site has no dependency on the package, so the elements are typed here by the
 * few members the page touches.
 */
interface BuilderChangeDetail {
  definition: unknown;
}

interface ChangeDetail {
  values: Record<string, unknown>;
}

interface SubmitDetail {
  accepted: boolean;
  submission?: unknown;
  waitUntil(promise: Promise<unknown>): void;
}

interface NoticeLike {
  kind?: "success" | "info";
  title?: string;
  message?: string;
}

interface PdfResultLike {
  bytes: Uint8Array;
  fileName: string;
  pageCount: number;
}

interface DatumBuilderLike extends HTMLElement {
  definition: unknown;
}

/** A journey the form declares, as `<datum-form>`'s `journeys()` lists it. */
export interface JourneyOptionLike {
  id: string;
  /** Its name in the form's language, else its id. */
  label: string;
}

/** The host's chrome, as the element takes it: parts per region and a frame preset. */
interface ChromeLike {
  header?: unknown[];
  footer?: unknown[];
  frame?: string;
}

interface DatumFormLike extends HTMLElement {
  definition: unknown;
  /** The host page's colour scheme: `"dark"` draws Datum's dark look. */
  colorScheme: "light" | "dark" | undefined;
  /** The page's own wording (a `FormTextCatalog`); `undefined` leaves the engine's. */
  texts: Record<string, unknown> | undefined;
  values: Record<string, unknown>;
  chrome: ChromeLike | undefined;
  setNotice(notice: NoticeLike | undefined): void;
  renderPdf(): Promise<PdfResultLike>;
  print(): Promise<void>;
  journeys(): JourneyOptionLike[];
}

type SwitcherPlacement = "header" | "footer" | "none";

/** The site's mark as the demo host's logo: a `data:` image, so the chrome needs no asset. */
const LOGO_SRC =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 28 28"><rect width="28" height="28" fill="#fafaf9"/><path d="M4 6h8M4 11h20" stroke="#141414" stroke-width="2.5" stroke-linecap="square"/><path d="M4 17h12" stroke="#141414" stroke-width="2.5" stroke-linecap="square"/><path d="M4 22h20" stroke="#d3080c" stroke-width="2.5" stroke-linecap="square"/></svg>'
  );

/** What the chrome menu holds; the form's `chrome` is built from it. */
interface ChromeChoices {
  logo: boolean;
  title: boolean;
  description: boolean;
  switcher: SwitcherPlacement;
  footer: boolean;
  frame: string;
}

const DEFAULT_CHROME: ChromeChoices = { logo: true, title: true, description: false, switcher: "header", footer: false, frame: "seamless" };

function chromeFrom(choices: ChromeChoices): ChromeLike {
  const header: unknown[] = [];
  const footer: unknown[] = [];
  if (choices.logo) header.push({ type: "image", src: LOGO_SRC, alt: "Datum" });
  if (choices.switcher === "header") header.push({ type: "language-switcher", align: "end" });
  if (choices.title) header.push({ type: "form-title" });
  if (choices.description) header.push({ type: "form-description" });
  if (choices.footer) footer.push({ type: "text", text: demo.chrome.footerText });
  if (choices.switcher === "footer") footer.push({ type: "language-switcher", align: "end" });
  return { header, footer, frame: choices.frame };
}

/**
 * The builder's light and dark mode follows the site's, one way: it takes the site's theme as its
 * `scheme` now and each time the returned function is called (the site's theme changed), and the
 * form on its canvas follows the builder's scheme by itself. The builder's own Dark mode item
 * changes the builder alone and is not listened for: the site's theme is the header toggle's to
 * choose, and the next change of it brings the builder back in step.
 */
export function followSiteScheme(builder: Pick<HTMLElement, "setAttribute">, theme: () => SiteTheme): () => void {
  const apply = (): void => builder.setAttribute("scheme", theme());
  apply();
  return apply;
}

/** A labelled select in the site's style, from a list of choices. */
function choiceSelect(label: string, choices: DemoChoice[], className: string): { control: HTMLLabelElement; select: HTMLSelectElement } {
  const control = el("label", className);
  control.append(el("span", "label", label));
  const select = el("select", "demo__select");
  select.setAttribute("aria-label", label);
  for (const choice of choices) {
    const option = el("option", undefined, choice.label);
    option.value = choice.id;
    select.append(option);
  }
  control.append(select);
  return { control, select };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The View picker's words. */
export const VIEW_WORDS = {
  label: "View",
  /** No `journey` attribute: the form opens as its definition says. */
  opens: "As the form opens",
  whole: "Whole form"
};

/** One entry of the View picker: what the form's `journey` attribute is set to, and its label. */
export interface ViewOption {
  /** `""` for the form's own choice (no attribute), `"form"` for the whole form, else a journey's id. */
  value: string;
  label: string;
}

/**
 * The View picker's entries for what the form declares: the form's own choice, the whole form,
 * then each journey by name, in the order declared. None when it declares none, and then no
 * picker. An id listed twice, or one the attribute reads as a keyword, is offered once.
 */
export function viewOptions(journeys: readonly JourneyOptionLike[]): ViewOption[] {
  if (journeys.length === 0) return [];
  const options: ViewOption[] = [
    { value: "", label: VIEW_WORDS.opens },
    { value: "form", label: VIEW_WORDS.whole }
  ];
  const taken = new Set(["", "form", "journey"]);
  for (const journey of journeys) {
    if (taken.has(journey.id)) continue;
    taken.add(journey.id);
    options.push({ value: journey.id, label: journey.label });
  }
  return options;
}

/** The journey ids a definition declares, read as written (the element reads the same list). */
function declaredJourneyIds(definition: unknown): string[] {
  const journeys = (definition as { journey?: { journeys?: unknown } } | undefined)?.journey?.journeys;
  if (!Array.isArray(journeys)) return [];
  return journeys.flatMap((journey) => {
    const id = (journey as { id?: unknown } | null)?.id;
    return typeof id === "string" ? [id] : [];
  });
}

/** What the View picker needs of the form: the attribute it sets and the list it offers. */
export type ViewForm = Pick<HTMLElement, "setAttribute" | "removeAttribute" | "addEventListener"> & {
  journeys(): JourneyOptionLike[];
};

export interface ViewPicker {
  control: HTMLLabelElement;
  select: HTMLSelectElement;
  /** Back to the form's own choice: a new example, or Reset. */
  reset(): void;
}

/**
 * The View picker: which of the form's presentations the rendered form shows, set as its
 * `journey` attribute (removed for the form's own choice). Shown only while the form has
 * journeys. It follows the builder: each new definition the form takes up
 * (`datum-ready`) lists what it declares now, and a pick that is gone falls back to the form's
 * own choice — dropped as the builder's change arrives, before the form reads it, so the form
 * never looks for a journey it no longer has.
 */
export function viewPicker(form: ViewForm, builder: Pick<HTMLElement, "addEventListener">): ViewPicker {
  const { control, select } = choiceSelect(VIEW_WORDS.label, [], "demo__control");
  control.hidden = true;
  let picked = "";
  let listed = "";

  const pick = (value: string): void => {
    picked = value;
    if (value === "") form.removeAttribute("journey");
    else form.setAttribute("journey", value);
  };

  const refresh = (): void => {
    const options = viewOptions(form.journeys());
    // Rebuilt only when the list changed, so an edit elsewhere in the builder leaves it be.
    const signature = JSON.stringify(options);
    if (signature !== listed) {
      listed = signature;
      select.replaceChildren(
        ...options.map((entry) => {
          const option = el("option", undefined, entry.label);
          option.value = entry.value;
          return option;
        })
      );
    }
    if (picked !== "" && !options.some((entry) => entry.value === picked)) pick("");
    select.value = picked;
    control.hidden = options.length === 0;
  };

  select.addEventListener("change", () => pick(select.value));
  form.addEventListener("datum-ready", refresh);
  builder.addEventListener("datum-builder-change", (event) => {
    const definition = (event as CustomEvent<BuilderChangeDetail>).detail.definition;
    if (picked !== "" && picked !== "form" && !declaredJourneyIds(definition).includes(picked)) pick("");
  });

  return {
    control,
    select,
    reset: () => {
      pick("");
      select.value = "";
    }
  };
}

/** A JSON view: the value pretty-printed into a code block and coloured. */
function renderJson(block: HTMLPreElement, value: unknown): void {
  block.textContent = JSON.stringify(value, null, 2) ?? "";
  highlightBlock(block);
}

/** One tab button and its panel, in the markup the site's tabs use (see tabs.ts). */
function tab(id: string, label: string, selected: boolean): { button: HTMLButtonElement; panel: HTMLDivElement } {
  const button = el("button", "tab", label);
  button.type = "button";
  button.id = `demo-tab-${id}`;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", selected ? "true" : "false");
  button.setAttribute("aria-controls", `demo-panel-${id}`);
  if (!selected) button.tabIndex = -1;
  const panel = el("div", "demo__panel");
  panel.id = `demo-panel-${id}`;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", button.id);
  panel.hidden = !selected;
  return { button, panel };
}

/** A row of the chrome menu: a checkbox with its label, or a labelled select. */
function checkRow(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const row = el("label", "demo__menu-row");
  const box = el("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => onChange(box.checked));
  row.append(box, el("span", undefined, label));
  return row;
}

function selectRow(label: string, options: Array<[value: string, text: string]>, value: string, onChange: (value: string) => void): HTMLLabelElement {
  const row = el("label", "demo__menu-row demo__menu-row--select");
  const select = el("select", "demo__select");
  for (const [optionValue, text] of options) {
    const option = el("option", undefined, text);
    option.value = optionValue;
    select.append(option);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  row.append(el("span", undefined, label), select);
  return row;
}

/**
 * The chrome menu: the host's header and footer parts and the frame, as a page sets them on
 * the element. A disclosure, so the bar stays one row.
 */
function chromeMenu(apply: (choices: ChromeChoices) => void): HTMLDetailsElement {
  const choices: ChromeChoices = { ...DEFAULT_CHROME };
  const menu = el("details", "demo__menu");
  const summary = el("summary", "btn btn--small", demo.chrome.label);
  const panel = el("div", "demo__menu-panel");
  const update = <K extends keyof ChromeChoices>(key: K) => (value: ChromeChoices[K]) => {
    choices[key] = value;
    apply(choices);
  };
  panel.append(
    checkRow(demo.chrome.logo, choices.logo, update("logo")),
    checkRow(demo.chrome.title, choices.title, update("title")),
    checkRow(demo.chrome.description, choices.description, update("description")),
    checkRow(demo.chrome.footer, choices.footer, update("footer")),
    selectRow(
      demo.chrome.switcher,
      [
        ["header", demo.chrome.switcherOptions.header],
        ["footer", demo.chrome.switcherOptions.footer],
        ["none", demo.chrome.switcherOptions.none]
      ],
      choices.switcher,
      (value) => update("switcher")(value as SwitcherPlacement)
    ),
    selectRow(demo.chrome.frame, Object.entries(demo.chrome.frames), choices.frame, update("frame"))
  );
  menu.append(summary, panel);
  // Clicking anywhere else closes the menu, as a menu should.
  document.addEventListener("pointerdown", (event) => {
    if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
  });
  return menu;
}

/** The PDF viewer: one dialog for the page, the browser's own viewer in a frame. */
function previewDialog(): { dialog: HTMLDialogElement; open: (result: PdfResultLike) => void } {
  const dialog = el("dialog", "demo__dialog");
  const head = el("div", "demo__dialog-head");
  const heading = el("div", "demo__dialog-title");
  const title = el("span", "label", demo.preview.title);
  const meta = el("span", "demo__dialog-meta");
  heading.append(title, meta);
  const close = el("button", "btn btn--small", demo.preview.close);
  close.type = "button";
  head.append(heading, close);
  const frame = el("iframe", "demo__dialog-frame");
  frame.title = demo.preview.title;
  dialog.append(head, frame);
  document.body.append(dialog);

  let url: string | undefined;
  const release = () => {
    if (url) URL.revokeObjectURL(url);
    url = undefined;
    frame.removeAttribute("src");
  };
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", release);

  const open = (result: PdfResultLike) => {
    release();
    const bytes = new Uint8Array(result.bytes);
    url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    frame.src = url;
    meta.textContent = `${result.fileName}, ${result.pageCount} ${result.pageCount === 1 ? demo.preview.page : demo.preview.pages}`;
    dialog.showModal();
  };
  return { dialog, open };
}

function mount(container: HTMLElement): void {
  container.querySelectorAll("[data-demo-fallback]").forEach((node) => node.remove());

  // The builder, contained, with its PDF side (the executor and the page imagery are chunks
  // copied beside the module).
  const builderBox = el("div", "demo__builder");
  const builder = document.createElement("datum-form-builder") as DatumBuilderLike;
  builder.setAttribute("layout", "contained");
  builder.setAttribute("pdf", "auto");
  // Light or dark with the site, before it connects, so its first paint is the page's theme.
  const applyScheme = followSiteScheme(builder, siteTheme);
  // The box sets the height (640px, less on a phone: styles.css); the element fills it.
  builderBox.append(builder);

  // The form the builder's work renders as, in the renderer section below.
  const form = document.createElement("datum-form") as DatumFormLike;
  form.setAttribute("pdf", "auto");
  applyAgentAttributes(form, agentBundleLoaded);
  form.chrome = chromeFrom(DEFAULT_CHROME);

  // The bar above the builder: which example form, which of its journeys the form
  // below shows (only for a form that has some), and Reset, which puts the builder and the form
  // back to the example as written.
  const topBar = el("div", "demo__bar");
  const topControls = el("div", "demo__actions");
  const example = choiceSelect(
    demo.exampleLabel,
    examples.map((entry) => ({ id: entry.id, label: entry.label })),
    "demo__control"
  );
  example.select.value = DEFAULT_EXAMPLE_ID;
  const view = viewPicker(form, builder);
  const reset = el("button", "btn btn--small", demo.reset);
  reset.type = "button";
  // The toggle and Reset keep together, last: Reset ends the row the toggle is on, never alone on one.
  const end = el("div", "demo__bar-end");
  end.append(reset);
  topControls.append(example.control, view.control, end);
  topBar.append(topControls);
  const currentEntry = () => examples.find((entry) => entry.id === example.select.value) ?? examples[0];
  const currentExample = (): unknown => currentEntry().definition;

  // The renderer section: tabs on the left, the page's controls on the right, panels under.
  const sheet = el("div", "demo__sheet");
  const bar = el("div", "demo__sheet-bar");
  const tabs = el("div", "tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", demo.sheetLabel);
  tabs.dataset.tabs = "";
  const formTab = tab("form", demo.tabs.form, true);
  const dataTab = tab("data", demo.tabs.data, false);
  const schemaTab = tab("schema", demo.tabs.schema, false);
  tabs.append(formTab.button, dataTab.button, schemaTab.button);

  const actions = el("div", "demo__actions");
  const printButton = el("button", "btn btn--small", demo.print);
  printButton.type = "button";
  const preview = el("button", "btn btn--small", demo.preview.label);
  preview.type = "button";

  formTab.panel.append(form);

  const chrome = chromeMenu((choices) => {
    form.chrome = chromeFrom(choices);
  });
  actions.append(chrome, printButton, preview);
  bar.append(tabs, actions);

  const dataLabel = el("span", "label", demo.dataLabels.values);
  dataLabel.dataset.demoDataLabel = "";
  const dataBlock = el("pre", "code demo__json");
  dataBlock.dataset.lang = "json";
  dataTab.panel.append(dataLabel, dataBlock);

  const schemaBlock = el("pre", "code demo__json");
  schemaBlock.dataset.lang = "json";
  schemaTab.panel.append(schemaBlock);

  sheet.append(bar, formTab.panel, dataTab.panel, schemaTab.panel);
  container.append(topBar, builderBox, sheet);
  wireTabs(sheet);

  // Datum's own look follows the site's light and dark toggle.
  const applyTheme = (): void => {
    const site = siteTheme();
    form.colorScheme = site;
    sheet.dataset.scheme = site;
  };

  const showValues = (values: Record<string, unknown>): void => {
    dataLabel.textContent = demo.dataLabels.values;
    renderJson(dataBlock, values);
  };

  /** Hands the current example to both elements and resets what the tabs show. */
  const loadExample = (): void => {
    const definition = currentExample();
    // A new example, or the same one again, opens as it says.
    view.reset();
    builder.definition = definition;
    form.texts = currentEntry().texts;
    form.definition = definition;
    form.setNotice(undefined);
    renderJson(schemaBlock, definition);
    showValues(form.values);
  };

  applyTheme();
  loadExample();

  // The one line between the two: what the builder emits is what the form renders.
  builder.addEventListener("datum-builder-change", (event) => {
    const definition = (event as CustomEvent<BuilderChangeDetail>).detail.definition;
    form.definition = definition;
    renderJson(schemaBlock, definition);
  });

  // The data tab follows the answers as they settle, and shows the envelope once it is sent.
  form.addEventListener("datum-ready", () => showValues(form.values));
  form.addEventListener("datum-change", (event) => showValues((event as CustomEvent<ChangeDetail>).detail.values));

  // The site's theme changed (the header's toggle): the builder's scheme and the rendered
  // form's scheme follow.
  new MutationObserver(() => {
    applyScheme();
    applyTheme();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  example.select.addEventListener("change", loadExample);
  reset.addEventListener("click", loadExample);

  // No server behind this page: an accepted submit gets its receipt after a beat, and the
  // receipt says nothing was sent. A rejected one is the form's to report: it shows its errors.
  form.addEventListener("datum-submit", (event) => {
    const detail = (event as CustomEvent<SubmitDetail>).detail;
    if (!detail.accepted) return;
    if (detail.submission !== undefined) {
      dataLabel.textContent = demo.dataLabels.submission;
      renderJson(dataBlock, detail.submission);
    }
    const accepted = new Promise<void>((resolve) => setTimeout(resolve, 400)).then(() => {
      form.setNotice({ kind: "success", title: demo.accepted.title, message: demo.accepted.detail });
    });
    detail.waitUntil(accepted);
  });

  // Print: the read-only rendition through the browser's print dialog. The element writes it into
  // a hidden frame of its own, so the page around the form (this bar, the builder) never prints.
  // The button is off until the dialog has been called, so a second click cannot queue a print.
  printButton.addEventListener("click", () => {
    printButton.disabled = true;
    form.print().finally(() => {
      printButton.disabled = false;
    });
  });

  let viewer: ReturnType<typeof previewDialog> | undefined;
  preview.addEventListener("click", () => {
    preview.disabled = true;
    form
      .renderPdf()
      .then((result) => {
        viewer ??= previewDialog();
        viewer.open(result);
      })
      .catch(() => {
        // The PDF module is not beside the bundle (not copied); the button has nothing to do.
        preview.hidden = true;
      })
      .finally(() => {
        preview.disabled = false;
      });
  });
}

/** Set once the renderer bundle (the one that can register the form's tools) has loaded. */
let agentBundleLoaded = false;

/**
 * The bundles the demo loads after the icons bundle, in order. The renderer bundle comes first
 * and only where the browser has WebMCP: it is the larger download and serves nothing else
 * there, so a visitor without WebMCP fetches the builder bundle alone, as before. The first
 * definition of the form element must be the renderer bundle's, because the builder bundle's
 * element refuses the agent token.
 */
export function demoBundleUrls(hasWebMcp: boolean): string[] {
  const form = `${import.meta.env.BASE_URL}demo/datum-form.js`;
  const builder = `${import.meta.env.BASE_URL}demo/datum-builder.js`;
  return hasWebMcp ? [form, builder] : [builder];
}

/**
 * Browser assistants on the demo form: the demo definitions carry no agentTools, so the page allows
 * the tools itself. Only once the renderer bundle is there; the builder bundle's form element
 * rejects the agent token with a datum-error, so without it the form stays as it was.
 */
export function applyAgentAttributes(form: Pick<Element, "setAttribute">, enabled: boolean): void {
  if (!enabled) return;
  form.setAttribute("features", "all agent");
  form.setAttribute("agent-access", "always");
}

/**
 * Loads the bundles demoBundleUrls names, in that order, and says whether the renderer bundle
 * (the one that can register the form's tools) came in. Where WebMCP is present it goes first and
 * a failed load is not fatal: the builder still loads and draws the form alone. Where it is not,
 * only the builder bundle loads. The loader is a parameter so a test can see the order and the
 * failure branch without a browser.
 */
export async function loadDemoBundles(hasWebMcp: boolean, load: (url: string) => Promise<void> = loadModule): Promise<boolean> {
  const [first, ...rest] = demoBundleUrls(hasWebMcp);
  let rendererLoaded = false;
  if (hasWebMcp) {
    rendererLoaded = await load(first!).then(
      () => true,
      () => false
    );
    for (const url of rest) await load(url);
  } else {
    await load(first!);
  }
  return rendererLoaded;
}

function load(container: HTMLElement): void {
  const hasWebMcp = "modelContext" in document;
  // Font Awesome for the builder's chrome first: the default set is read as the
  // elements upgrade, so the icons module goes before the builder's; without it the builder
  // draws with the engine's own glyphs. Then the renderer bundle where WebMCP exists (the demo
  // form's tools come from it; a failed load leaves the builder to draw the form alone), then
  // the builder (loadDemoBundles). Each URL is written out whole so the base is inlined into it
  // at build time (the build test greps for the literal paths).
  loadModule(`${import.meta.env.BASE_URL}demo/datum-icons-fontawesome.js`)
    .then(async () => {
      agentBundleLoaded = await loadDemoBundles(hasWebMcp);
    })
    .then(() => Promise.all([customElements.whenDefined("datum-form-builder"), customElements.whenDefined("datum-form")]))
    .then(() => mount(container))
    .catch((error: unknown) => {
      if (import.meta.env.DEV) {
        console.info("The live demo has no bundles to load: run `npm run demo-assets` after building packages/datum and plugins/*.", error);
      }
    });
}

/** Loads the demo once its section is near the viewport; the fallback stays until then. */
export function renderDemo(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-demo]").forEach((container) => {
    if (!("IntersectionObserver" in window)) {
      load(container);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        load(container);
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(container);
  });
}
