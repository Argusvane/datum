// The site's one content source. The features page shows every capability with its detail, in
// this order (fixed by the product owner); the home page's Overview section draws on
// `advantages` and links to the features page. Copy names requirements, never audiences.

/** The repository. */
export const GITHUB_URL = "https://github.com/argusvane/datum";

export interface Pillar {
  /** Anchor id on the features page. */
  id: string;
  title: string;
  /** One sentence: what the capability is. */
  blurb: string;
  /** Four to six specifics, each a short line. The facts of the former detail paragraphs, kept. */
  points: string[];
}

export const pillars: Pillar[] = [
  {
    id: "builder",
    title: "Builder",
    blurb: "WYSIWYG through the real renderer: nothing renders in the builder that the form will not.",
    points: [
      "Six workspaces: Form, Logic, Data, Languages, Journeys and PDF, each with the tools for that part of the work",
      "A canvas you edit by mouse or keyboard: a click selects, one bar moves, copies and deletes, Try it runs the form",
      "Edits go into a draft and apply as one undo step; Discard throws them away",
      "Logic lists every rule as a sentence, with an editor and Try it beside it, and flags rules that undo each other",
      "Data shows every answer as a table: where it is saved, its kind, whether it is required",
      "Journeys and PDF each open on a list of their own: the journeys with what each asks, the layouts in the order they are tried",
      "A command palette: Ctrl+K, type, Enter",
      "The form is one JSON file you keep in your own repository"
    ]
  },
  {
    id: "rules",
    title: "Rules engine",
    blurb: "Declarative rules for visibility, required, enabled, read-only, calculations, defaults and navigation. The same result on every runtime.",
    points: [
      "Rules are data on the definition, written as formulas: if/then/else, functions and dates against a day the host supplies",
      "Each rule runs in the browser, on the server, or on the server only, with the public copy a host serves leaving the private ones out",
      "Plugins add formula functions of their own, and a host can inspect a definition's formulas before it serves them",
      "Eight kinds: visible, required, enabled, read-only, calculated value, default, filter, navigation gating",
      "Field constraints: required, pattern and length; size and type on uploads",
      "A hidden-value policy per field: excluded, cleared or retained",
      "Your own validation stages, deterministic or asynchronous; deterministic ones run first",
      "The browser, the sandbox and the server compute the same state from the same input"
    ]
  },
  {
    id: "tests",
    title: "Form tests",
    blurb: "A test is a short scenario in plain words, kept with the form: set some answers, press Continue or Submit, and say what must then be true.",
    points: [
      "Expect a field shown or required, a value, an error by code, the page reached, a verdict, an answer withheld",
      "Written in the Tests panel, or recorded from Try it, where each answer and press becomes a line",
      "Runs as you edit: a broken rule fails a test within a moment, and Show me replays it on the form",
      "Each rule a test can pin lists the tests that pin it; Write a test drafts scenarios from its condition",
      "Each scenario plays on the browser's runtime and on the server's kernel; a difference between the two is a finding of its own",
      "The command writes a Markdown, JSON or JUnit report; a vitest helper runs the suite inside your own tests",
      "A server can run the suite through the sandbox's test op",
      "Renaming a field, a page or a journey rewrites the tests; the copy a browser is served carries none of them"
    ]
  },
  {
    id: "renderer",
    title: "Renderer",
    blurb: "Takes a definition and renders it on any page, in Datum's look or a design system's, in the host's locale, with the rules applied as the person types.",
    points: [
      "A definition as a URL, a JSON attribute or a property",
      "Layout containers: grid, panels, tabs, steps and data scoping",
      "Values in and out as a property; settled changes, validation and the submission as events",
      "Drafts save as the person types: browser storage, your server, or a file they keep",
      "Submit validates first and produces the canonical envelope",
      "The same renderer draws the builder's canvas, the read-only rendition and the printed page"
    ]
  },
  {
    id: "sandbox",
    title: "WASM sandbox",
    blurb: "One portable kernel, byte-identical in the browser and in any host that runs WASM. The same answer in every runtime, every time.",
    points: [
      "Every submission validated and sanitized on your server before it is kept, and refused when a check cannot run",
      "A rule has nothing to reach: no network, no filesystem, no process, no clock",
      "A versioned host ABI with memory, stack and time limits",
      "The same program runs in the page while you develop and test",
      "Any host that runs WASM; worked examples for Node.js, Java, .NET and Python",
      "The sandbox fetches nothing from the network, so it runs air-gapped"
    ]
  },
  {
    id: "customization",
    title: "Customization",
    blurb: "Datum's look as tokens with enforced CSS isolation, bindings that draw a form in a design system's own markup, your own component types, and plugins that add hooks and handlers.",
    points: [
      "Datum's own look is tokens plus a stylesheet scoped under the form's root, so nothing leaks into the page",
      "Nine reference bindings draw a form in a design system's own markup: GC Design System, GOV.UK, USWDS, Bootstrap 5, Nova Scotia, Alberta, Québec, Ontario and Fluent UI. They are starting points, not official themes",
      "Your own component type: its renderer, property editors and PDF rendition, without touching the engine",
      "Plugins by version range: hooks, submission handlers, components, themes, sandbox modules",
      "The builder's own chrome takes an icon set, and a theme the host registers"
    ]
  },
  {
    id: "chrome",
    title: "Form chrome",
    blurb: "A header and footer around every form, set once by the host or written into the form itself, and a frame behind it.",
    points: [
      "Parts: an image, a heading, text, HTML, the form's title and description, the language switcher",
      "The host composes it once, as defaults or overrides; the author can write it into the form; neither is required",
      "Where both exist they merge, with one switcher",
      "Frames Datum's look draws: seamless in the page, outlined, paper, and any more a host defines",
      "Print strips the frame, so paper is the page"
    ]
  },
  {
    id: "embed",
    title: "Embeddable components",
    blurb: "The form and the builder as web components. One script tag, JSON attributes, no build step on the host page.",
    points: [
      "datum-form and datum-form-builder, as module and classic-script bundles with their stylesheets",
      "Point the element at a definition, name a binding and a locale, hand over data sources as plain lists",
      "Events: datum-submit, datum-change, datum-validated, datum-download, datum-print, datum-builder-change",
      "The sandbox, the PDF kernel and the page viewer are separate modules, fetched only when the form asks",
      "Any framework, or none, with TypeScript typings for the elements"
    ]
  },
  {
    id: "assistants",
    title: "Browser assistants",
    blurb: "A browser that supports WebMCP lets an assistant fill a form through tools the form registers itself, every change shown on the page and in the person's hands to stop or undo.",
    points: [
      "A form's tools: read the questions and answers, fill fields, add table rows, move between pages, check, switch the language, keep a draft, hand over a PDF, submit",
      "The builder's tools: read the form being built; add, change, move and remove components and rules; check it; write and run its tests; try it; manage languages, journeys and PDF layouts; save; each change is one step on Undo",
      "Opt-in: the agent word of features loads the tools, the author's Form settings choice and the host's agent-access (always enforces, definition follows the form, never forbids) decide whether they run",
      "The person stays in charge: every write is outlined and read out, can be undone, and never moves their page or the field they are typing in; longer work runs as a session with a Stop button; anything that leaves the page asks first",
      "No tool for signing, choosing a file or pressing Submit on a signed form; hidden answers are never shown; a form its author has not allowed answers agent-off, and describe_form says it is the person's to fill",
      "Page script gets the same tools and results through agentTools() and executeAgentTool(); datum-submit says which answers the assistant wrote, the page's account and not proof"
    ]
  },
  {
    id: "pdf",
    title: "PDF designer and generation",
    blurb: "PDF layouts designed in the same builder, or an existing PDF filled in. Generated in the browser or on the server, with identical bytes.",
    points: [
      "Named layouts per form, flowing or anchored, with embedded fonts and a theme of their own",
      "A layout chosen by the answers: each can carry a condition, and the first that matches is rendered",
      "Template fill: upload a PDF, map its fields, mark areas; Create form fields builds the form from it",
      "PDF/A 2b, 2u, 2a, 3b, 3u or 3a, checked against the reference validator; level a also checks the file is tagged",
      "Uploaded files ride inside the PDF as attachments, within a budget you set per layout",
      "Print a read-only form as it reads, or a live form by each field's print setting, tabs and steps laid flat; a download action saves the PDF"
    ]
  },
  {
    id: "signatures",
    title: "Signatures",
    blurb: "PAdES on the PDF, with the server's key or the person's own certificate. WebAuthn on the submission. Verified check by check.",
    points: [
      "Two calls: the kernel prepares the bytes, the host signs them; the private key never enters the sandbox",
      "The server signs with its own X.509 certificate",
      "A person signs through a local agent with a certificate of their own: a file on their machine, or a YubiKey",
      "The submission, the canonical JSON record of the answers, signed with a passkey or security key",
      "Verdicts itemised: digest, certificate binding, trust, validity at signing, timestamp, commitment"
    ]
  },
  {
    id: "submissions",
    title: "Submissions",
    blurb: "A host accepts what a form sends, validates it in the sandbox, keeps the record and answers with a receipt. Spring Boot and FastAPI hosts ship ready; any host that runs WASM can do the same.",
    points: [
      "Storage, PDF and keys are seams your host binds",
      "Validates what a form sends in the sandbox before keeping it: the fields the definition names, nothing else",
      "Every record names the form version it answers; the server accepts only versions it has registered",
      "A retry of the same attempt gets the first receipt, so a slow network never makes two records",
      "Renders and signs a PDF that carries its own record"
    ]
  },
  {
    id: "data",
    title: "Data sources",
    blurb: "Inline options, host-defined sources or provider-registered sources: one resolution path for every select, radio and checkbox group.",
    points: [
      "Options typed in the builder, with a label per locale",
      "Sources a host defines when wiring the form",
      "Providers registered on the runtime",
      "Client and server providers in separate runtimes, so a source that must not run in the browser never does"
    ]
  },
  {
    id: "l10n",
    title: "Localization",
    blurb: "Locale is runtime state. Switching never resets answers, the submission records its language, and every text is a localized value.",
    points: [
      "Labels, descriptions, placeholders, tooltips, messages and options: a default plus translations per locale",
      "One translations grid per component in the builder, keyed into an external catalog when you have one",
      "Supported locales enforced; direction follows the locale, right to left included",
      "Drafts and the submission record their locale",
      "Accessible semantics in Datum's own look: ARIA wiring, an error summary, first-error focus, keyboard navigation, checked by automated tools only. A design-system binding draws its own markup and keeps its own accessibility"
    ]
  },
  {
    id: "ops",
    title: "Compatibility",
    blurb: "Definitions, drafts and submissions carry the versions they were made with, so a form can change and what was saved can still be read.",
    points: [
      "What the sandbox logged while validating a submission comes back with the verdict, for your own log",
      "A definition, a draft and a submission each record the versions they were made with",
      "A draft is checked for compatibility before it is restored",
      "Version ranges say what still fits"
    ]
  }
];

/** Where a visitor writes: general enquiries, and commercial support and services from Argusvane. */
export const CONTACT_EMAIL = "contact@argusvane.com";

/**
 * The home page's live demo: the real builder over the real form, from the bundles
 * copied beside the site at build time. The section head and lede are in index.html like the
 * other sections'; this is what the demo's own controls and messages say.
 */
export interface DemoChoice {
  id: string;
  label: string;
}

export const demo = {
  sheetLabel: "The form, as the builder left it",
  /** The example forms (src/demo-forms.ts), simplest first, picked above the builder. */
  exampleLabel: "Example",
  /** The renderer's tabs: the form, what it holds, and what the builder authored. */
  tabs: { form: "Form", data: "Data", schema: "Schema" },
  dataLabels: { values: "Values, as you type", submission: "Submission, as sent" },
  reset: "Reset",
  /** The browser's print dialog with the form's read-only rendition, from a frame the element writes itself. */
  print: "Print",
  preview: { label: "PDF", title: "The PDF, as rendered", close: "Close", page: "page", pages: "pages" },
  /** The host's chrome on the rendered form (header and footer parts, the frame), as a page would set it. */
  chrome: {
    label: "Form chrome",
    logo: "Logo",
    title: "Form title",
    description: "Description",
    switcher: "Language switcher",
    switcherOptions: { header: "In the header", footer: "In the footer", none: "None" },
    footer: "Footer note",
    footerText: { default: "Nothing leaves this page.", locales: { "fr-CA": "Rien ne quitte cette page." } },
    frame: "Frame",
    frames: { seamless: "Seamless", outlined: "Outlined", paper: "Paper" }
  },
  /** Shown when the bundles are not beside the site (a checkout that never built them). */
  fallback:
    "The live demo loads the bundles this site is built beside, and they are not here. The docs have the snippet and the files to host.",
  accepted: {
    title: "Accepted",
    detail: "Nothing was sent: this page has no server. On your own page, the submission goes wherever you run."
  }
};

/**
 * The partners page: the three ways Datum reaches people, by what they do with it rather than by
 * sector. The hero's rows on the home page carry the same labels and link to each block by id.
 * No programme terms (tiers, discounts, certification, response times): there is no programme, only
 * the code, and commercial support and services from Argusvane.
 */
export interface PartnerRoute {
  /** The block's id, which the hero's row links to: `partners.html#run`. */
  id: "run" | "embed" | "deliver";
  /** The mono label, the same words as the hero's row. */
  label: string;
  title: string;
  who: string;
  today: string;
  /** The figures behind "Today": a topic of the home page's "By the numbers", linked under it. */
  evidence: { label: string; topic: string };
  gives: string[];
  /** "contact" and "github" become the addresses main.ts fills; anything else is a relative href. */
  start: Array<{ label: string; href: string }>;
}

export const partnerLabels = {
  who: "Who",
  today: "Today",
  gives: "What Datum gives them",
  start: "Start here"
};

export const partners: PartnerRoute[] = [
  {
    id: "run",
    label: "Run it",
    title: "Your forms, in your environment.",
    who: "Organizations that run their own forms, hundreds or thousands of them, whose records must stay where they keep them: the team that builds and hosts the forms, and the people who answer for the records.",
    today: "Fillable PDFs and paper, a hosted form tool the data is not allowed to reach, or a plan to build a form builder of their own.",
    evidence: { label: "Form sprawl, in figures", topic: "problem" },
    gives: [
      "A builder staff design forms in, with the PDF layout beside the form",
      "A fillable PDF turned into a form in one step, and the original PDF still filled",
      "The form on your own pages, in your design system and your languages",
      "Every submission validated in a WASM sandbox on your own server",
      "PDF/A records with the answers and the uploaded files inside",
      "PAdES signatures on the PDF, a passkey on the submission",
      "All of it air-gapped, or in the browser with no server at all"
    ],
    start: [
      { label: "Try it", href: "./#demo" },
      { label: "Docs", href: "./docs/getting-started" }
    ]
  },
  {
    id: "embed",
    label: "Embed it",
    title: "A form builder inside your product.",
    who: "Software teams whose customers configure their own forms: case management, grants, permits and licences, intake, claims, onboarding, enrolment, procurement.",
    today: "A form builder of their own to maintain, next to the product they actually sell.",
    evidence: { label: "Others who built their own", topic: "landscape" },
    gives: [
      "The builder as one web component, with a filtered palette and your own themes",
      "The renderer as another, in any framework, with no build step",
      "The server contract on your stack: any host that runs WASM, such as Node.js, Java, .NET or Python",
      "PDF design, generation and signing in the same repository",
      "Your own component types and bindings, added by the host without touching the engine",
      "MIT: no royalty, no licence key, nothing to relicense per customer"
    ],
    start: [
      { label: "Live examples", href: "./docs/examples" },
      { label: "Docs", href: "./docs/getting-started" }
    ]
  },
  {
    id: "deliver",
    label: "Deliver it",
    title: "One forms layer for every client.",
    who: "Integrators and agencies who build services for clients, and the teams who host and run them.",
    today: "A forms layer rebuilt, or bought again, for each engagement.",
    evidence: { label: "Why now, in figures", topic: "now" },
    gives: [
      "The same MIT code on every project, with nothing to relicense per client",
      "Each client's design system as a binding that draws inside the form, so it never leaks into their page",
      "Custom bindings and component types as packages you carry from project to project",
      "Every asset ships as a file, so a client's site can run it air-gapped",
      "Commercial support and services from Argusvane, for the bindings, components and integrations a client needs"
    ],
    start: [
      { label: "Live examples", href: "./docs/examples" },
      { label: "Write to us", href: "contact" }
    ]
  }
];

/** The partners page's "Works with" cells: standards, never companies, so no partnership is implied. */
export const partnerStandards: Array<{ label: string; title: string; text: string }> = [
  {
    label: "X.509 · PAdES",
    title: "Certificates people already hold",
    text: "PDFs signed with the person's own certificate, a file on their machine or a YubiKey, or with the server's. A YubiKey is not required."
  },
  {
    label: "WebAuthn",
    title: "Passkeys and security keys",
    text: "The submission, the canonical JSON record of the answers, signed with a passkey or a security key and verified on the server."
  },
  {
    label: "PDF/A",
    title: "Records for the archive",
    text: "PDF/A-2 and PDF/A-3, checked against the reference validator, with the record and the uploads inside under part 3."
  },
  {
    label: "Web components",
    title: "Any framework, or none",
    text: "Two custom elements, the builder and the form, on any page, with one script tag and no build step."
  },
  {
    label: "WebAssembly",
    title: "Any host that runs WASM",
    text: "Validation and PDF generation run on your server's WASM runtime, in Node.js, Java, .NET or Python for example, or in the browser alone."
  }
];

/**
 * The home page's "Overview" section: the problems a sprawl of forms causes, each with what Datum
 * does about it. The text names the problem first, then the answer. One section replaces the
 * former assurance strip, "How it works" and "Why Datum".
 */
export interface Advantage {
  /** What the cell is about, as a mono label: Change, Embed, Outputs… */
  label: string;
  title: string;
  text: string;
}

export const advantages: Advantage[] = [
  {
    label: "Change",
    title: "Change a field once, every version follows",
    text: "The web form, the PDF and the paper copy drift apart, and one wording change becomes a project. Here they are one JSON definition: fields, rules, translations and PDF layouts, designed in one builder and kept as a file of your own."
  },
  {
    label: "Embed",
    title: "The same form on any page",
    text: "Nothing is rebuilt for each website or app. Two web components, any framework, no build step. A binding draws the form in your design system's own markup, and your header, footer and logo go on every form."
  },
  {
    label: "Outputs",
    title: "Print and PDF as outputs, not exports",
    text: "A PDF from a layout you designed, or the PDF you already have filled in; a printed page in the form's look; PDF/A 2b to 3a, tagged at level a, with the record and the uploads inside, checked against the reference validator."
  },
  {
    label: "Rules",
    title: "The same rules wherever the form runs",
    text: "When the page and the back office check answers their own way, they disagree. Here the rules are data in the definition: the page applies them as the person types, and a sandbox on your server checks every answer against the same rules. A plain-words test fails the day a rule stops doing its job."
  },
  {
    label: "Signatures",
    title: "Signatures that hold up",
    text: "PAdES on the PDF with the server's key or the person's own certificate, a file or a YubiKey; WebAuthn on the submission; and every check reported on its own, so an auditor sees exactly what passed."
  },
  {
    label: "Traceable",
    title: "Every record names its exact form",
    text: "Which version of the form did this person answer? Your server knows: it registers each form by id and version, accepts a submission only for a version it has, and keeps the record under it."
  },
  {
    label: "Environment",
    title: "Your environment, or no server",
    text: "The browser alone, or any host that runs WASM, such as Node.js, Java, .NET or Python. Every asset ships as a file and Datum fetches nothing from a third party, so it runs air-gapped, and a person can download the signed PDF and email it."
  },
  {
    label: "Access",
    title: "Fix it once, for every form",
    text: "Audited form by form, accessibility gets fixed form by form. Here every form shares its components and its look, so a fix to one of Datum's components lands on all of them at once. Every text comes per locale, and switching language keeps every answer."
  }
];

/**
 * The home page's "By the numbers" section under the hero: the case for Datum in figures others
 * have published, each beside what Datum does about it, filtered by topic and shown six at a
 * time. The topics read like a pitch (the problem, who needs it, why now) and then by subject.
 * Figures and wording are checked against the sources named in each entry; change a figure
 * only with the source open. A source is a government or standards body, a statistics office,
 * an academic or professional study (an audit or consulting firm's published survey counts,
 * a trade body's or a vendor's press release about its own members or product does not), or an
 * established independent research body, read at its own page. A figure from a vendor's study or
 * marketing page, from a magazine's report of another firm's survey, from a wiki, a news
 * report on someone else's figure or a community list is not used, and nor is one more than fifteen years
 * old. A link that has gone is replaced by an archived copy (a web.archive.org address with the
 * `id_` flag, the file as it was captured) or the figure is dropped.
 */
export interface EvidenceTopic {
  id: string;
  label: string;
}

export const evidenceTopics: EvidenceTopic[] = [
  { id: "problem", label: "Form sprawl" },
  { id: "market", label: "Who needs it" },
  { id: "now", label: "Why now" },
  { id: "landscape", label: "Others build their own" },
  { id: "count", label: "Number of forms" },
  { id: "pdf-html", label: "PDF vs HTML" },
  { id: "pdfa", label: "PDF/A" },
  { id: "data", label: "Data" },
  { id: "signatures", label: "Signatures" },
  { id: "passkeys", label: "Passkeys" },
  { id: "yubikey", label: "YubiKey" },
  { id: "accessibility", label: "Accessibility" }
];

/**
 * Sectors, chosen from a dropdown beside the topic chips. A finding carries sector ids in the
 * same `topics` list as its topic ids; the two filters combine, so "The problem" in "Tax" shows
 * findings tagged with both.
 */
export const evidenceSectors: EvidenceTopic[] = [
  { id: "government", label: "Government" },
  { id: "corporate", label: "Corporate" },
  { id: "employment", label: "Employment and HR" },
  { id: "procurement", label: "Procurement" },
  { id: "banking", label: "Banking and finance" },
  { id: "insurance", label: "Insurance" },
  { id: "healthcare", label: "Healthcare" },
  { id: "lifesciences", label: "Life sciences and clinical research" },
  { id: "education", label: "Education" },
  { id: "social", label: "Social services and benefits" },
  { id: "legal", label: "Courts and legal" },
  { id: "records", label: "Public records requests" },
  { id: "immigration", label: "Immigration" },
  { id: "tax", label: "Tax and revenue" },
  { id: "permits", label: "Permits and planning" },
  { id: "transport", label: "Transport and trade" },
  { id: "agriculture", label: "Agriculture" },
  { id: "realestate", label: "Real estate and mortgages" },
  { id: "nonprofit", label: "Nonprofit and humanitarian" },
  { id: "elections", label: "Elections" },
  { id: "defense", label: "Defense" },
  { id: "intelligence", label: "Intelligence" }
];

/**
 * Where a finding comes from, chosen from a second dropdown beside the sectors. United Kingdom
 * findings also carry "europe"; "global" is for studies that span countries (UN, IDC).
 */
export const evidenceRegions: EvidenceTopic[] = [
  { id: "canada", label: "Canada" },
  { id: "us", label: "United States" },
  { id: "uk", label: "United Kingdom" },
  { id: "europe", label: "Europe" },
  { id: "anz", label: "Australia and New Zealand" },
  { id: "asia", label: "Asia" },
  { id: "latam", label: "Latin America" },
  { id: "global", label: "Worldwide" }
];

export interface Evidence {
  /** The figure as it reads: "998", "68%", "10 weeks". */
  figure: string;
  /** What the figure counts, one sentence, in the source's terms. */
  claim: string;
  /** What Datum does about it. */
  answer: string;
  /** The study, as a short label ("IDC for Adobe · 2018") linking to the page or PDF the figure was read from. */
  source: { name: string; href: string };
  /** Topic ids from `evidenceTopics`; a finding may sit under several. */
  topics: string[];
}

/** What the section's own controls say. */
export const evidenceLabels = {
  all: "All",
  filters: "Topics",
  region: "Findings",
  previous: "Previous",
  next: "Next",
  showing: (from: number, to: number, total: number): string => `Showing ${from}–${to} of ${total}`,
  none: "Nothing matches this topic, sector and region yet.",
  sector: "Sector",
  allSectors: "All sectors",
  regionFilter: "Region",
  allRegions: "All regions"
};

/** In display order: the first six are what a visitor sees before filtering or scrolling. */
export const evidence: Evidence[] = [
  {
    figure: "$203 billion",
    claim: "Annual cost of answering US federal information collections, as the agencies themselves estimate it, across 188.8 billion responses.",
    answer:
      "The cost is per field, per response. A definition hides what does not apply, takes the values the host already holds, and asks once for the form, the PDF and the record.",
    source: { name: "reginfo.gov · 2026", href: "https://www.reginfo.gov/public/do/PRAReport?operation=11" },
    topics: ["government", "problem", "us"]
  },
  {
    figure: "2%",
    claim:
      "Of federal forms had been digitized, as a dynamic online form and not just a fillable PDF, the White House said as OMB's guidance arrived in September 2023.",
    answer:
      "A fillable PDF is half the job. Lay a Datum definition over the PDF you already have: the same form runs on a page and on a phone, and fills the PDF as well.",
    source: {
      name: "White House fact sheet · 2023",
      href: "https://bidenwhitehouse.archives.gov/omb/briefing-room/2023/09/22/fact-sheet-building-digital-experiences-for-the-american-people"
    },
    topics: ["now", "pdf-html", "government", "us"]
  },
  {
    figure: "40%",
    claim: "Of paper divorce applications in England and Wales were returned for errors, against under 1% of online ones, HM Courts & Tribunals Service reported.",
    answer:
      "Errors are cheaper to prevent than to return. Datum checks each answer as it is typed and again on the server, so an application arrives complete.",
    source: { name: "HMCTS · 2023", href: "https://insidehmcts.blog.gov.uk/2023/03/20/hmcts-reform-achievements-challenges-and-next-steps/" },
    topics: ["legal", "data", "government", "uk", "europe"]
  },
  {
    figure: "34%",
    claim: "Of the form inputs on the top million home pages have no proper label; 48% of those pages have at least one such input.",
    answer:
      "Every field carries its label, description and error message from the definition, and Datum's own look wires ARIA and moves focus to the first error. Its checks are automated only, no manual audit.",
    source: { name: "WebAIM Million · 2025", href: "https://webaim.org/projects/million/2025" },
    topics: ["accessibility", "global"]
  },
  {
    figure: "$1.1 billion",
    claim: "Projected 10-year cost of the SAAQ's CASA/SAAQclic program by 2027, against $638 million planned in 2017; people using its online services fell by more than a third after launch.",
    answer:
      "Big-bang platforms carry big-bang risk. Datum adds online forms one at a time, as files, alongside the systems and processes that an organization already runs.",
    source: {
      name: "Vérificateur général du Québec · 2025",
      href: "https://www.vgq.qc.ca/Fichiers/Publications/rapport-annuel/212/VGQ_Fevr2025_ch2_web.pdf"
    },
    topics: ["landscape", "problem", "transport", "government", "canada"]
  },
  {
    figure: "Under 2%",
    claim:
      "Of 1,348 federal forms ITIF sampled were fully web-based and usable on a phone, years after a law required it; 78% were at best fillable PDFs.",
    answer:
      "You do not choose between a web form and a PDF. One definition renders on any page and generates the PDF, or fills the one you already have.",
    source: { name: "ITIF · 2021", href: "https://itif.org/publications/2021/08/23/assessing-federal-governments-transition-web-based-forms/" },
    topics: ["now", "pdf-html", "government", "us"]
  },
  {
    figure: "11.5 billion",
    claim: "Hours a year the public spends answering the 10,786 information collections active across the US federal government.",
    answer:
      "Every field is a cost. A question appears only when a rule says it applies, a draft saves as they go and restores later, and switching language keeps every answer.",
    source: { name: "reginfo.gov · 2026", href: "https://www.reginfo.gov/public/do/PRAReport?operation=11" },
    topics: ["market", "count", "government", "us"]
  },
  {
    figure: "68%",
    claim: "Of the document-based forms on GOV.UK receive fewer than 10,000 submissions a year.",
    answer:
      "The long tail is where forms stay on paper. The builder makes a form without a developer, the renderer needs one script tag, and MIT means no licence per form or per seat.",
    source: { name: "Government Digital Service · 2021", href: "https://gds.blog.gov.uk/2021/07/06/making-all-forms-on-gov-uk-accessible-easy-to-use-and-quick-to-process/" },
    topics: ["problem", "pdf-html", "government", "uk", "europe"]
  },
  {
    figure: "8 minutes",
    claim: "Slower to process a document-based form than an online one, on average, across GOV.UK.",
    answer:
      "The online form and the document are the same definition. A record arrives as validated JSON, and the PDF, when you want one, is generated from it with the record inside.",
    source: { name: "Government Digital Service · 2021", href: "https://gds.blog.gov.uk/2021/07/06/making-all-forms-on-gov-uk-accessible-easy-to-use-and-quick-to-process/" },
    topics: ["pdf-html", "problem", "government", "uk", "europe"]
  },
  {
    figure: "≈10,000",
    claim: "Document-based forms on GOV.UK, a count growing by roughly 6% a year.",
    answer:
      "A form that is a file can be listed, searched and diffed, and every one renders through the same runtime, so a theme or a fix reaches all of them at once.",
    source: { name: "Government Digital Service · 2021", href: "https://gds.blog.gov.uk/2021/07/06/making-all-forms-on-gov-uk-accessible-easy-to-use-and-quick-to-process/" },
    topics: ["count", "market", "government", "uk", "europe"]
  },
  {
    figure: "32%",
    claim: "Error rate on paper surgical consent forms in a JAMA Surgery audit, against 1% for electronic consent; a missing consent delays surgery 17 minutes on average.",
    answer:
      "Required fields cannot be skipped, rules check the rest as the person types, and the consent is signed on the spot with a certificate or a passkey, then kept as PDF/A with the record inside.",
    source: { name: "JAMA Surgery · 2020", href: "https://jamanetwork.com/journals/jamasurgery/fullarticle/2765980" },
    topics: ["healthcare", "data", "signatures", "us"]
  },
  {
    figure: "44.3%",
    claim:
      "Of their research time on federally funded projects that 11,167 principal investigators said went to meeting administrative requirements, up from 42.3% in 2012.",
    answer:
      "Each requirement is a form someone fills. Values the institution already holds arrive filled, rules skip what does not apply, and a draft picks up where the researcher stopped.",
    source: { name: "Federal Demonstration Partnership · 2018", href: "https://thefdp.org/wp-content/uploads/FDP-FWS-2018-Primary-Report.pdf" },
    topics: ["education", "problem", "us"]
  },
  {
    figure: "11.1",
    claim: "Labels, on average, for the same field across 338 Florida State University forms: 4,323 labels reduce to 98 standard fields.",
    answer:
      "Make a shared field, a student number say, a component type of your own: registered once, it sits in the palette and arrives in every form with one label, format and rule.",
    source: { name: "FSU forms dashboard · 2026", href: "https://myweb.fsu.edu/jj22e/dashboard.html" },
    topics: ["education", "data", "count", "us"]
  },
  {
    figure: "66",
    claim: "Paper forms UC Berkeley analyzed and redesigned into 20 eForms, which have processed 176,275 submissions and automated over 100,000 enrollment changes.",
    answer:
      "Fewer forms, more paths: one definition carries the variants as rules and steps, and the same file renders on the page, prints and becomes the PDF.",
    source: { name: "UC Berkeley · 2020", href: "https://www.ucop.edu/information-technology-services/initiatives/sautter-award-program/sautter-2020/ucb-turning-policy-into-power.pdf" },
    topics: ["education", "count", "paper", "us"]
  },
  {
    figure: "3,178 days",
    claim: "Of staff time UC Berkeley counted as saved by its student and staff eForms, about $1.1 million in salaries, with 580,000 sheets of paper.",
    answer:
      "The saving starts at the form: a record that arrives complete and validated needs no retyping and no chasing, and a PDF with the record inside replaces the envelope.",
    source: { name: "UC Berkeley · 2020", href: "https://www.ucop.edu/information-technology-services/initiatives/sautter-award-program/sautter-2020/ucb-turning-policy-into-power.pdf" },
    topics: ["education", "now", "us"]
  },
  {
    figure: "April 2027",
    claim:
      "By then public schools, colleges and universities in jurisdictions of 50,000 or more must bring web content, documents included, to WCAG 2.1 AA under ADA Title II; smaller ones by April 2028.",
    answer:
      "Each field's label, description and error come from the definition, and PDF/A tagged at level a is an option for generated PDFs. A fix to a theme reaches every form that wears it. Datum's own look has automated checks only, no manual audit.",
    source: { name: "ADA.gov · 2026", href: "https://www.ada.gov/resources/2024-03-08-web-rule/" },
    topics: ["education", "government", "accessibility", "now", "us"]
  },
  {
    figure: "15 minutes",
    claim: "Most students and families now complete the redesigned federal student aid form, the FAFSA, in less than this, the Department of Education says.",
    answer:
      "Short is a design choice. One Datum definition holds every question, and each person sees only the ones their earlier answers call for, in their language, with a draft to come back to.",
    source: { name: "U.S. Department of Education", href: "https://www.ed.gov/higher-education/paying-college/better-fafsa" },
    topics: ["education", "government", "now", "social", "us"]
  },
  {
    figure: "3,896",
    claim: "Degree-granting colleges and universities in the United States in 2022–23: 1,599 public, 1,614 private nonprofit and 683 for-profit.",
    answer:
      "Each has admissions, registrar, financial-aid, HR and research forms of its own. Datum is MIT, runs in the institution's own environment, and a form needs one script tag on a page it already has.",
    source: { name: "NCES Digest of Education Statistics · 2023", href: "https://nces.ed.gov/programs/digest/d23/tables/dt23_317.10.asp" },
    topics: ["education", "market", "us"]
  },
  {
    figure: "98,577",
    claim: "Public schools in the United States in 2020–21, beside 30,492 private schools in 2019–20.",
    answer:
      "A school needs no server to start: a form published as a file renders on the school's page, a parent fills it on a phone and downloads the PDF, and a district server collects the records when there is one.",
    source: { name: "NCES Fast Facts", href: "https://nces.ed.gov/fastfacts/display.asp?id=84" },
    topics: ["education", "market", "us"]
  },
  {
    figure: "710,000",
    claim: "Background investigations pending across the government in February 2018, up from about 190,000 in 2014, as GAO put the clearance process on its High-Risk List.",
    answer:
      "Every investigation starts with a questionnaire. One that branches to what the position needs, checks answers as they are typed and hands over a validated record gives investigators a complete case.",
    source: { name: "GAO · 2018", href: "https://www.gao.gov/products/gao-18-431t" },
    topics: ["defense", "intelligence", "government", "problem", "us"]
  },
  {
    figure: "4",
    claim: "Vetting questionnaires, the SF 85, 85P, 85P-S and 86, folded into one Personnel Vetting Questionnaire in four parts; each person answers only the parts their position needs.",
    answer:
      "That is a Datum definition: one form, sections a rule shows when the position needs them, and one record out, validated again on the server.",
    source: {
      name: "Federal Register · 2022",
      href: "https://www.federalregister.gov/documents/2022/11/23/2022-25566/notice-of-submission-for-a-new-information-collection-common-form-personnel-vetting-questionnaire"
    },
    topics: ["defense", "intelligence", "government", "now", "us"]
  },
  {
    figure: "140",
    claim: "Minutes one person is estimated to spend completing the Personnel Vetting Questionnaire, the new common form for federal background investigations.",
    answer:
      "A long form needs a way back in. A Datum draft saves as the person goes, in the browser, on your server or as a file they keep, and is checked against the form's version before it is restored.",
    source: {
      name: "Federal Register · 2022",
      href: "https://www.federalregister.gov/documents/2022/11/23/2022-25566/notice-of-submission-for-a-new-information-collection-common-form-personnel-vetting-questionnaire"
    },
    topics: ["defense", "intelligence", "problem", "us"]
  },
  {
    figure: "4 million",
    claim: "People, 4,030,625 of them, eligible for access to classified information across the US government on 1 October 2017; 2.8 million were in access.",
    answer:
      "Every asset ships as a file and Datum fetches nothing from a third party, so the form, the validation sandbox and PDF signing run on an air-gapped network.",
    source: { name: "ODNI · 2018", href: "https://www.dni.gov/files/NCSC/documents/features/20180827-security-clearance-determinations.pdf" },
    topics: ["intelligence", "defense", "market", "us"]
  },
  {
    figure: "604,000",
    claim: "Unanswered requests for military service records at the National Personnel Records Center at the March 2022 peak; more than 5,000 new ones arrive each day.",
    answer:
      "The SF 180 request must be signed and dated. In Datum the request is signed with a passkey as it is sent and arrives as a complete record, not an envelope to open and key in.",
    source: { name: "National Archives · 2023", href: "https://www.archives.gov/files/foia/pdf/nara-ndaa-report-11-25-23.pdf" },
    topics: ["defense", "government", "paper", "signatures", "passkeys", "us"]
  },
  {
    figure: "177",
    claim: "UN member states, of 193, that let a company register a business online, the most common online transaction the UN tracks.",
    answer:
      "Every government is putting its forms online at once, in its own languages and design system. Datum is MIT, runs in each government's own environment and speaks each locale.",
    source: {
      name: "UN E-Government Survey · 2024",
      href: "https://desapublications.un.org/sites/default/files/publications/2024-09/(Chapter%202)%20E-Government%20Survey%202024%201392024.pdf"
    },
    topics: ["market", "government", "global"]
  },
  {
    figure: "36.7%",
    claim: "Of people in the EU downloaded or printed an official form in 2025, while 71.9% used a public authority's website or app: 98.0% in Denmark, 24.1% in Romania.",
    answer:
      "A form someone prints is a form not yet online. In Datum the same definition renders on the page, and prints or becomes a PDF only when a person wants paper.",
    source: { name: "Eurostat · 2026", href: "https://ec.europa.eu/eurostat/web/products-eurostat-news/w/ddn-20260312-1" },
    topics: ["pdf-html", "paper", "government", "europe"]
  },
  {
    figure: "71",
    claim: "Out of 100: the EU's score for pre-filled forms across 14,104 public-service websites checked in 2024, up less than a point in a year.",
    answer:
      "Prefilling is the host's call in Datum: set the values you already hold before the person starts, and they confirm what you know instead of typing it again.",
    source: { name: "eGovernment Benchmark · 2025", href: "https://www.capgemini.com/wp-content/uploads/2025/06/eGovernmentBenchmark-2025-Insight-Report.pdf" },
    topics: ["data", "government", "europe"]
  },
  {
    figure: "58%",
    claim: "Of EU public services a user from another member state can complete online, against 92% for national users; missing translation and national eIDs are the main barriers.",
    answer:
      "Every Datum text is per locale and switching language keeps every answer, so one definition serves each member state's users in their own language.",
    source: { name: "eGovernment Benchmark · 2025", href: "https://www.capgemini.com/wp-content/uploads/2025/06/eGovernmentBenchmark-2025-Insight-Report.pdf" },
    topics: ["government", "problem", "europe"]
  },
  {
    figure: "21",
    claim: "Procedures every EU member state had to put fully online by 12 December 2023, from vehicle registration to pension claims, under the Single Digital Gateway.",
    answer:
      "Fully online means start to finish: the form validates as it is filled, the submission is signed with a passkey, and a receipt and a PDF with the record inside come back.",
    source: { name: "EUR-Lex", href: "https://eur-lex.europa.eu/EN/legal-content/summary/the-single-digital-gateway.html" },
    topics: ["government", "now", "passkeys", "europe"]
  },
  {
    figure: "June 2025",
    claim: "When the European Accessibility Act began applying to banks, e-commerce, public transport and other services, for the EU's 100 million people with disabilities.",
    answer:
      "Each field's label, description and error come from the definition, and PDF/A tagged at level a is an option for the documents. Datum's own look has automated checks only, no manual audit.",
    source: { name: "AccessibleEU · 2025", href: "https://accessible-eu-centre.ec.europa.eu/content-corner/news/new-era-inclusion-begins-eaa-enters-force-2025-06-27_en" },
    topics: ["accessibility", "corporate", "now", "banking", "europe"]
  },
  {
    figure: "33",
    claim: "Of the 575 administrative services Germany's Online Access Act required online by the end of 2022 were available nationwide in October 2022.",
    answer:
      "A Datum form is a file, so one authority can build a service and every other can host the same definition in its own look, on its own server.",
    source: {
      name: "Nationaler Normenkontrollrat · 2023",
      href: "https://www.normenkontrollrat.bund.de/Webs/NKR/SharedDocs/Downloads/DE/Positionspapiere/ozg-positionspapier.pdf?__blob=publicationFile&v=14"
    },
    topics: ["government", "problem", "europe"]
  },
  {
    figure: "59,105",
    claim: "Procedures published on Démarche numérique, the French government's own form builder, formerly Démarches simplifiées, which has taken 22.1 million submissions.",
    answer:
      "Another government built its own. Datum offers the same self-service under MIT, in your environment, with the PDF, signatures and server contract included.",
    source: { name: "Démarche numérique · 2026", href: "https://demarche.numerique.gouv.fr/stats" },
    topics: ["landscape", "government", "now", "europe"]
  },
  {
    figure: "88.9%",
    claim: "Of households in England and Wales answered Census 2021 online; 97% of all households responded.",
    answer:
      "Online-first works when paper stays a choice: the same Datum form renders on any page and prints for anyone who asks for paper.",
    source: {
      name: "Office for National Statistics · 2023",
      href: "https://www.ons.gov.uk/peoplepopulationandcommunity/householdcharacteristics/homeinternetandsocialmediausage/articles/characteristicsofcensus2021respondentsbymodeofcompletionenglandandwales/2023-10-23"
    },
    topics: ["pdf-html", "government", "uk", "europe"]
  },
  {
    figure: "72%",
    claim: "Of New Zealand Traveller Declarations are now completed digitally; the one form for customs, biosecurity, immigration and health replaced the paper arrival card in 2023.",
    answer:
      "One definition can hold every agency's questions and rules, and each agency can take its own PDF layout from the same record.",
    source: { name: "NZ Digital Government Reset Plan · 2026", href: "https://www.publicservice.govt.nz/assets/DirectoryFile/Digital-Reset-Plan-2026.pdf" },
    topics: ["government", "paper", "immigration", "transport", "anz"]
  },
  {
    figure: "NZ$42m",
    claim: "A year New Zealand spends on a central digital function, while agency surveys show very low re-use of projects across agencies despite common needs.",
    answer:
      "Re-use needs something to hand over. A Datum form, binding or component type is a file one agency can give another, under MIT, with no licence to negotiate.",
    source: { name: "NZ Digital Government Reset Plan · 2026", href: "https://www.publicservice.govt.nz/assets/DirectoryFile/Digital-Reset-Plan-2026.pdf" },
    topics: ["government", "landscape", "anz"]
  },
  {
    figure: "75,085",
    claim: "Types of administrative procedure in Japan's national laws, counted by the Digital Agency in 2025 after generative AI found about 10,000 more; about half can be done online.",
    answer:
      "At that count a form has to be cheap to make. Each Datum form is one JSON file an agency builds in a browser, not a project.",
    source: {
      name: "Digital Agency, Japan · 2025",
      href: "https://www.digital.go.jp/assets/contents/node/basic_page/field_ref_resources/b931f8c1-8598-45ee-91b1-1e9a45acd301/5ae5d987/20250722_procedures-survey-results_outline_01.pdf"
    },
    topics: ["count", "government", "market", "asia"]
  },
  {
    figure: "104 million",
    claim: "My Number Cards held in Japan at the end of July 2026; more than 90 million holders, 91%, have registered theirs as their health insurance card.",
    answer:
      "Identity has gone digital; intake should follow. A Datum form takes the values the host already holds before the person starts, so no one retypes them.",
    source: { name: "Digital Agency, Japan · 2026", href: "https://www.digital.go.jp/en/policies/report-2026" },
    topics: ["government", "healthcare", "data", "asia"]
  },
  {
    figure: "41 million",
    claim: "Transactions a month on Singpass, Singapore's national digital identity, by 5 million users across more than 2,700 services from 800 agencies and businesses.",
    answer:
      "Behind each service sits a form. Datum makes each one a JSON file an agency builds in a browser, validated the same way in the page and on its server.",
    source: { name: "GovTech Singapore", href: "https://www.tech.gov.sg/products-and-services/for-citizens/digital-services/singpass/" },
    topics: ["market", "government", "asia"]
  },
  {
    figure: "Up to 80%",
    claim: "Less time to apply when Singapore's Myinfo fills a form with data the government already holds; businesses using it report approval rates up to 15% higher.",
    answer:
      "Prefilling is the host's call in Datum: set the values you already hold before the person starts, and they confirm rather than type.",
    source: { name: "MDDI Singapore · 2022", href: "https://www.mddi.gov.sg/newsroom/singpass-factsheet-02032022/" },
    topics: ["data", "government", "corporate", "asia"]
  },
  {
    figure: "16",
    claim: "Languages of the self-enumeration portal for Census 2027, India's first digital census, with validation checks built into its questions.",
    answer:
      "Every text in a Datum form is per locale in the definition, answers are checked as they are typed and on the server, and switching language keeps them.",
    source: {
      name: "PIB, Government of India · 2026",
      href: "https://static.pib.gov.in/WriteReadData/specificdocs/documents/2026/apr/doc2026425856601.pdf"
    },
    topics: ["government", "now", "pdf-html", "asia"]
  },
  {
    figure: "72.8 million",
    claim: "Income tax returns filed in India by the July 2024 deadline, a record; almost 7 million came in on the last day alone.",
    answer:
      "Deadline day is when validation must hold. Datum's validator runs the form's own rules on the server in a WASM sandbox, the same rules the page ran.",
    source: {
      name: "PIB, Government of India · 2025",
      href: "https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/sep/doc202597630001.pdf"
    },
    topics: ["tax", "government", "market", "asia"]
  },
  {
    figure: "5.4 hours",
    claim: "To complete one government transaction in Latin America and the Caribbean, on average; more than 11 in Bolivia and little more than two in Chile.",
    answer:
      "Hours go to trips, queues and missing stamps. A Datum form checks each answer as it is typed, keeps a draft, and arrives complete.",
    source: {
      name: "Inter-American Development Bank · 2018",
      href: "https://publications.iadb.org/en/wait-no-more-citizens-red-tape-and-digital-government"
    },
    topics: ["problem", "government", "latam"]
  },
  {
    figure: "74%",
    claim: "Less time taken by fully digital government transactions in Latin America and the Caribbean than by face-to-face ones.",
    answer:
      "The saving comes from going fully digital, not from scanning paper. One Datum definition renders online, validates on the server and still prints.",
    source: {
      name: "Inter-American Development Bank · 2018",
      href: "https://publications.iadb.org/en/wait-no-more-citizens-red-tape-and-digital-government"
    },
    topics: ["pdf-html", "government", "now", "latam"]
  },
  {
    figure: "4.3%",
    claim: "Of GDP: the administrative and opportunity cost of government transactions in Mexico in 2012; simplifying and digitizing them cut it to 2.7% by 2017.",
    answer:
      "Simpler forms are cheaper for everyone who fills them. Datum hides questions that do not apply, checks answers as they are typed and keeps a draft.",
    source: {
      name: "Inter-American Development Bank · 2018",
      href: "https://publications.iadb.org/en/wait-no-more-citizens-red-tape-and-digital-government"
    },
    topics: ["problem", "government", "now", "latam"]
  },
  {
    figure: "93%",
    claim: "Of Uruguay's state services can be completed fully online, and all of them can be started online, after its 2015–2020 online procedures program.",
    answer:
      "Finishing online means the signature and the record too. A Datum form validates in the browser, is signed with a passkey and arrives checked by the server.",
    source: {
      name: "AGESIC, Uruguay",
      href: "https://www.gub.uy/agencia-gobierno-electronico-sociedad-informacion-conocimiento/politicas-y-gestion/programas/que-es-el-programa-tramites-en-linea"
    },
    topics: ["pdf-html", "government", "latam"]
  },
  {
    figure: "3,683",
    claim: "Procedures in Chile's national registry across 217 institutions; 89% were digital by July 2023, and its digital transformation law's final deadline is the end of 2027.",
    answer:
      "A deadline with thousands of forms behind it. Each Datum form is a file an agency builds in a browser and validates the same way on its servers.",
    source: {
      name: "Library of the National Congress of Chile · 2024",
      href: "https://obtienearchivo.bcn.cl/obtienearchivo?id=repositorio%2F10221%2F36014%2F1%2FBCN_tramites_servicios_publicos_def.pdf"
    },
    topics: ["count", "government", "now", "latam"]
  },
  {
    figure: "59.8%",
    claim: "Of Brazil's 44.3 million income tax returns in 2026, a record, used the pre-filled return, the highest share yet.",
    answer:
      "Offer the data and people use it. Datum takes the values a host already holds before the person starts, and they check rather than type.",
    source: {
      name: "Agência Gov · 2026",
      href: "https://agenciagov.ebc.com.br/noticias/202606/entrega-de-declaracoes-do-imposto-de-renda-em-2026-registra-recorde-com-o-total-de-44-3-milhoes"
    },
    topics: ["tax", "data", "government", "latam"]
  },
  {
    figure: "1.9 million",
    claim: "Public-school seniors Brazil pre-registered for the 2025 ENEM, its national exam for university entry; 72.6% confirmed, and registrations rose 11% overall.",
    answer:
      "A pre-filled form becomes a confirmation. Datum takes the values a host already holds, and the person checks them and submits.",
    source: {
      name: "Agência Gov, via MEC · 2025",
      href: "https://agenciagov.ebc.com.br/noticias/202507/enem-2025-tem-mais-de-4-8-milhoes-de-inscritos-confirmados"
    },
    topics: ["education", "data", "government", "latam"]
  },
  {
    figure: "99.4%",
    claim: "Of new court cases in Brazil were filed electronically in 2024, up from 11.2% in 2009; 94.8% of pending cases now proceed electronically.",
    answer:
      "Courts can go almost fully electronic. A Datum filing arrives as a validated record with its documents inside a PDF/A, ready for the case file.",
    source: { name: "CNJ, Justiça em Números · 2025", href: "https://www.cnj.jus.br/wp-content/uploads/2025/11/justica-em-numeros-2025.pdf" },
    topics: ["legal", "pdf-html", "government", "pdfa", "latam"]
  },
  {
    figure: "2.9%",
    claim: "Of Brazil's 26.3 million active websites passed every accessibility test in 2024, down from 3.3% in 2023, in a BigDataCorp and Web para Todos study.",
    answer:
      "Every field carries its label, description and error message from the definition, and Datum's own look moves focus to the first error. Its checks are automated only, no manual audit.",
    source: {
      name: "Movimento Web para Todos · 2024",
      href: "https://mwpt.com.br/apenas-29-dos-sites-brasileiros-foram-aprovados-em-todos-os-testes-de-acessibilidade-aponta-pesquisa/"
    },
    topics: ["accessibility", "problem", "latam"]
  },
  {
    figure: "10.3 billion",
    claim: "Electronic invoices issued in Mexico in 2023, an average of 327 a second, as 758,369 more taxpayers began issuing them.",
    answer:
      "When the document is data, it can be checked at any scale. A Datum record is JSON validated against its definition, and its PDF is generated from it.",
    source: {
      name: "SAT, Mexico · 2024",
      href: "https://www.gob.mx/sat/prensa/contribuyentes-emiten-mas-de-10-mil-millones-de-facturas-electronicas-en-2023-018-2024"
    },
    topics: ["tax", "corporate", "data", "latam"]
  },
  {
    figure: "69%",
    claim: "Of the 25 million people dropped from Medicaid in the 2023–24 renewals lost coverage for paperwork or procedural reasons, not because they were found ineligible.",
    answer:
      "Renewal is a form. Datum can open it with what the agency already holds, show only what changed, keep a draft and speak the person's language.",
    source: { name: "KFF · 2024", href: "https://www.kff.org/medicaid/medicaid-enrollment-and-unwinding-tracker/" },
    topics: ["social", "healthcare", "government", "problem", "us"]
  },
  {
    figure: "92%",
    claim: "Of the civil legal problems low-income Americans face get no or not enough legal help; 74% of low-income households had at least one in the past year.",
    answer:
      "Most people meet the court through a form, often without a lawyer. Help text per field, rules that skip what does not apply and a draft to return to carry them further.",
    source: { name: "Legal Services Corporation · 2022", href: "https://justicegap.lsc.gov/resource/executive-summary/" },
    topics: ["legal", "problem", "market", "us"]
  },
  {
    figure: "10.9 million",
    claim: "Filings USCIS received in fiscal 2023, a record; it completed more than 10 million cases and cut its backlog by 15%.",
    answer:
      "At that volume every incomplete application costs a review. Datum validates as the form is filled and again on the server, with uploads carried inside the PDF record.",
    source: { name: "USCIS · 2023", href: "https://www.uscis.gov/EOY2023" },
    topics: ["immigration", "government", "market", "us"]
  },
  {
    figure: "97.25%",
    claim: "Of UK Self Assessment returns for 2024–25 were filed online, 11.2 million of them; 316,000 still came in on paper.",
    answer:
      "Paper holds on at the edges. The same Datum form renders online and prints for the few who need paper, with the same fields and rules either way.",
    source: { name: "HMRC · 2026", href: "https://www.gov.uk/government/news/1148-million-beat-the-self-assessment-deadline" },
    topics: ["tax", "pdf-html", "government", "uk", "europe"]
  },
  {
    figure: "38.2%",
    claim: "Of people in the EU submitted a tax declaration online in 2025, while 71.9% used a public authority's website or app.",
    answer:
      "A tax return is the form most people meet every year. Datum's rules total figures as they are typed, and the record arrives ready to check against the definition.",
    source: { name: "Eurostat · 2026", href: "https://ec.europa.eu/eurostat/web/products-eurostat-news/w/ddn-20260312-1" },
    topics: ["tax", "government", "europe"]
  },
  {
    figure: "NZ$1.5B",
    claim: "New Zealand Inland Revenue's multi-year overhaul, which moved it to pre-populated data and retired over 400 legacy applications.",
    answer:
      "Pre-population was the prize. Datum takes the values a host already holds before the person starts, with no platform rebuild behind it.",
    source: { name: "NZ Digital Government Reset Plan · 2026", href: "https://www.publicservice.govt.nz/assets/DirectoryFile/Digital-Reset-Plan-2026.pdf" },
    topics: ["tax", "government", "data", "anz"]
  },
  {
    figure: "50%",
    claim: "Of planning applications councils receive are invalid, found five English councils in a government-funded project to reduce them.",
    answer:
      "Invalid means incomplete. Datum requires the right answers and uploads before submit, checks them as they are typed, and validates again on the server.",
    source: { name: "Local Digital · 2020", href: "https://www.localdigital.gov.uk/funded-project/reducing-invalid-planning-applications/" },
    topics: ["permits", "problem", "government", "uk", "europe"]
  },
  {
    figure: "16",
    claim: "Planning authorities using PlanX, the application service councils co-designed, with government funding for 23 more to adopt it.",
    answer:
      "Councils built a shared tool because every authority needs the same forms. Datum offers that for any service: a form is a file one council hands the next.",
    source: {
      name: "MHCLG Digital · 2026",
      href: "https://mhclgdigital.blog.gov.uk/2026/03/23/transforming-planning-with-planx-and-new-funding-to-help-local-planning-authorities-reap-the-rewards/"
    },
    topics: ["permits", "landscape", "government", "uk", "europe"]
  },
  {
    figure: "July 2027",
    claim: "When authorities in every EU member state must accept freight transport information electronically, across road, rail, inland waterway and air.",
    answer:
      "Freight paperwork becomes data. A Datum record is structured JSON validated against its definition, and a PDF, where one is still needed, is generated from it.",
    source: { name: "European Commission", href: "https://transport.ec.europa.eu/transport-themes/logistics-and-multimodal-transport/efti-regulation_en" },
    topics: ["transport", "now", "government", "europe"]
  },
  {
    figure: "31,704",
    claim: "Administrative requirements Transport Canada's regulations place on business in 2025, 15,414 of them in the Transportation Information Regulations.",
    answer:
      "Each requirement is a field someone fills. One definition per report, validated the same in the page and on the server, keeps every filing consistent.",
    source: { name: "Transport Canada · 2025", href: "https://tc.canada.ca/en/corporate-services/acts-regulations/administrative-burden-baseline-2025" },
    topics: ["transport", "government", "count", "canada"]
  },
  {
    figure: "4",
    claim: "Overlapping federal mortgage disclosures the CFPB merged into two, the Loan Estimate and Closing Disclosure, after more than 30 years of overlapping forms.",
    answer:
      "Consolidation is a definition change: one form, sections by loan type, and each PDF layout generated from the same record.",
    source: { name: "CFPB · 2013", href: "https://www.consumerfinance.gov/archive/newsroom/cfpb-finalizes-know-before-you-owe-mortgage-forms/" },
    topics: ["realestate", "government", "count", "us"]
  },
  {
    figure: "47",
    claim: "States with a law allowing remote electronic notarization, plus Washington, D.C., the National Association of Secretaries of State reports.",
    answer:
      "Once the notary can be remote, the paperwork must be too. Datum signs the PDF with the person's own certificate and the submission with a passkey.",
    source: { name: "NASS", href: "https://www.nass.org/initiatives/remote-electronic-notarization" },
    topics: ["realestate", "signatures", "now", "us"]
  },
  {
    figure: "11,000",
    claim: "Competitive research and education awards the US National Science Foundation funds in a typical year, from proposals reviewed by about 50,000 scientists, engineers and educators.",
    answer:
      "A grant application is a long form with a budget. Datum's rules total the budget as it is typed, steps break it up, and a draft keeps it safe for weeks.",
    source: { name: "NSF", href: "https://www.nsf.gov/about" },
    topics: ["nonprofit", "education", "government", "us"]
  },
  {
    figure: "42",
    claim: "States offering online voter registration, plus Washington, D.C., Guam and the Virgin Islands; the signature on file with the state becomes the voting signature.",
    answer:
      "Registration is a form with strict rules. Datum validates each answer against the definition in the page and again on the server, so every record has the same shape.",
    source: { name: "NCSL · 2026", href: "https://www.ncsl.org/elections-and-campaigns/online-voter-registration" },
    topics: ["elections", "government", "us"]
  },
  {
    figure: "103 million",
    claim: "Voter registration transactions US election offices processed between the 2022 and 2024 general elections; motor vehicle offices and automatic registration made up almost 60%.",
    answer:
      "Every one is a record to validate. One definition checks each the same way, whichever office or channel it came from.",
    source: { name: "U.S. Election Assistance Commission · 2025", href: "https://www.eac.gov/sites/default/files/2025-07/2024_EAVS_Report_508.pdf" },
    topics: ["elections", "government", "market", "us"]
  },
  {
    figure: "62 million",
    claim: "Form I-9s US employers complete a year, USCIS estimates, one for every person hired; the paperwork takes about 35.7 million hours in all.",
    answer:
      "Every hire fills the same form. One Datum definition checks each answer as it is typed and again on the server, so an error is caught while the person is still there.",
    source: {
      name: "USCIS, Federal Register · 2026",
      href: "https://www.federalregister.gov/documents/2026/05/18/2026-09846/agency-information-collection-activities-extension-without-change-of-a-currently-approved-collection"
    },
    topics: ["employment", "government", "market", "problem", "us"]
  },
  {
    figure: "12 million",
    claim: "Records of Employment Canadian employers issued in 2024–25, 98.2% electronically; missing or late ones need an officer's intervention about 68,500 times a year.",
    answer:
      "Going electronic was the easy part. Datum checks each record as it is filled and again on the server, so it arrives complete the first time.",
    source: {
      name: "ESDC · 2026",
      href: "https://www.canada.ca/en/employment-social-development/programs/ei/ei-list/reports/monitoring2025/chapter4.html"
    },
    topics: ["employment", "pdf-html", "government", "canada"]
  },
  {
    figure: "5.6 million",
    claim: "Portable Documents A1, the social security certificate for posted workers, issued in the EU, EFTA and UK in 2024; EU law requires that it can be applied for fully online.",
    answer:
      "One application, many countries and languages. A Datum definition keeps every text per locale and validates the same way wherever it is filled.",
    source: {
      name: "European Commission · 2026",
      href: "https://op.europa.eu/en/publication-detail/-/publication/68e7549c-21ee-11f1-8c3a-01aa75ed71a1/language-en"
    },
    topics: ["employment", "government", "now", "europe"]
  },
  {
    figure: "71.4 million",
    claim: "Claims filed online with India's Employees' Provident Fund Organisation in 2024–25 by early March; over 99.31% of its claims now arrive online, with no office visit.",
    answer:
      "Once every claim arrives online, validation carries the load. Datum checks each one in the page and again on the server before anyone reviews it.",
    source: { name: "PIB, Government of India · 2025", href: "https://www.pib.gov.in/PressReleasePage.aspx?PRID=2111756" },
    topics: ["employment", "pdf-html", "government", "asia"]
  },
  {
    figure: "588,581",
    claim: "Employment settlements issued electronically in Chile in 2024 through the Labour Directorate's platform, up 52% from 2022.",
    answer:
      "The end of a job is paperwork both sides must get right. Datum validates each settlement as it is filled and keeps the result as a PDF/A with the record inside.",
    source: { name: "Dirección del Trabajo, Chile · 2025", href: "https://www.dt.gob.cl/portal/1626/articles-127986_recurso_3.pdf" },
    topics: ["employment", "pdf-html", "pdfa", "government", "latam"]
  },
  {
    figure: "Oct 2023",
    claim: "When the EU's eForms replaced its old procurement notice forms; the regulation says they should be filled from existing data and validated on input, not typed by hand.",
    answer:
      "That is Datum's model: values the host already holds fill the form, rules validate what people type, and the result is structured data.",
    source: { name: "European Commission · 2019", href: "https://eur-lex.europa.eu/eli/reg_impl/2019/1780/oj" },
    topics: ["procurement", "data", "now", "government", "europe"]
  },
  {
    figure: "12.7%",
    claim: "Of GDP spent through public procurement across OECD countries in 2023, about 30% of all government spending; 14.8% in OECD-EU countries.",
    answer:
      "Every contract starts with forms: notices, bids and supplier details. Datum makes each one a definition that validates in the page and on the server.",
    source: { name: "OECD · 2025", href: "https://doi.org/10.1787/0efd0bcd-en" },
    topics: ["procurement", "market", "government", "global"]
  },
  {
    figure: "C$52 billion",
    claim: "Worth of procurement Canada's procurement department managed for other departments in 2024–25, as it developed standard bid forms to reduce bidder errors.",
    answer:
      "Standard forms reduce errors only if they check answers. Datum validates each bid as it is filled and again on the server, and keeps a draft until it is ready.",
    source: {
      name: "PSPC · 2025",
      href: "https://www.canada.ca/en/public-services-procurement/corporate/transparency/departmental-results-report/2024-25.html"
    },
    topics: ["procurement", "problem", "government", "canada"]
  },
  {
    figure: "US$21.9bn",
    claim: "Traded on Chile's public procurement platform in 2025, with more than 100,000 suppliers taking part, 83% of them smaller firms.",
    answer:
      "Most bidders have no bid team. Datum keeps a draft between sittings, checks every answer before submit, and will not send a bid with a required field missing.",
    source: {
      name: "ChileCompra · 2026",
      href: "https://www.chilecompra.cl/2026/07/chilecompra-destaca-avances-en-integridad-y-nuevas-oportunidades-para-las-empresas-de-menor-tamano-en-expo-compras-publicas/"
    },
    topics: ["procurement", "market", "government", "latam"]
  },
  {
    figure: "30%",
    claim: "Of EU contract records on the procurement notice site have missing values, unchanged since 2017; auditors found accuracy improved once input forms validated entries.",
    answer:
      "Validation at entry is the fix auditors point to. Datum checks every field against the definition as it is typed and again on the server.",
    source: { name: "European Court of Auditors · 2023", href: "https://www.eca.europa.eu/en/publications/SR-2023-28" },
    topics: ["procurement", "data", "problem", "government", "europe"]
  },
  {
    figure: "1.1 million",
    claim: "Micro and small enterprises registered to sell on India's Government e-Marketplace, which passed ₹5 trillion in gross merchandise value in 2025–26.",
    answer:
      "Small sellers bid through forms. Datum takes the details a platform already holds before they start, so a firm enters its data once.",
    source: { name: "PIB, Government of India · 2026", href: "https://www.pib.gov.in/PressReleasePage.aspx?PRID=2249335" },
    topics: ["procurement", "market", "data", "government", "asia"]
  },
  {
    figure: "5.9 million",
    claim: "Data points an average Phase III trial protocol collects, up 11% a year since 2020; nearly a third of what trials collect is non-core, over half of that from questionnaires.",
    answer:
      "Every data point is a field someone fills. Datum shows only the questions a visit's rules call for and checks each answer as it is typed.",
    source: { name: "Tufts CSDD · 2025", href: "https://doi.org/10.1007/s43441-025-00899-4" },
    topics: ["lifesciences", "data", "problem", "global"]
  },
  {
    figure: "14,458",
    claim: "Clinical trial applications filed through the EU's single trials portal since 2022; since January 2025 every EU trial runs under the same regulation.",
    answer:
      "A single entry point needs forms every sponsor fills the same way. Datum validates each against its definition in the page and on the server.",
    source: {
      name: "EMA, ACT EU · 2026",
      href: "https://accelerating-clinical-trials.europa.eu/document/download/31d5899d-b359-46d1-aa36-d6ac384a9c0a_en?filename=ACT%20EU%20KPI%20Report_June_2026.docx.pdf"
    },
    topics: ["lifesciences", "government", "now", "europe"]
  },
  {
    figure: "2.7 million",
    claim: "Adverse drug reaction report forms China's national monitoring network received in 2025, and 28.6 million since 1999.",
    answer:
      "A safety report is only useful if software can read it. A Datum record is structured JSON validated against its definition, never a scan.",
    source: { name: "National Center for ADR Monitoring, China · 2026", href: "https://www.cdr-adr.org.cn/center_news/202604/t20260427_51496.html" },
    topics: ["lifesciences", "healthcare", "data", "asia"]
  },
  {
    figure: "May 2017",
    claim: "Since then, US drug and biologic applications must be filed electronically, with FDA fillable forms and electronic signatures; scanned images of the forms are refused.",
    answer:
      "Datum fills a regulator's own fillable PDF from the record and signs it with PAdES, so nothing is printed and scanned.",
    source: { name: "U.S. FDA · 2024", href: "https://www.fda.gov/media/135373/download" },
    topics: ["lifesciences", "signatures", "pdf-html", "government", "us"]
  },
  {
    figure: "202,008",
    claim: "Adverse reaction reports Health Canada's vigilance program received in 2024, covering 76,638 domestic cases; 78% of the cases were serious.",
    answer:
      "Each report is a form a clinician or company fills in a hurry. Datum keeps a draft, shows only what applies and checks the rest before it is sent.",
    source: {
      name: "Health Canada · 2025",
      href: "https://www.canada.ca/en/health-canada/services/drugs-health-products/medeffect-canada/health-product-infowatch/june-2025.html"
    },
    topics: ["lifesciences", "healthcare", "government", "canada"]
  },
  {
    figure: "82%",
    claim: "Uptake of the online questionnaire for Canada's 2021 Census of Agriculture, which flagged unlikely entries and filled some fields from the Business Register.",
    answer:
      "That is the pattern Datum follows: rules question an unlikely answer as it is typed, and the host fills what it already knows before the person starts.",
    source: { name: "Statistics Canada · 2024", href: "https://www.statcan.gc.ca/en/about/er/2021-ceag" },
    topics: ["agriculture", "data", "government", "canada"]
  },
  {
    figure: "78%",
    claim: "Of farmers in a Commission survey who apply for EU farm support use outside help with the application; a third spend over six days a year on the paperwork.",
    answer:
      "When most applicants need help to apply, the form is the problem. Datum shows only what applies to each farm and keeps a draft between sittings.",
    source: {
      name: "European Commission · 2024",
      href: "https://agriculture.ec.europa.eu/media/news/simplification-survey-sheds-light-specific-issues-faced-farmers-across-eu-2024-04-12_en"
    },
    topics: ["agriculture", "problem", "government", "europe"]
  },
  {
    figure: "29 to 13",
    claim: "Pages in USDA's direct farm loan application before and after its 2023 rewrite; about 26,000 producers apply each year, and many applications ended incomplete or withdrawn.",
    answer:
      "Shorter is better, and a form that asks only what applies is shorter still. Datum hides what does not apply and checks the rest before submit.",
    source: {
      name: "USDA Farm Service Agency · 2023",
      href: "https://www.fsa.usda.gov/news-events/news/02-09-2023/usda-develops-simplified-direct-loan-application-improve-customer"
    },
    topics: ["agriculture", "problem", "government", "us"]
  },
  {
    figure: "8 million",
    claim: "Registrations in Brazil's rural environmental registry by 2025, of which only about 9% had been validated by November.",
    answer:
      "Review is the bottleneck. A Datum record arrives already checked against its definition, so reviewers start from complete, consistent data.",
    source: {
      name: "Climate Policy Initiative · 2025",
      href: "https://www.climatepolicyinitiative.org/publication/where-does-brazil-stand-with-the-implementation-of-the-forest-code-2025-edition/"
    },
    topics: ["agriculture", "data", "government", "latam"]
  },
  {
    figure: "3,300",
    claim: "Procedures Japan's farm ministry moved online in fiscal 2022; about 2,700 are hardly used, and paid SaaS licences for each user keep costs high, a 2024 review found.",
    answer:
      "Putting every form online costs little when each is a file under MIT. Datum has no per-user licences, and a form nobody fills costs nothing to keep.",
    source: { name: "MAFF, Japan · 2024", href: "https://www.gyoukaku.go.jp/review/aki/R06/img/1_2_1_nourin.pdf" },
    topics: ["agriculture", "landscape", "problem", "government", "asia"]
  },
  {
    figure: "About half",
    claim: "Of trading countries still rely on paper phytosanitary certificates for plant exports, which FAO calls costly, error-prone and open to counterfeiting.",
    answer:
      "Paper certificates get lost, copied and retyped. A Datum record is structured data from the start, and its PDF can carry a signature anyone can verify.",
    source: {
      name: "FAO · 2025",
      href: "https://www.fao.org/plant-production-protection/news-and-events/news/news-detail/fao--ippc-call-for-global-adoption-of-ephyto-to-boost-plant-trade/en"
    },
    topics: ["agriculture", "transport", "pdf-html", "global"]
  },
  {
    figure: "1.7 million",
    claim: "FOIA requests US federal agencies received in fiscal 2025, a record; the backlog grew 27% to 339,671.",
    answer:
      "Every request starts as a form. Datum makes it arrive complete, checked in the page and on the server, so staff time goes to the records, not the paperwork.",
    source: { name: "U.S. Department of Justice · 2026", href: "https://www.justice.gov/oip/media/1450791/dl?inline=" },
    topics: ["records", "government", "market", "us"]
  },
  {
    figure: "12,027",
    claim: "FOI requests to UK central government in 2025 that needed clarification before an answer, out of a record 94,526.",
    answer:
      "A vague request costs a round trip. A Datum request form asks for what is needed, with help on each field, and will not submit until the required parts are there.",
    source: {
      name: "Cabinet Office · 2026",
      href: "https://www.gov.uk/government/statistics/freedom-of-information-statistics-annual-2025/freedom-of-information-statistics-annual-2025-bulletin"
    },
    topics: ["records", "problem", "government", "uk", "europe"]
  },
  {
    figure: "83.3%",
    claim: "Of Canada's access-to-information requests in 2024–25 went to its immigration department, most of them about the requesters' own applications.",
    answer:
      "People ask to see their own file. A Datum submission can hand the person their record at once: a receipt and a PDF/A with their answers inside.",
    source: {
      name: "Treasury Board of Canada Secretariat · 2025",
      href: "https://www.canada.ca/en/treasury-board-secretariat/services/access-information-privacy/statistics-atip/information-privacy-statistical-report-2024-2025.html"
    },
    topics: ["records", "immigration", "pdfa", "government", "canada"]
  },
  {
    figure: "86%",
    claim: "Of South Korea's 2.62 million information disclosure requests in 2025 were filed online; in 2007, nearly half still came in person or by post.",
    answer:
      "Online is where requests arrive now. One Datum definition serves every agency's request form, each in its own look, with the same checks on the server.",
    source: {
      name: "Ministry of the Interior and Safety, Korea · 2026",
      href: "https://www.open.go.kr/util/FileDownload.do?fileUploadNo=NUtMYVE1VjVyZ3l2cjFqMlI0bmhEdz09"
    },
    topics: ["records", "pdf-html", "government", "asia"]
  },
  {
    figure: "1 million",
    claim: "Access-to-information and personal-data requests logged on Mexico's national transparency platform in the year to September 2024, across more than 7,000 public bodies.",
    answer:
      "Thousands of bodies, one kind of request. A Datum form is a file each body can reuse, and every copy validates the same way on its server.",
    source: { name: "INAI, Mexico · 2025", href: "http://sil.gobernacion.gob.mx/Archivos/Documentos/2025/02/asun_4830842_20250205_1738774502.pdf" },
    topics: ["records", "government", "market", "latam"]
  },
  {
    figure: "43,456",
    claim: "FOI requests Australian Government agencies and ministers received in 2024–25, a record; handling FOI cost A$97.99 million.",
    answer:
      "Each request costs money to read, clarify and route. One that arrives complete and structured, as a Datum record does, costs less to handle.",
    source: { name: "OAIC · 2025", href: "https://www.oaic.gov.au/__data/assets/pdf_file/0028/257770/OAIC_Annual-Report_Vol-2_2024-25.pdf" },
    topics: ["records", "problem", "government", "anz"]
  },
  {
    figure: "88",
    claim: "Countries that have adopted laws based on the UN's model law on electronic commerce, which recognises electronic records and signatures; 171 jurisdictions in all.",
    answer:
      "Electronic signatures are law almost everywhere. Datum's PDFs carry PAdES signatures and its submissions carry passkey signatures, each verified check by check.",
    source: { name: "UNCITRAL", href: "https://uncitral.un.org/en/texts/ecommerce/modellaw/electronic_commerce/status" },
    topics: ["signatures", "government", "now", "global"]
  },
  {
    figure: "2026",
    claim: "The year every EU member state must offer a digital identity wallet; creating qualified e-signatures with it will be free for non-professional use.",
    answer:
      "Signing is becoming something every citizen can do. A Datum form takes a signature on the PDF and on the submission, and the server verifies both before it keeps the record.",
    source: { name: "European Commission", href: "https://digital-strategy.ec.europa.eu/en/policies/eudi-regulation" },
    topics: ["signatures", "government", "now", "europe"]
  },
  {
    figure: "800 million",
    claim: "Digital signatures given in Estonia in 20 years, about 123 million in the latest year alone, by more than a million people.",
    answer:
      "Where people can sign digitally, they do it daily. Datum signs the PDF with the person's own certificate and the submission with a passkey.",
    source: { name: "Estonian Information System Authority · 2022", href: "https://www.ria.ee/en/news/20-years-more-800-million-digital-signatures-have-been-given-estonia" },
    topics: ["signatures", "government", "market", "europe"]
  },
  {
    figure: "10.7 million",
    claim: "Digital certificates Brazil's national public key infrastructure issued in 2024, a record; more than 14.2 million were active, about half held by businesses.",
    answer:
      "Certificates are already in people's hands. Datum's local agent signs a PDF with a certificate file or a YubiKey, and the server verifies every signature check by check.",
    source: { name: "ANCD, from ITI data · 2025", href: "https://ancd.org.br/icp-brasil-bate-recorde-e-encerra-2024-com-mais-de-106-milhoes-de-emissoes/" },
    topics: ["signatures", "government", "market", "yubikey", "latam"]
  },
  {
    figure: "≈5 million",
    claim: "PIV smart cards giving US federal employees and contractors multifactor access to IT systems and facilities.",
    answer:
      "Hardware-held keys are standard issue in government. Datum's agent keeps the signing key on hardware too, through a YubiKey, with the PIN in the operating system's own dialog.",
    source: { name: "NIST", href: "https://www.nist.gov/identity-access-management/personal-identity-verification-piv" },
    topics: ["signatures", "government", "defense", "yubikey", "us"]
  },
  {
    figure: "149,312",
    claim:
      "Requirements in Canadian federal regulations and their forms that impose an administrative burden on business; at one regulator, 83% of them sit on 165 forms.",
    answer:
      "Each requirement is a field someone fills. A form that is one definition, rendered, validated and printed the same way everywhere, is how that burden shrinks without a rewrite per channel.",
    source: { name: "Treasury Board of Canada · 2024", href: "https://www.canada.ca/en/treasury-board-secretariat/corporate/reports/annual-reports-parliament-federal-regulatory-management-initiatives/annual-report-2024-2025-fiscal-year-federal-regulatory-management-initiatives.html" },
    topics: ["market", "count", "government", "canada"]
  },
  {
    figure: "2,565",
    claim: "Forms in Ontario's Central Forms Repository; the largest ministries hold 344, 330 and 318 each.",
    answer:
      "A catalogue that size is a folder of definitions. Reference bindings draw the same definition in the GC Design System, GOV.UK, USWDS, Bootstrap, Nova Scotia, Alberta, Québec, Ontario and Fluent UI design systems, as starting points for the look a catalogue needs.",
    source: { name: "Ontario Central Forms Repository · 2026", href: "https://forms.mgcs.gov.on.ca/en/dataset/" },
    topics: ["government", "count", "canada"]
  },
  {
    figure: "35",
    claim: "Administrative requirements per form at one federal regulator: 5,756 of its 6,901 requirements sit on 165 forms.",
    answer:
      "Each requirement is a field with a rule. In Datum the rule lives beside the field in the definition and runs the same in the page and in the sandbox on the server.",
    source: { name: "Canadian Nuclear Safety Commission · 2026", href: "http://www.nuclearsafety.gc.ca/eng/acts-and-regulations/administrative-burden-baseline/index.cfm" },
    topics: ["government", "count", "problem", "canada"]
  },
  {
    figure: "+15%",
    claim: "Growth since 2014 in the count of Canadian federal requirements that burden business; the 2024 count fell 0.06%.",
    answer:
      "Burden falls when a form is data: rules hide what does not apply, one record serves every channel, and a change is a diff, not a reprint.",
    source: { name: "Treasury Board of Canada · 2024", href: "https://www.canada.ca/en/treasury-board-secretariat/corporate/reports/annual-reports-parliament-federal-regulatory-management-initiatives/annual-report-2024-2025-fiscal-year-federal-regulatory-management-initiatives.html" },
    topics: ["government", "now", "canada"]
  },
  {
    figure: "24.4%",
    claim: "Of federal services could be completed entirely online in 2023/24, 419 in all; Canada fell from 3rd in 2010 to 47th in 2024 on the UN's e-government index.",
    answer:
      "End to end online needs the form, the signature and the record to work together. Datum does all three in the browser, checked again on the server.",
    source: { name: "Statistics Canada · 2026", href: "https://www150.statcan.gc.ca/n1/pub/22-20-0001/222000012026001-eng.htm" },
    topics: ["pdf-html", "problem", "now", "government", "canada"]
  },
  {
    figure: "$4.6 billion",
    claim: "In COVID-19 benefits paid to ineligible people, auditors found, after Canada relied on applicants' own attestations; at least $27.4 billion more needed investigating.",
    answer:
      "Checks belong at intake. Datum's rules run in the page and on the server, and values the host already holds can be set before the person answers.",
    source: {
      name: "Office of the Auditor General of Canada · 2022",
      href: "https://www.canada.ca/en/auditor-general/our-work/audit-reports/parl-oag-202212-10-e.html"
    },
    topics: ["data", "problem", "social", "government", "canada"]
  },
  {
    figure: "60 years",
    claim: "Age of the oldest systems behind Canada's pension and EI benefits in 2023, when auditors found their replacement's cost up 43% to $2.5 billion with no benefit moved.",
    answer:
      "Forms need not wait for a platform rebuild. A Datum form is a file that validates and hands a structured record to the systems already there.",
    source: {
      name: "Office of the Auditor General of Canada · 2023",
      href: "https://www.canada.ca/en/auditor-general/our-work/audit-reports/parl-oag-202310-08-e.html"
    },
    topics: ["problem", "social", "government", "canada"]
  },
  {
    figure: "Almost 90",
    claim: "Separate sign-in portals federal departments run; auditors found Canada the only G7 country with neither digital identity legislation nor a single sign-in.",
    answer:
      "Datum works with whatever sign-in a service has, and signs each submission with a passkey the person already holds, so the record carries its own proof.",
    source: {
      name: "Office of the Auditor General of Canada · 2024",
      href: "https://www.canada.ca/en/auditor-general/our-work/audit-reports/parl-oag-202412-09-e.html"
    },
    topics: ["passkeys", "problem", "government", "canada"]
  },
  {
    figure: "22.3 million",
    claim: "Uses of the CRA's Auto-fill My Return in 2023–24, which fills parts of a tax return with data the agency already holds.",
    answer:
      "Pre-filling is Datum's host-set values: the service sets what it already knows before the person starts, and the person checks it.",
    source: {
      name: "Canada Revenue Agency · 2025",
      href: "https://www.canada.ca/en/revenue-agency/corporate/about-canada-revenue-agency-cra/ministerial-transition-2025/thematic-briefings.html"
    },
    topics: ["tax", "data", "government", "canada"]
  },
  {
    figure: "88.6%",
    claim: "Of households answered the 2026 Census online, up from 84.1% in 2021, more than ever; self-response reached a record 91.2%.",
    answer:
      "People take the online form when it works. Datum checks each answer as it is typed, keeps a draft to finish later, and prints for anyone who needs paper.",
    source: {
      name: "Statistics Canada · 2026",
      href: "https://www.statcan.gc.ca/en/about/statistical-announcements/2026-09-14-exceptional-participation-2026-census"
    },
    topics: ["pdf-html", "market", "government", "canada"]
  },
  {
    figure: "10%",
    claim: "Of candidate nominations for Canada's April 2025 federal election were filed online: 205, against 1,794 on paper.",
    answer:
      "Nomination papers are a form with signatures. Datum signs the PDF with a certificate and the submission with a passkey, and the server checks both.",
    source: {
      name: "Elections Canada · 2025",
      href: "https://www.elections.ca/content.aspx?section=res&dir=rep%2Foff%2Fsta_ge45&document=p2&lang=e"
    },
    topics: ["elections", "pdf-html", "signatures", "government", "canada"]
  },
  {
    figure: "5.2 million",
    claim: "Travel documents Canada issued in 2024–25; the new online channel for adult passport renewals took 3,905 applications that year.",
    answer:
      "Moving millions of paper applications online is a form problem first. Datum validates each one as it is filled and again on the server.",
    source: {
      name: "IRCC · 2025",
      href: "https://www.canada.ca/en/immigration-refugees-citizenship/corporate/publications-manuals/departmental-results-reports/2025/report.html"
    },
    topics: ["immigration", "pdf-html", "now", "government", "canada"]
  },
  {
    figure: "80%",
    claim: "Of new Canadian citizens applied online in 2024–25, up from 60% the year before, as IRCC opened the e-application to minors and family groups.",
    answer:
      "A family applies together, so the form must handle each member. Datum repeats a section per person, with its rules and checks for each one.",
    source: {
      name: "IRCC · 2025",
      href: "https://www.canada.ca/en/immigration-refugees-citizenship/corporate/publications-manuals/departmental-results-reports/2025/report.html"
    },
    topics: ["immigration", "pdf-html", "government", "canada"]
  },
  {
    figure: "65.8%",
    claim: "Of Canadians using digital government services in 2022 hit at least one problem, up from 40.2% in 2018; nearly as many downloaded a form to hand in as submitted one online.",
    answer:
      "A downloaded form handed in on paper is a web form that never got built. Datum makes building it a browser task, not a project.",
    source: { name: "Statistics Canada · 2026", href: "https://www150.statcan.gc.ca/n1/pub/22-20-0001/222000012026001-eng.htm" },
    topics: ["problem", "pdf-html", "government", "canada"]
  },
  {
    figure: "Dec 2027",
    claim: "When new and updated federal web pages and web applications must meet Canada's ICT accessibility standard; new digital documents follow in December 2028.",
    answer:
      "Each field's label, description and error come from the definition, and PDF/A tagged at level a is an option for the documents. Datum's own look has automated checks only, no manual audit.",
    source: {
      name: "ESDC · 2025",
      href: "https://www.canada.ca/en/employment-social-development/programs/accessible-canada-regulations-guidance/digital-technologies-phase-1.html"
    },
    topics: ["accessibility", "now", "government", "canada"]
  },
  {
    figure: "$17.9B",
    claim: "Of regulation's $51.5 billion cost to Canadian businesses in 2024 that CFIB attributes to red tape; building permits are the second-worst municipal irritant.",
    answer:
      "Much red tape is forms asked badly. Datum asks only what applies, pre-fills what the government already holds and checks answers before submit.",
    source: { name: "CFIB · 2025", href: "https://www.cfib-fcei.ca/hubfs/research/reports/2025/Canadas-Red-Tape-Report-2025.pdf" },
    topics: ["problem", "corporate", "permits", "government", "canada"]
  },
  {
    figure: "19.8 million",
    claim: "Hours Canadian physicians spend a year on unnecessary paperwork, the time of 9,093 full-time doctors; 59% blame government forms, the disability tax credit form worst of all.",
    answer:
      "A form that asks for what the system already has wastes a doctor's hour. Datum pre-fills known values and shows only the questions that apply.",
    source: { name: "CMA and CFIB · 2026", href: "https://digitallibrary.cma.ca/link/digitallibrary1478" },
    topics: ["healthcare", "problem", "government", "canada"]
  },
  {
    figure: "52%",
    claim: "Of ServiceOntario's 784 sub-services were still not online in 2024, after ten years and about $100 million of digital initiatives, the province's auditor found.",
    answer:
      "Each service online needs its forms built. Datum makes a form a file an office builds in a browser, validated the same way on the province's servers.",
    source: {
      name: "Auditor General of Ontario · 2024",
      href: "https://www.auditor.on.ca/en/content/annualreports/arreports/en24/pa_ONdigital_en24.pdf"
    },
    topics: ["pdf-html", "problem", "government", "canada"]
  },
  {
    figure: "2025",
    claim: "The year Ontario's accessibility law set for an accessible province; its 2023 review called missing it a near certainty, with about 25 enforcement staff for 412,000 organizations.",
    answer:
      "Each field's label, description and error come from the definition, so a fix lands once for every form. Datum's own look has automated checks only, no manual audit.",
    source: {
      name: "Government of Ontario · 2023",
      href: "https://www.ontario.ca/page/2023-legislative-review-accessibility-ontarians-disabilities-act-2005"
    },
    topics: ["accessibility", "problem", "government", "canada"]
  },
  {
    figure: "June 2023",
    claim: "Since then every new standard-form contract in Québec must be given first in French, with its related documents, cancellation forms included.",
    answer:
      "French first is a locale, not a second form. Datum keeps every text per locale in one definition, so both versions stay the same form.",
    source: {
      name: "Office québécois de la langue française · 2026",
      href: "https://www.oqlf.gouv.qc.ca/francisation/entreprises/contrats-adhesion.html"
    },
    topics: ["now", "corporate", "insurance", "canada"]
  },
  {
    figure: "7%",
    claim: "Cut in the yearly volume of administrative formalities Québec businesses complete, 2020 to March 2025, while their number fell 11% and their cost 23%, $250 million a year.",
    answer:
      "Fewer formalities is one fix, faster ones another. Datum asks only what applies and fills what the government already holds before the person starts.",
    source: {
      name: "Gouvernement du Québec · 2026",
      href: "https://www.quebec.ca/nouvelles/actualites/details/adoption-du-projet-de-loi-n-11-loi-modifiant-diverses-dispositions-principalement-aux-fins-dallegement-du-fardeau-reglementaire-et-administratif-quebec-renforce-ses-pouvoirs-pour-alleger-encore-plus-le-fardeau-reglementaire-et-administratif-des-entreprises-71057"
    },
    topics: ["problem", "corporate", "government", "canada"]
  },
  {
    figure: "60.7%",
    claim: "Of Service New Brunswick's customer transactions were completed online in 2024–25, below its 65% target, as service-centre transactions grew by 146,235.",
    answer:
      "People return to the counter when the online form fails them. Datum's forms work in both official languages and keep a draft between visits.",
    source: { name: "Service New Brunswick · 2025", href: "https://www2.snb.ca/content/dam/snb/publications/annual-report-2024-2025.pdf" },
    topics: ["pdf-html", "government", "canada"]
  },
  {
    figure: "184,020",
    claim: "Regulatory requirements Nova Scotia counted in 2025, up 1.7% on 2024, as its red-tape office reviewed nearly 300 provincial permits for risk and ways to improve.",
    answer:
      "Each requirement lands on a form someone fills. Datum lets an office change a form's rules in a browser, not in a software release, as permits are simplified.",
    source: {
      name: "Nova Scotia Office of Service Efficiency · 2026",
      href: "https://www.novascotia.ca/sites/default/files/documents/1-3855/annual-report-2025-office-service-efficiency-en.pdf"
    },
    topics: ["count", "permits", "government", "canada"]
  },
  {
    figure: "400,000+",
    claim: "Registered users of MyGovNL, Newfoundland and Labrador's digital front door for services from health records to motor registration.",
    answer:
      "Each service behind the account is a set of forms. Datum renders them from one definition each, in the province's own look, checked on its servers.",
    source: { name: "Government of Newfoundland and Labrador · 2025", href: "https://www.gov.nl.ca/releases/2025/gmsd-en/0723n01/" },
    topics: ["market", "government", "canada"]
  },
  {
    figure: "63%",
    claim: "Of Manitoba's regulatory requirements sat in forms in 2018, out of 924,180 counted; policies and forms together held 84%.",
    answer:
      "When most of the burden is in forms, the form is the unit of reform: change one Datum definition and the web form, print and PDF follow.",
    source: { name: "Government of Manitoba · 2018", href: "https://www.manitoba.ca/asset_library/en/rrt/regulatory_accountability_report.pdf" },
    topics: ["count", "problem", "government", "canada"]
  },
  {
    figure: "21,046",
    claim: "Compliance requirements in 249 business regulations Saskatchewan reviewed over a decade of red-tape reduction, reporting $682.41 million in cumulative savings.",
    answer:
      "Many of those requirements are answered on forms. Datum lets a ministry drop a question or a rule in a browser, and every copy of the form follows.",
    source: {
      name: "Government of Saskatchewan · 2024",
      href: "https://www.saskatchewan.ca/government/news-and-media/2024/april/02/celebrating-a-decade-of-saskatchewan-red-tape-reduction-success"
    },
    topics: ["count", "corporate", "government", "canada"]
  },
  {
    figure: "37%",
    claim: "Of the 666,513 requirements in Alberta's 2019 red-tape baseline sat in forms; forms then supplied 46% of the first cuts.",
    answer:
      "Forms carry the red tape, so forms are where to cut it. Remove a question from a Datum definition and every channel stops asking it.",
    source: {
      name: "Government of Alberta · 2021",
      href: "https://open.alberta.ca/dataset/ecd877d0-79f9-4379-9bc9-b35a9ad50522/resource/aababb3f-951d-4970-bf73-6e0c9d47e72b/download/tbf-red-tape-reduction-annual-report-2010-2021.pdf"
    },
    topics: ["count", "problem", "government", "canada"]
  },
  {
    figure: "3.7 million",
    claim: "Personal Alberta.ca Accounts at the end of 2023, one sign-in for 70 online government services; the service used single-factor authentication, the auditor noted.",
    answer:
      "Datum adds proof where it counts: each submission can be signed with a passkey the person holds, and the server checks it before accepting.",
    source: { name: "Auditor General of Alberta · 2024", href: "https://www.oag.ab.ca/wp-content/uploads/2024/07/2024-AlbertacaAccount-PA.pdf" },
    topics: ["passkeys", "market", "government", "canada"]
  },
  {
    figure: "364",
    claim: "B.C. local governments and First Nations, 161 and 203, each setting its own building-permit requirements; most communities still took paper in 2023.",
    answer:
      "Hundreds of versions of one application is a definition problem. A Datum form is a file each community can adopt, adjust, theme and hand on.",
    source: {
      name: "B.C. Digital Marketplace · 2023",
      href: "https://marketplace.digital.gov.bc.ca/opportunities/sprint-with-us/77e96eb8-b2ac-40f7-b147-a1c9ee86c095"
    },
    topics: ["permits", "pdf-html", "problem", "government", "canada"]
  },
  {
    figure: "$5 million",
    claim: "Ceiling of the contract B.C. awarded in 2023 to develop CHEFS, the government's own hosted form service, from November 2023 to March 2027.",
    answer:
      "Provinces keep building their own form tools. Datum is that component already built, open under MIT, with PDFs, signatures and a server contract.",
    source: {
      name: "B.C. Digital Marketplace · 2023",
      href: "https://marketplace.digital.gov.bc.ca/opportunities/sprint-with-us/d28b43b8-de40-4d3e-bd23-26322c6469d5"
    },
    topics: ["landscape", "government", "canada"]
  },
  {
    figure: "98%",
    claim: "Of forms filed through B.C.'s Online Divorce Assistant were right the first time; it asks questions and fills the forms in, where gaps once cost two or three office visits.",
    answer:
      "That is Datum's model: rules show what applies, checks catch the gaps, and the court form is filled from the answers.",
    source: {
      name: "Government of B.C. · 2019",
      href: "https://www2.gov.bc.ca/assets/gov/government/about-the-bc-government/regulatory-reform/pdfs/better_regulations_2019_annualreport_web.pdf"
    },
    topics: ["legal", "data", "pdf-html", "government", "canada"]
  },
  {
    figure: "99%",
    claim: "Of participants at B.C.'s Civil Resolution Tribunal, Canada's first online tribunal, chose its online services in 2024/25; applicants can save and finish later.",
    answer:
      "Online-first works when the form keeps your place. Datum saves drafts in the browser, on your server or as a file, and restores them against the form's version.",
    source: { name: "Civil Resolution Tribunal · 2025", href: "https://civilresolutionbc.ca/wp-content/uploads/CRT-Annual-Report-2024-2025.pdf" },
    topics: ["legal", "pdf-html", "landscape", "government", "canada"]
  },
  {
    figure: "1,027",
    claim: "Forms on the Government of Yukon's public forms list, online and document forms together, for a single territorial government.",
    answer:
      "Each is a file in Datum: built in a browser, drawn in Yukon's own design, and online or printed from the same definition.",
    source: { name: "Government of Yukon · 2026", href: "https://yukon.ca/en/forms" },
    topics: ["count", "government", "canada"]
  },
  {
    figure: "11",
    claim: "Official languages of the Northwest Territories; head offices serve people in English or French, and regional offices in the local Indigenous language where demand warrants.",
    answer:
      "Datum keeps every text per locale in one definition, so adding a language never means building a new form.",
    source: {
      name: "Government of the Northwest Territories",
      href: "https://www.justice.gov.nt.ca/en/files/legislation/official-languages/official-languages.a.pdf"
    },
    topics: ["market", "government", "canada"]
  },
  {
    figure: "53%",
    claim: "Of Nunavut residents have Inuktut as their mother tongue; the Languages Commissioner has asked that school forms be provided in Inuktitut as well as English.",
    answer:
      "A form in the reader's language is one they can sign knowingly. Datum's texts are per locale, and a language switch never resets an answer.",
    source: {
      name: "Languages Commissioner of Nunavut · 2025",
      href: "https://www.assembly.nu.ca/sites/default/files/2025-09/TD-424-6(2)-EN-OLC%20Annual%20report%202024-2025.pdf"
    },
    topics: ["education", "government", "canada"]
  },
  {
    figure: "2,400",
    claim: "Canadian municipalities that issue building permits, covering 95% of the population, by Statistics Canada's count for its permits survey.",
    answer:
      "Every one of them needs the same kinds of forms. A Datum form is a file one municipality can hand the next, under MIT, in its own look.",
    source: { name: "Statistics Canada · 2026", href: "https://www23.statcan.gc.ca/imdb/p2SV.pl?Function=getSurvey&SDDS=2802" },
    topics: ["permits", "market", "government", "canada"]
  },
  {
    figure: "36,887",
    claim: "Building permits Toronto issued in 2024, alongside 167,642 inspections; the city added self-service online submission for housing permits to cut manual handling.",
    answer:
      "Each application that arrives complete saves a round trip. Datum requires the right answers and uploads before submit and checks them again on the server.",
    source: { name: "City of Toronto · 2025", href: "https://www.toronto.ca/legdocs/mmis/2026/bu/bgrd/backgroundfile-261720.pdf" },
    topics: ["permits", "market", "government", "canada"]
  },
  {
    figure: "About 100",
    claim: "Technology projects the federal Housing Accelerator Fund has backed in municipalities, changing how housing applications are submitted, reviewed and approved.",
    answer:
      "Towns are rebuilding permit intake one at a time. Datum offers a shared route: a form is a file under MIT that any municipality can reuse.",
    source: { name: "CMHC · 2026", href: "https://www.cmhc-schl.gc.ca/observer/2026/housing-accelerator-fund-building-more-livable-communities" },
    topics: ["permits", "landscape", "now", "government", "canada"]
  },
  {
    figure: "90%",
    claim: "Drop in median processing time for Vancouver business licences after online applications replaced PDF forms in 2023; 86% of renewals are now processed online.",
    answer:
      "Replacing a PDF with a web form is where the time goes. Datum renders the same definition online and still produces the PDF when one is needed.",
    source: {
      name: "City of Vancouver · 2025",
      href: "https://vancouver.ca/files/cov/2025-02-10-council-memo-3-3-3-1-permitting-program-update.pdf"
    },
    topics: ["permits", "pdf-html", "now", "government", "canada"]
  },
  {
    figure: "2018",
    claim: "The year the 21st Century IDEA Act required US agencies to digitize forms and accept electronic signatures; guidance followed in 2023, and under 2% of sampled forms complied in 2021.",
    answer:
      "Datum answers the letter of it: web-based, mobile forms, electronic signatures with PAdES and WebAuthn, PDF/A records, all in your environment.",
    source: { name: "Digital.gov", href: "https://digital.gov/resources/delivering-digital-first-public-experience" },
    topics: ["government", "now", "pdf-html", "us"]
  },
  {
    figure: "70%",
    claim:
      "Of the reports the 24 largest agencies owed under the 21st Century IDEA Act from 2019 to 2023 were filed; in 2023, 7 of the 18 that reported addressed all eight requirements.",
    answer:
      "Compliance is easier when it is built in: every Datum form is web-based, works on a phone and carries its labels and errors.",
    source: { name: "GAO · 2024", href: "https://www.gao.gov/products/gao-24-106764" },
    topics: ["now", "problem", "government", "us"]
  },
  {
    figure: "≈1 in 3",
    claim:
      "Of the 35 high-impact federal service providers ITIF reviewed in 2022 had sites powered by the US Web Design System; the rest varied widely in style, layout and features.",
    answer:
      "A reference USWDS binding draws a form in the agency's USWDS markup as a starting point, and another binding redraws the same definition unchanged.",
    source: { name: "ITIF · 2022", href: "https://itif.org/publications/2022/10/24/federal-hisp-digital-customer-experience/" },
    topics: ["problem", "government", "us"]
  },
  {
    figure: "94%+",
    claim:
      "Of individual taxpayers no longer have to send the IRS mail, it estimated in November 2023, once all correspondence and notice responses could be submitted digitally.",
    answer:
      "A notice response is a short form with an upload. The builder makes one without a developer, with size and type limits on the file, and the PDF carries it inside.",
    source: {
      name: "IRS · 2023",
      href: "https://www.irs.gov/newsroom/irs-achieves-key-paperless-processing-initiative-goal-outlines-improvements-for-filing-season-2024"
    },
    topics: ["now", "pdf-html", "tax", "government", "us"]
  },
  {
    figure: "1,870+",
    claim: "Forms published in 2025 on GC Forms, the builder the Canadian Digital Service runs, up 145% on 2024; 71 departments use it.",
    answer:
      "Governments keep building the same tool. Datum is that self-service in the open: MIT, in your environment, with reference bindings for the GC Design System, GOV.UK and USWDS already built, and the PDF, the signatures and the server contract included.",
    source: { name: "Canadian Digital Service · 2026", href: "https://digital.canada.ca/2026/02/25/progress-amp-plans-2025-highlights-for-cds-platform-products/" },
    topics: ["landscape", "now", "market", "government", "canada"]
  },
  {
    figure: "1,200+",
    claim: "Accounts opened on GOV.UK Forms during private beta and early access, before it opened to all of central government in November 2024, with 87 forms published.",
    answer:
      "The demand is for self-service. Datum is the same idea, yours: open source, in your environment, with the PDF, the signatures and the server contract included.",
    source: { name: "Government Digital Service · 2024", href: "https://gds.blog.gov.uk/2024/11/04/gov-uk-forms-in-motion" },
    topics: ["landscape", "now", "market", "government", "uk", "europe"]
  },
  {
    figure: "61",
    claim: "Forms on MoJ Forms, which the UK Ministry of Justice kept in 2025 beside GOV.UK Forms because it handles more pages and branching.",
    answer:
      "One department, two builders: one for simple forms, one for complex. Datum does both in one definition format, with steps, tabs, conditional sections and branching rules.",
    source: { name: "MoJ Forms · 2025", href: "https://moj-forms.service.justice.gov.uk/news/" },
    topics: ["landscape", "government", "problem", "legal", "uk", "europe"]
  },
  {
    figure: "900,000+",
    claim: "Forms created on FormSG, the form builder Singapore's government built in-house, by more than 160 public agencies.",
    answer:
      "Proof that self-service forms scale across a whole government. Datum brings the same to any government, open under MIT, with PDFs, signatures and a server contract.",
    source: {
      name: "GovTech Singapore",
      href: "https://www.tech.gov.sg/products-and-services/for-government-agencies/productivity-and-marketing/formsg/"
    },
    topics: ["landscape", "government", "now", "asia"]
  },
  {
    figure: "7,800",
    claim: "Surveys created in 2017 alone on EUSurvey, the European Commission's own open-source form and survey tool, taking more than 2.7 million contributions in 23 languages.",
    answer:
      "Multilingual by necessity. In Datum every text is per locale in the definition, and switching language mid-form keeps every answer.",
    source: { name: "European Commission, ISA²", href: "https://ec.europa.eu/isa2/solutions/eusurvey_en" },
    topics: ["landscape", "government", "europe"]
  },
  {
    figure: "100+",
    claim: "Federal agency teams using Touchpoints, the feedback-form tool the US General Services Administration built for agencies.",
    answer:
      "Feedback, applications and claims are all forms. In Datum each is one definition, rendered, validated and kept the same way, on your own server.",
    source: { name: "GSA Touchpoints", href: "https://touchpoints.digital.gov/" },
    topics: ["landscape", "government", "us"]
  },
  {
    figure: "8.3 million",
    claim: "Forms part-filled on Norway's government form platform, Altinn II, on 7 April 2026; people had until 31 May to submit them before its submission closed.",
    answer:
      "A Datum draft carries the form's version, is checked before it is restored, and can be a file the person keeps, so a platform move strands no one.",
    source: { name: "Digdir · 2026", href: "https://samarbeid.digdir.no/altinn/innsending-pa-altinn-ii-avvikles-31-mai-unnga-brukernes-data-gar-tapt/3575" },
    topics: ["landscape", "government", "problem", "europe"]
  },
  {
    figure: "$117 billion",
    claim: "What outdated, manual federal processes cost Americans each year, with another $38.7 billion to the agencies themselves.",
    answer:
      "The savings belong to whoever holds the forms. Datum runs in your environment under MIT, so the return stays there too.",
    source: { name: "U.S. Chamber of Commerce · 2022", href: "https://www.uschamber.com/technology/government-digitization-transforming-government-to-better-serve-americans" },
    topics: ["now", "market", "us"]
  },
  {
    figure: "1,000+",
    claim: "Processes and activities in APQC's cross-industry process framework, grouped into 13 categories from strategy to HR, finance and IT.",
    answer:
      "Most of them start with a request, a record or an approval. Datum makes each such form a JSON file built in a browser, not an IT project.",
    source: {
      name: "APQC · 2024",
      href: "https://www.apqc.org/resource-library/resource-listing/apqc-process-classification-framework-pcf-cross-industry-pdf-12"
    },
    topics: ["count", "corporate", "market", "global"]
  },
  {
    figure: "28%",
    claim: "Of their time 7,000 HBR readers spend on bureaucratic chores such as internal requests and securing sign-offs, more than a day a week.",
    answer:
      "Sign-offs go faster when the request arrives complete. Datum checks every answer before submit, so no approver sends it back for a gap.",
    source: { name: "Harvard Business Review · 2017", href: "https://hbr.org/2017/08/what-we-learned-about-bureaucracy-from-7000-hbr-readers" },
    topics: ["problem", "corporate", "employment", "global"]
  },
  {
    figure: "20 days",
    claim: "Or more to approve an unbudgeted expense in large organizations, against 13 in firms under 100 staff; under 10% of staff can spend $1,000 without a sign-off.",
    answer:
      "Datum does not shorten a chain of approvers. It makes sure the request that reaches them is complete, validated and signed.",
    source: { name: "Harvard Business Review · 2017", href: "https://hbr.org/2017/08/what-we-learned-about-bureaucracy-from-7000-hbr-readers" },
    topics: ["problem", "corporate", "global"]
  },
  {
    figure: "8.9 hours",
    claim: "A week that Australian managers spend complying with their own organization's rules, 6.4 for other staff; one approval process took up to 270 days.",
    answer:
      "Internal rules often live as forms. Change the rule in one Datum definition and every copy of the form asks the new question.",
    source: {
      name: "Deloitte Access Economics · 2014",
      href: "https://web.archive.org/web/20211029084210id_/https://www2.deloitte.com/content/dam/Deloitte/au/Documents/Building%20Lucky%20Country/deloitte-au-btlc-get-out-your-own-way-230217.pdf"
    },
    topics: ["problem", "corporate", "anz"]
  },
  {
    figure: "42%",
    claim: "Of Canadian federal public servants say too many approval stages hurt the quality of their work, in the 2024 survey's 185,955 responses.",
    answer:
      "Each stage waits on a complete request. Datum validates it before it leaves the page and again on the server, so no stage returns it for a gap.",
    source: {
      name: "Treasury Board of Canada Secretariat · 2025",
      href: "https://www.tbs-sct.canada.ca/pses-saff/2024/results-resultats/en/bq-pq/org/00"
    },
    topics: ["problem", "employment", "government", "canada"]
  },
  {
    figure: "6 days",
    claim: "Median from receiving an expense report to approving it, across 5,038 APQC benchmarks; invoices take 5 days, purchase orders 2 and capital projects 30.",
    answer:
      "Days pass while a form is checked and chased. Datum checks it as it is filled, so an approver's queue holds only complete requests.",
    source: {
      name: "APQC · 2026",
      href: "https://www.apqc.org/resources/benchmarking/open-standards-benchmarking/measures/cycle-time-days-approve-and-schedule-te"
    },
    topics: ["problem", "corporate", "procurement", "global"]
  },
  {
    figure: "$58",
    claim: "To process an expense report for a one-night hotel stay; 19% contain errors that cost $52 and 18 minutes more to fix, and companies process 51,000 a year on average.",
    answer:
      "Errors caught at entry cost nothing to fix. Datum's rules check every line as it is typed and again on the server.",
    source: { name: "GBTA · 2015", href: "https://gbta.org/how-much-do-expense-reports-really-cost-a-company/" },
    topics: ["problem", "data", "corporate", "global"]
  },
  {
    figure: "546",
    claim: "Key controls in the average US SOX program in fiscal 2024, up 18% in two years, each taking 16 hours to test; only 17% are automated.",
    answer:
      "Every control needs evidence and a sign-off. A Datum record is validated, signed and kept as PDF/A with its answers inside.",
    source: { name: "KPMG · 2025", href: "https://web.archive.org/web/20260318224741id_/https://kpmg.com/kpmg-us/content/dam/kpmg/pdf/2025/the-2025-sox-survey.pdf" },
    topics: ["corporate", "problem", "signatures", "us"]
  },
  {
    figure: "33%",
    claim: "Of US work time goes to collecting and processing data, 17% and 16%; McKinsey rates 64% and 69% of that time automatable with existing technology.",
    answer:
      "Collecting data is what a form does. Datum makes collection structured and checked, so processing starts from clean data.",
    source: {
      name: "McKinsey Global Institute · 2017",
      href: "https://www.mckinsey.com/~/media/mckinsey/featured%20insights/Digital%20Disruption/Harnessing%20automation%20for%20a%20future%20that%20works/MGI-A-future-that-works-Executive-summary.ashx"
    },
    topics: ["data", "problem", "corporate", "us"]
  },
  {
    figure: "77 million",
    claim: "Leave notices, certifications and records US employers and staff complete a year for family and medical leave, taking 9.1 million hours, the Labor Department estimates.",
    answer:
      "A leave request is a form with a medical certificate attached. Datum keeps the upload inside the PDF record and checks each answer before submit.",
    source: { name: "U.S. Department of Labor · 2026", href: "https://www.reginfo.gov/public/do/PRAViewICR?ref_nbr=202605-1235-003" },
    topics: ["employment", "healthcare", "market", "us"]
  },
  {
    figure: "≈82 million",
    claim: "Electronic sick notes German employers retrieved in 2023, 6.8 million a month, in the first year the electronic note was mandatory.",
    answer:
      "When a paper slip becomes data, it moves on its own. A Datum record is structured JSON that systems pass along, not a note to file.",
    source: {
      name: "GKV-Spitzenverband · 2023",
      href: "https://www.gkv-spitzenverband.de/gkv_spitzenverband/presse/pressemitteilungen_und_statements/pressemitteilung_1732672.jsp"
    },
    topics: ["employment", "healthcare", "pdf-html", "europe"]
  },
  {
    figure: "2.5 million",
    claim: "Nonfatal workplace injuries and illnesses US private employers recorded in 2024, each needing an incident report within seven days.",
    answer:
      "An incident report is best filled where it happened. Datum runs in the browser alone, keeps a draft, and validates on the server when sent.",
    source: { name: "U.S. Bureau of Labor Statistics · 2026", href: "https://www.bls.gov/news.release/archives/osh_01222026.htm" },
    topics: ["employment", "market", "us"]
  },
  {
    figure: "114,000",
    claim: "Pay transactions Canada's Public Service Pay Centre received in the four weeks to 26 August 2026 for over 250,000 staff; 77,000 of 106,000 processed were handled by hand.",
    answer:
      "Manual handling starts with a request software cannot read. A Datum request arrives as validated, structured data.",
    source: {
      name: "Public Services and Procurement Canada · 2026",
      href: "https://www.canada.ca/en/public-services-procurement/services/pay-pension/pay-administration/pay-centre-dashboard.html"
    },
    topics: ["employment", "data", "government", "canada"]
  },
  {
    figure: "464",
    claim: "Standard and Optional Forms the US government uses across agencies, for personnel, travel, property and procurement, beside 520 of GSA's own.",
    answer:
      "Shared forms are the easy win: one Datum definition, used by every agency in its own look and changed once for all.",
    source: { name: "GSA · 2025", href: "https://www.gsa.gov/forms-library" },
    topics: ["count", "government", "employment", "us"]
  },
  {
    figure: "1,631",
    claim: "Active Department of the Army forms, most of them owned by its personnel, medical, logistics and training offices.",
    answer:
      "At that count a form must be cheap to change. Each Datum form is a file with its own rules, kept and reviewed like code.",
    source: { name: "Army Publishing Directorate · 2026", href: "https://armypubs.army.mil/ProductMaps/PubForm/DAForm.aspx" },
    topics: ["count", "defense", "government", "us"]
  },
  {
    figure: "165",
    claim: "Standard forms every California state agency uses for common administration, among 4,649 forms in the statewide directory.",
    answer:
      "Standard forms are the best case for one definition: build it once, and every agency renders the same questions and rules.",
    source: { name: "California Department of General Services · 2026", href: "https://www.dgs.ca.gov/Resources/Statewide-Forms" },
    topics: ["count", "government", "employment", "us"]
  },
  {
    figure: "566",
    claim: "Internal procedures shared by every Japanese ministry that still required paper in 2020, from accounting to personnel; law changes let 478 move online that year.",
    answer:
      "Moving hundreds of internal forms online is a definition task. Each becomes a file one ministry builds in a browser and every ministry reuses.",
    source: { name: "Cabinet Secretariat, Japan · 2020", href: "https://www.gyoukaku.go.jp/ouin/index.html" },
    topics: ["count", "pdf-html", "government", "asia"]
  },
  {
    figure: "29%",
    claim: "Of the fillable PDF forms in ITIF's federal sample that ask for a signature have a digital signature field.",
    answer:
      "The PDF designer places a signature field like any other component. The person signs with a certificate of their own, a file or a YubiKey, and the server's signature covers the record inside.",
    source: { name: "ITIF · 2021", href: "https://itif.org/publications/2021/08/23/assessing-federal-governments-transition-web-based-forms/" },
    topics: ["signatures", "pdf-html", "government", "yubikey", "us"]
  },
  {
    figure: "75%",
    claim: "Of one licensing office's paper forms were rejected for incorrect or unusable data before it moved them online.",
    answer:
      "Rules and validation run as the person types, and the server validates again in a WASM sandbox with the same verdict, so bad data stops at the field, not at the counter.",
    source: { name: "U.S. Digital Response", href: "https://www.usdigitalresponse.org/resources/digitizing-forms" },
    topics: ["data", "permits", "us"]
  },
  {
    figure: "July 2024",
    claim: "Since then the US National Archives has taken federal records only in electronic form, with metadata; transfers of paper records ended, save approved exceptions.",
    answer:
      "Records now arrive born digital. Datum writes PDF/A-2 for a plain record, or PDF/A-3 with the answers inside, and checks each file with veraPDF.",
    source: { name: "OMB and NARA · 2022", href: "https://www.archives.gov/files/records-mgmt/policy/m-23-07.pdf" },
    topics: ["pdfa", "government", "now", "us"]
  },
  {
    figure: "March 2025",
    claim: "Since then Library and Archives Canada's transfer guidelines have listed PDF/A-1 and PDF/A-2 as preferred text formats; plain PDF is only acceptable.",
    answer:
      "Datum writes PDF/A-2 at level b, u or a, checked with veraPDF, so a record leaves the form in the format the archive prefers.",
    source: {
      name: "Library and Archives Canada · 2025",
      href: "https://www.canada.ca/en/library-archives/services/government/information-disposition/management/guidelines/file-formats-transfer.html"
    },
    topics: ["pdfa", "government", "canada"]
  },
  {
    figure: "July 2014",
    claim: "When the UK government chose PDF/A or HTML as its standards for viewing government documents, with ODF for sharing and editing them.",
    answer:
      "Datum renders the form as HTML and writes the document as PDF/A. Where published files must not carry attachments, it writes PDF/A-2 rather than PDF/A-3.",
    source: { name: "Cabinet Office · 2014", href: "https://www.gov.uk/government/news/open-document-formats-selected-to-meet-user-needs" },
    topics: ["pdfa", "pdf-html", "government", "uk", "europe"]
  },
  {
    figure: "7 million",
    claim: "Businesses covered by France's e-invoicing reform, in force since September 2026; one of its three legal invoice formats is a PDF/A-3 carrying the invoice's XML data.",
    answer:
      "The same pattern as Datum's: a PDF/A-3 people can read, with the structured record inside for software. Datum embeds its JSON record that way.",
    source: {
      name: "Ministère de l'Économie · 2026",
      href: "https://www.economie.gouv.fr/tout-savoir-sur-la-facturation-electronique-pour-les-entreprises"
    },
    topics: ["pdfa", "tax", "corporate", "now", "europe"]
  },
  {
    figure: "95 million",
    claim: "Procedural documents lawyers filed through Spain's LexNET court system from 2016 to July 2023; its rules require each filing's main document as PDF/A with machine-readable text.",
    answer:
      "A PDF/A that Datum generates has real text from the start, with its fonts embedded, so the filing never needs OCR to be read.",
    source: {
      name: "Ministerio de Justicia, Spain · 2023",
      href: "https://www.mjusticia.gob.es/es/institucional/gabinete-comunicacion/noticias-ministerio/capacidad-envio-lexnet"
    },
    topics: ["pdfa", "legal", "government", "europe"]
  },
  {
    figure: "24",
    claim: "Official languages the EU's Official Journal appears in, each version a PDF/A under its electronic signature or seal; only the electronic edition has been authentic since 2013.",
    answer:
      "The EU publishes its law as signed PDF/A. Datum writes a form's record as PDF/A and can sign it with PAdES.",
    source: { name: "EUR-Lex, Publications Office", href: "https://eur-lex.europa.eu/content/help/oj/about-oj.html" },
    topics: ["pdfa", "signatures", "government", "europe"]
  },
  {
    figure: "March 2020",
    claim: "Since then Brazil has required scanned text documents meant to carry the legal weight of paper originals to be saved as PDF/A, after which the paper may be discarded.",
    answer:
      "Scanning is the route for paper. A Datum form is born digital, so its PDF/A carries the answers as data, not a picture of them.",
    source: { name: "Presidência da República, Brazil · 2020", href: "https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2020/decreto/D10278.htm" },
    topics: ["pdfa", "pdf-html", "government", "now", "latam"]
  },
  {
    figure: "2008",
    claim: "Since then South Korea's National Archives has set a PDF/A-based format as a preservation format for public electronic records, under the records management law.",
    answer:
      "Archives settled on PDF/A long ago. Datum writes its later parts, PDF/A-2 and PDF/A-3, and checks every file against veraPDF.",
    source: {
      name: "National Archives of Korea · 2022",
      href: "https://www.archives.go.kr/next/common/downloadFile.do?up_filepath=2F6e6578742e646174612F6d616e616765725C4e414b20333020323032322876312e312920B9AEBCADC0AFC7FC20C0FCC0DAB1E2B7CFB9B020BAB8C1B8C6F7B8CB20B1E2BCFAB1D4B0DD2050444620412d316220B1E2B9DDC0C720C6F7B8CB2e706466&up_filename=NAK+30+2022(v1.1)+%EB%AC%B8%EC%84%9C%EC%9C%A0%ED%98%95+%EC%A0%84%EC%9E%90%EA%B8%B0%EB%A1%9D%EB%AC%BC+%EB%B3%B4%EC%A1%B4%ED%8F%AC%EB%A7%B7+%EA%B8%B0%EC%88%A0%EA%B7%9C%EA%B2%A9+PDF+A-1b+%EA%B8%B0%EB%B0%98%EC%9D%98+%ED%8F%AC%EB%A7%B7.pdf"
    },
    topics: ["pdfa", "government", "asia"]
  }
];
