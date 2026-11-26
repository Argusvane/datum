import facts from "./binding-facts.json";

/**
 * The binding pages' copy: Datum's own theme and the nine reference bindings. The numbers are not
 * written here: they are what `kit:check` measured (binding-facts.json, scripts/collect-binding-facts.mjs).
 *
 * The scope the words keep: Datum ships one official theme, `datum`. A design-system
 * binding is a reference implementation, a demo and a starting point: it validates the binding
 * infrastructure against a real design system, it carries no support promise, and Datum claims nothing
 * about its accessibility. The design system is the authority for its own look, markup and accessibility.
 * Datum is not affiliated with or endorsed by a design system's owner, and each page says so.
 */

/** The version of axe-core behind "no automated findings" on Datum's own look; a test holds it to the a11y baseline's. */
export const AXE_VERSION = "4.14.1";

/** A case the binding declares known: a defect of the design system itself, reported with its reason and counted apart from pass and fail. */
export interface KnownDefect {
  suite: "behaviour" | "conformance";
  case: string;
  reason: string;
}

export interface TestNumbers {
  /** `known` is left out when the binding declares none. */
  behaviour: { pass: number; fail: number; skip: number; known?: number };
  conformance: { pass: number; fail: number; skip: number; pending: number; known?: number };
  /** The reasons of the known cases, left out when there are none. */
  knownDefects?: KnownDefect[];
  browser: string;
  measuredOn: string;
}

export interface BindingNumbers extends TestNumbers {
  release: string;
  budgetKb: number;
  gzipKb: number;
  /** tier1 and tier2 count the cases; tier1Pass the tier-1 cases that pass (the index card's equality). */
  equality: { tier1: number; tier1Pass: number; tier2: number; pass: number; fail: number };
}

export interface BindingNote {
  title: string;
  text: string;
}

/** An address a page that draws the form with the binding asks, beyond this site's own files: where the design system's own stylesheet or script sends the browser. */
export interface BindingHost {
  host: string;
  reason: string;
}

export interface ReferenceBinding {
  id: string;
  /** The design system's name, as the page and the index call it. */
  name: string;
  /** The design system's owner, named on the page beside "Design system by". */
  by: string;
  /** One sentence for the index card and the share preview. */
  summary: string;
  /** What the design system is, for the page's lede. */
  lede: string;
  /** The design system's own site. */
  site: string;
  /** Where its code lives: what the binding is pinned to. */
  pinned: string;
  /** The components the design system draws itself. */
  official: string[];
  /** Datum's components drawn in the design system's HTML and tokens (the pictures compared with the binding's own baselines). */
  tier2: string[];
  /** What Datum draws with its own adapter, tinted with the design system's colours. */
  own: string;
  /** The design system's files the host serves, by file name (bindings/<id>/binding-check.json lists them whole). */
  host: { stylesheets: string[]; scripts: Array<string | HostScript> };
  /** What the host serves, and what happens to the page around the form. */
  notes: BindingNote[];
  /** What the design system's own files fetch from a third party when a page loads them; empty when they fetch nothing. Datum and its own look fetch nothing. */
  network: BindingHost[];
}

/** A script the host loads other than as a module: classic, with the attributes the design system's script reads from its own element. */
export interface HostScript {
  file: string;
  classic: true;
  /** Attribute values as the snippet serves them, under /design-system/. */
  attributes?: Record<string, string>;
}

/** A host script's file name. */
export const scriptFile = (script: string | HostScript): string => (typeof script === "string" ? script : script.file);

export const GITHUB_BINDINGS = "https://github.com/argusvane/datum/tree/main/bindings";

export const referenceBindings: ReferenceBinding[] = [
  {
    id: "gcds",
    name: "GC Design System",
    by: "Government of Canada",
    summary: "Canada.ca's design system: web components over design tokens, in English and French.",
    lede: "The Government of Canada's design system, used on Canada.ca. Its components are web components over tokens for colour, type and spacing, with English and French throughout.",
    site: "https://design-system.canada.ca/",
    pinned: "@gcds-core/components 1.7.0",
    official: [
      "text and number (gcds-input), textarea, select, radios and checkboxes, a single checkbox",
      "fieldset, data grid (stacked fieldsets with gcds-button), steps (gcds-stepper)",
      "the error summary, the host's receipt (gcds-notice), the language toggle, a journey page's heading and buttons"
    ],
    tier2: ["the date (month, day and year in the design system's label, hint and error pieces)", "a text or number field with a prefix or suffix", "the character count beside a field"],
    own: "Tabs, files, signatures, button groups and a radio or checkbox group of fewer than two options.",
    host: { stylesheets: ["gcds.css"], scripts: ["gcds.esm.js"] },
    notes: [
      { title: "Host files", text: "The host serves gcds.css and the component script of the one pinned release. Datum ships none of them." },
      { title: "Print and PDF", text: "The package carries a print theme and a PDF theme (the worked example of a design system's paper). A server host maps the binding to its PDF theme in its catalogue." },
      { title: "One release per page", text: "Web components register once per page, so a page that draws forms with this binding serves one release of the design system to every form on it." }
    ],
    network: [
      { host: "fonts.googleapis.com", reason: "gcds.css imports Lato, Noto Sans and Noto Sans Mono from Google Fonts" },
      { host: "fonts.gstatic.com", reason: "the font files of that Google Fonts stylesheet" },
      { host: "cdn.design-system.canada.ca", reason: "the components load their icon font from the design system's CDN" }
    ]
  },
  {
    id: "govuk",
    name: "GOV.UK Frontend",
    by: "Government Digital Service, UK",
    summary: "GOV.UK's frontend: plain HTML and CSS components, with an optional script.",
    lede: "The UK government's design system for GOV.UK services. Its components are HTML and CSS, with an optional script for a few behaviours.",
    site: "https://design-system.service.gov.uk/",
    pinned: "govuk-frontend 6.6.0",
    official: [
      "text, textarea, number (a text box with a numeric keyboard), select, radios, checkboxes, a single checkbox, the date input, button",
      "fieldset, button group, tabs, a data grid as stacked fieldsets",
      "the error summary, the host's receipt as a notification banner, the language navigation, warnings as warning text and info as inset text, a journey page's heading and buttons"
    ],
    tier2: [],
    own: "Steps, files, signatures and chrome parts, tinted with GOV.UK's colours.",
    host: { stylesheets: ["govuk-frontend.min.css"], scripts: [{ file: "all.bundle.js", classic: true }] },
    notes: [
      {
        title: "The typeface",
        text: "GDS Transport is licensed for GOV.UK services only, so this site does not serve it and Datum ships it nowhere. The form on this page falls back to Arial, the next face in GOV.UK's own font stack. A GOV.UK service that is entitled to GDS Transport supplies it with the other host files."
      },
      { title: "The design system's script", text: "GOV.UK's script is started on the form when the host loads it; only the button is opted in, because the other components look elements up through the document, which a shadow root hides. Without it the markup is GOV.UK's no-JavaScript baseline." },
      { title: "Tier 1 only", text: "Every component this binding uses is plain HTML and CSS, so it has no tier-2 type and no picture baselines to sign off." }
    ],
    network: []
  },
  {
    id: "uswds",
    name: "U.S. Web Design System",
    by: "General Services Administration, US",
    summary: "The US federal design system: CSS and Twig templates, with English, Spanish and French wording.",
    lede: "The design system of the US federal government. It ships CSS, fonts, icons and Twig templates for its markup.",
    site: "https://designsystem.digital.gov/",
    pinned: "uswds 3.14.0",
    official: [
      "text, textarea, number, select, radios, checkboxes, a single checkbox, the memorable date, button",
      "fieldset, tabs (the segmented button group), a data grid (usa-table), steps (usa-step-indicator), button group",
      "the error summary (USWDS's error alert), the host's receipt, the required note, the language selector, a journey page's heading and buttons"
    ],
    tier2: [],
    own: "Files, signatures and chrome parts, tinted with USWDS's colours.",
    host: { stylesheets: ["uswds.min.css"], scripts: [] },
    notes: [
      { title: "No script", text: "None of USWDS's script is started. Its components are drawn in their no-JavaScript markup and Datum owns the behaviour, so the binding changes nothing outside the form." },
      { title: "Words", text: "English, Spanish and French wording packs for what the renderer says; a form's own translations win." }
    ],
    network: []
  },
  {
    id: "bootstrap",
    name: "Bootstrap 5",
    by: "The Bootstrap authors",
    summary: "The most used CSS framework: classes on plain markup, no fonts and no script needed.",
    lede: "Bootstrap 5, the CSS framework. Datum draws its forms with Bootstrap's form classes, tabs, tables and alerts. It is the binding to read first: no web components, no fonts, no script.",
    site: "https://getbootstrap.com/",
    pinned: "bootstrap 5.3.8",
    official: [
      "text, textarea, number, select, radios, checkboxes, a single checkbox, button",
      "fieldset, button group, tabs (nav-tabs), a data grid (table or cards), steps (nav-pills)",
      "the error summary and the host's receipt as alerts, warnings and info as alerts, a language switcher, a journey page's heading and buttons"
    ],
    tier2: [],
    own: "Files, signatures and chrome parts, tinted with Bootstrap's colours. The date is three form controls in a row, since Bootstrap has no date.",
    host: { stylesheets: ["bootstrap.min.css"], scripts: [] },
    notes: [
      { title: "No script", text: "Bootstrap's plugins are delegated from the document and cannot run on a form in a shadow root, so none is started. Every component is drawn as Bootstrap's no-JavaScript markup and Datum owns the behaviour." },
      { title: "Layout variants", text: "Bootstrap's horizontal, inline and floating form layouts are out of scope: a form author uses the cssClass and formClass settings." },
      { title: "Dark mode", text: "Not drawn. Bootstrap's dark mode is an attribute on an ancestor, which a shadow root's stylesheet cannot match." }
    ],
    network: []
  },
  {
    id: "nova-scotia",
    name: "Nova Scotia Pattern Library",
    by: "Province of Nova Scotia",
    summary: "Nova Scotia's UI pattern library: a Bootstrap 3 stylesheet and HTML snippets, no script.",
    lede: "The Province of Nova Scotia's UI pattern library. It is a stylesheet (saltire.css, over Bootstrap 3) and HTML snippets, with no script.",
    site: "https://nsgov.github.io/patternlibrary/",
    pinned: "patternlibrary commit 663c256",
    official: [
      "text, textarea, number, select, radios, checkboxes, a single checkbox, button",
      "fieldset, a data grid, steps (the progress tracker), a button group",
      "the error summary and the host's receipt as the library's alert, the required note, the language links, a journey page's heading and buttons"
    ],
    tier2: ["the date (three boxes in the library's label and box markup: the library has none)"],
    own: "Tabs, files, signatures and chrome parts, tinted with the library's colours.",
    host: { stylesheets: ["saltire.css", "font-awesome.min.css"], scripts: [] },
    notes: [
      { title: "Host files", text: "saltire.css and Font Awesome 4.7's stylesheet. The library's logos are not served here." },
      { title: "Words", text: "English and French wording packs." }
    ],
    network: [
      { host: "novascotia.ca", reason: "saltire.css names the Roboto and Font Awesome faces, other font formats and the icon sprite there; only the Open Sans .woff faces are served from this site" },
      { host: "beta.novascotia.ca", reason: "saltire.css draws the footer background image from there" }
    ]
  },
  {
    id: "alberta",
    name: "Alberta Design System",
    by: "Government of Alberta",
    summary: "Alberta's design system: goa- web components, with the form item as the unit.",
    lede: "The Government of Alberta's design system. Its components are web components, and each field sits inside a form item that carries its label, hint and error.",
    site: "https://design.alberta.ca/",
    pinned: "@abgov/web-components 3.2.0",
    official: [
      "text and number (goa-input), textarea, select (goa-dropdown, native), radios (goa-radio-group), checkboxes (goa-checkbox-list), a single checkbox, button, each inside a goa-form-item",
      "a data grid (goa-table or stacked fieldsets)",
      "the error summary and the host's receipt (goa-callout), a field's warnings and info, a journey page's heading and buttons"
    ],
    tier2: ["the date (a fieldset written as goa-form-item writes it, around a month dropdown and day and year boxes)", "a named group", "the character count", "tabs and steps in goa-tabs' tokens"],
    own: "Files, signatures, a language switcher and chrome parts, tinted with Alberta's tokens.",
    host: { stylesheets: ["index.css"], scripts: ["index.js"] },
    notes: [
      { title: "Words", text: "English is the only language Alberta words its components in; a form's own translations word the rest." },
      { title: "Host files", text: "index.css and index.js of the one pinned release. The header logos inside the component bundle are not served here." },
      { title: "One release per page", text: "Web components register once per page, so a page serves one release of the design system to every form on it." }
    ],
    network: [
      { host: "fonts.googleapis.com", reason: "index.css imports Roboto Mono from Google Fonts; no pinned package ships it" },
      { host: "fonts.gstatic.com", reason: "the font files of that Roboto Mono stylesheet" },
      { host: "use.typekit.net", reason: "index.css loads the acumin faces from Adobe Fonts, which serves them only from there" }
    ]
  },
  {
    id: "quebec",
    name: "Québec design system",
    by: "Gouvernement du Québec",
    summary: "Québec's design system: qc- markup over a classic script, French first, with a dark scheme.",
    lede: "The Gouvernement du Québec's design system. Its fields are qc- components styled by one stylesheet and started by one classic script, French first.",
    site: "https://design.quebec.ca/",
    pinned: "qc-trousse-sdg 1.6.1",
    official: [
      "text, number, textarea (qc-textfield), radios and checkboxes (qc-choice-group), a single checkbox (qc-checkbox), the date as three text fields in a fieldset, button",
      "fieldset, button group, a stacked data grid",
      "the error summary and the host's receipt (qc-notice), a journey page's heading and buttons"
    ],
    tier2: ["the select, Datum's native select in the toolkit's face (the official listbox is the package's qc-select plugin type)"],
    own: "Tabs, steps, files, signatures and chrome parts, tinted with Québec's tokens. The toolkit's dark scheme is drawn through its dark-theme class.",
    host: {
      stylesheets: ["qc-sdg-rfz100.min.css"],
      scripts: [
        {
          file: "qc-sdg.min.js",
          classic: true,
          attributes: { "sdg-css-path": "/design-system/qc-sdg-rfz100.min.css", "sdg-assets-base-path": "/design-system" }
        }
      ]
    },
    notes: [
      { title: "Host files", text: "The stylesheet and the classic script (which reads its own element for its paths). The Government of Québec signature is not served here." },
      { title: "Words", text: "English and French wording packs." }
    ],
    network: []
  },
  {
    id: "ontario",
    name: "Ontario Design System",
    by: "Government of Ontario",
    summary: "Ontario's design system: Stencil web components, an English and French language toggle.",
    lede: "The Government of Ontario's design system. Its components are Stencil web components, and each upgrades itself inside the form's shadow root.",
    site: "https://designsystem.ontario.ca/",
    pinned: "ontario-design-system 9.2.2",
    official: [
      "text and number (ontario-input), textarea, select (ontario-dropdown-list), radios, checkboxes, button (ontario-button)",
      "fieldset (ontario-fieldset), a data grid (stacked fieldsets), steps (ontario-step-indicator)",
      "the error summary and the host's receipt (ontario-page-alert), the language toggle for a form with exactly one English and one French locale, warnings and info (ontario-callout)"
    ],
    tier2: ["the date (year, month and day in Ontario's HTML and tokens: its own date input validates by itself and has no way to take an error someone else found)"],
    own: "Tabs, a single checkbox, files, signatures and chrome parts, tinted with Ontario's colours. Ontario ships no dark scheme.",
    host: { stylesheets: ["ontario-theme.min.css"], scripts: ["ontario-design-system-components.esm.js"] },
    notes: [
      { title: "Outside the form", text: "Ontario's language toggle writes the page's <html lang> and tells every Ontario component on the page. The binding's notes list every side effect, measured." },
      { title: "Words", text: "English and French wording packs; the French wants a native reader's pass." },
      { title: "Host files", text: "The global stylesheet and the component library's script with its folders. The Ontario logo, the trillium favicon and the footer supergraphic are not served here." }
    ],
    network: []
  },
  {
    id: "fluent",
    name: "Fluent UI",
    by: "Microsoft",
    summary: "Microsoft's Fluent 2 as web components, the design system Teams draws with: themes are token sheets, no fonts.",
    lede: "Microsoft's Fluent 2 design system as web components, the design system Microsoft Teams draws with. Its elements define themselves when one script loads, and its look comes from tokens that a theme sets as custom properties.",
    site: "https://fluent2.microsoft.design/",
    pinned: "@fluentui/web-components 3.2.1, @fluentui/tokens 1.0.0-alpha.24",
    official: [
      "text and number (fluent-text-input, with a prefix and a suffix in its start and end slots), textarea, select (fluent-dropdown), radios, checkboxes, a single checkbox, button, each in a fluent-field",
      "tabs (fluent-tablist; the panels are Datum's)",
      "the host's receipt (fluent-message-bar), a journey page's heading and buttons"
    ],
    tier2: [
      "the date (three fluent-text-input boxes in a fieldset)",
      "fieldset and legend, the error summary (a message bar with the list of links), the language switcher, the required note, the character count and a field's notices"
    ],
    own: "Data grids, steps, files, signatures, button groups and chrome parts, tinted with Fluent's tokens.",
    host: { stylesheets: ["teams-light.css"], scripts: ["web-components.min.js"] },
    notes: [
      { title: "Themes are token sheets", text: "Fluent ships no stylesheet: a theme is a set of custom properties. Datum generates the sheets from the pinned tokens release (Teams light, dark and high contrast, and the web light and dark), and a host swaps the sheet to change the theme. A Teams tab maps the client's theme to the Teams sheets." },
      { title: "No fonts", text: "Fluent's type is a system font stack (Segoe UI, then the platform's own), so there is no font file to serve and nothing to license." },
      { title: "The design system's script", text: "One module defines every Fluent element when it loads, and each upgrades inside the form's shadow root. The binding starts nothing else; the binding's notes list what the script does outside the form." },
      { title: "One release per page", text: "Web components register once per page, so a page that draws forms with this binding serves one release of the design system to every form on it." }
    ],
    network: []
  }
];

export interface DatumTheme {
  numbers: TestNumbers;
}

const measured = facts as unknown as Record<string, TestNumbers & Partial<BindingNumbers>>;

/** What `kit:check --binding datum` measured for Datum's own binding. */
export const datumNumbers: TestNumbers = measured.datum!;

/** What `kit:check` measured for a reference binding. */
export function numbersOf(id: string): BindingNumbers {
  const entry = measured[id];
  if (entry === undefined || entry.equality === undefined) throw new Error(`no measured numbers for the binding "${id}"`);
  return entry as BindingNumbers;
}

export function bindingById(id: string): ReferenceBinding | undefined {
  return referenceBindings.find((binding) => binding.id === id);
}
