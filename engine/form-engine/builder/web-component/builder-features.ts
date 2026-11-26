/**
 * The builder's `features` list: which optional parts of `<datum-form-builder>` /
 * `<datum-builder>` exist at all. A pure model, shared by the shell, the element that wraps it and
 * the tests; it touches no DOM.
 *
 * - No `features` attribute (or a property set to `undefined` / `null`): everything exists, exactly
 *   as before the attribute was added.
 * - A `features` list: only the listed parts exist, plus the Form workspace with its canvas, its
 *   inspector and its component palette, which are always there. The list is the MASTER: the
 *   attributes that already switch a part off (`pdf="off"`, `journeys="off"`, `hidden-workspaces`,
 *   `hidden-panels`, `component-types`, `file-actions`) can only restrict further, never bring back a
 *   part the list leaves out. A part that does not exist fetches none of its chunks.
 *
 * Tokens are separated by spaces and/or commas, case-insensitive. `all` is every part; `minimal`
 * is none of the optional ones (the Form workspace alone), so `minimal logic` is the form plus
 * Logic. `form` is accepted and means what it always does. A token nobody knows is reported once
 * with `console.warn` and ignored.
 *
 * One token is opt-in: `agent`, the WebMCP agent tools over the builder. It is not
 * in `all` and an absent list does not include it, so a page that says nothing never registers
 * tools; `features="all agent"` turns it on. {@link optInFeatureOn} is the test for it, and
 * {@link featureOn} answers false for it under an absent list.
 */

/** The optional parts of the builder a `features` list names. */
export const BUILDER_FEATURES = [
  "logic",
  "data",
  "languages",
  "translations",
  "journeys",
  "pdf",
  "print",
  "variables",
  "header-footer",
  "data-model",
  "palette",
  "try-it",
  "tests",
  "json",
  "binding-picker",
  "advanced-fields",
  "agent"
] as const;

export type BuilderFeature = (typeof BUILDER_FEATURES)[number];

/** The tokens a page must name to have: never part of `all`, never implied by an absent list. */
export const BUILDER_OPT_IN_FEATURES = ["agent"] as const;

export type BuilderOptInFeature = (typeof BUILDER_OPT_IN_FEATURES)[number];

const OPT_IN: ReadonlySet<string> = new Set(BUILDER_OPT_IN_FEATURES);

/** Whether a token is one of {@link BUILDER_OPT_IN_FEATURES}. */
export function isOptInBuilderFeature(feature: string): feature is BuilderOptInFeature {
  return OPT_IN.has(feature);
}

/** What `all` names: every part but the opt-in ones, in the table's order. */
const ALL_FEATURES: readonly BuilderFeature[] = BUILDER_FEATURES.filter((feature) => !OPT_IN.has(feature));

/** The presets a list may lead with or combine: every part but the opt-in ones, or none of the optional ones. */
export const BUILDER_FEATURE_PRESETS = ["all", "minimal"] as const;

/**
 * What each token is, for the reference and the warnings: the part it gates, in a line.
 * `translations` is the pointer line under a component's texts (not the Languages workspace); `json` the
 * JSON view and editor (the CodeMirror chunk); `binding-picker` the canvas's binding picker (the
 * `binding` property still sets the binding itself); `advanced-fields` the inspector's component
 * id and data key.
 */
export const BUILDER_FEATURE_SUMMARY: Readonly<Record<BuilderFeature, string>> = {
  logic: "the Logic workspace, the inspector's Rules tab and the canvas's Add logic",
  data: "the Data workspace",
  languages: "the Languages workspace",
  translations: "the pointer to Languages under each component's texts",
  journeys: "the Journeys workspace and mode",
  pdf: "the PDF workspace and mode",
  print: "the Print workspace",
  variables: "the Variables panel",
  "header-footer": "the Header & footer panel",
  "data-model": "the Data workspace's data-model import",
  palette: "the command palette (Ctrl+K)",
  "try-it": "Try it on the canvas",
  tests: "the Tests panel",
  json: "the JSON view and editor",
  "binding-picker": "the binding picker",
  "advanced-fields": "the inspector's component id and data key",
  agent: "the agent tools (WebMCP) over the builder, a lazy chunk; opt-in, not part of all"
};

/** The workspaces a feature owns; the Form workspace has no feature (it is always there). */
const WORKSPACE_FEATURES = {
  logic: "logic",
  data: "data",
  languages: "languages",
  journeys: "journeys",
  pdf: "pdf",
  print: "print"
} as const satisfies Partial<Record<string, BuilderFeature>>;

/** The shell panels a feature owns (strip ids). The other panels need no feature. */
const PANEL_FEATURES = {
  chrome: "header-footer",
  variables: "variables",
  tests: "tests"
} as const satisfies Partial<Record<string, BuilderFeature>>;

/** The set of parts that exist: `undefined` is "no list given", where every part does. */
export type BuilderFeatureSet = ReadonlySet<BuilderFeature> | undefined;

const KNOWN = new Set<string>([...BUILDER_FEATURES, ...BUILDER_FEATURE_PRESETS, "form"]);

/** What has been said already on this page: a token or a restriction is reported once. */
const said = new Set<string>();

/** `console.warn`s a message the first time its key comes up on a page. */
export function warnBuilderFeatureOnce(key: string, message: string): void {
  if (said.has(key)) {
    return;
  }
  said.add(key);
  console.warn(`datum-builder: ${message}`);
}

/** Forgets what was reported, for a test that checks a warning again. */
export function resetBuilderFeatureWarnings(): void {
  said.clear();
}

/**
 * The parts a `features` value names. `undefined`, `null` and an absent attribute give
 * `undefined` (everything exists); a list that names nothing (`""`, `"minimal"`, only unknown
 * tokens) gives the empty set, which is the Form workspace alone. Accepts the attribute's text or
 * an array of tokens.
 *
 * A token that starts with `-` takes a part out: `all -pdf` is every part but the PDF side, and
 * so is `-pdf` alone, since a list made only of exclusions starts from `all`. An exclusion wins
 * wherever it stands and over the same part named beside it. An exclusion nobody knows (`-pfd`,
 * `-all`, `-form`) is reported like any unknown token, and the list is then no longer "only
 * exclusions": it starts from nothing, so a typo can only narrow what exists.
 */
export function parseBuilderFeatures(value: string | readonly string[] | null | undefined): BuilderFeatureSet {
  if (value === undefined || value === null) {
    return undefined;
  }
  const tokens = (typeof value === "string" ? value.split(/[\s,]+/) : value.flatMap((entry) => String(entry).split(/[\s,]+/)))
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== "");
  const listed = new Set<BuilderFeature>();
  const excluded = new Set<BuilderFeature>();
  let onlyExclusions = tokens.length > 0;
  for (const token of tokens) {
    if (token.startsWith("-") && (BUILDER_FEATURES as readonly string[]).includes(token.slice(1))) {
      excluded.add(token.slice(1) as BuilderFeature);
      continue;
    }
    onlyExclusions = false;
    if (token === "all") {
      for (const feature of ALL_FEATURES) {
        listed.add(feature);
      }
    } else if ((BUILDER_FEATURES as readonly string[]).includes(token)) {
      listed.add(token as BuilderFeature);
    } else if (!KNOWN.has(token)) {
      warnBuilderFeatureOnce(`unknown:${token}`, `unknown feature "${token}" ignored (known: ${[...BUILDER_FEATURE_PRESETS, ...BUILDER_FEATURES].join(", ")}, and -<feature> to leave one out)`);
    }
  }
  if (onlyExclusions) {
    for (const feature of ALL_FEATURES) {
      listed.add(feature);
    }
  }
  for (const feature of excluded) {
    listed.delete(feature);
  }
  return listed;
}

/**
 * A `features` value as the one string the property gives back: the parts in the table's order
 * separated by spaces, `all` when every part `all` names is named (the opt-in tokens printed
 * after it: `all agent`), `minimal` when none is; `undefined` for no list at all.
 */
export function normalizeBuilderFeatures(value: string | readonly string[] | null | undefined): string | undefined {
  const set = parseBuilderFeatures(value);
  if (set === undefined) {
    return undefined;
  }
  if (ALL_FEATURES.every((feature) => set.has(feature))) {
    return ["all", ...BUILDER_OPT_IN_FEATURES.filter((feature) => set.has(feature))].join(" ");
  }
  if (set.size === 0) {
    return "minimal";
  }
  return BUILDER_FEATURES.filter((feature) => set.has(feature)).join(" ");
}

/**
 * Whether a part exists: without a list, every part but the opt-in ones; with one, only what
 * the list names. An opt-in token is never on by default.
 */
export function featureOn(set: BuilderFeatureSet, feature: BuilderFeature): boolean {
  return set === undefined ? !OPT_IN.has(feature) : set.has(feature);
}

/** Whether an opt-in part exists: only when a list names it; never for an absent list. */
export function optInFeatureOn(set: BuilderFeatureSet, feature: BuilderOptInFeature): boolean {
  return set?.has(feature) === true;
}

/** The feature a workspace needs; none for the Form workspace. */
export function workspaceFeature(workspace: string): BuilderFeature | undefined {
  return (WORKSPACE_FEATURES as Record<string, BuilderFeature | undefined>)[workspace];
}

/** The feature a shell panel needs; none for a panel that is always there. */
export function panelFeature(panel: string): BuilderFeature | undefined {
  return (PANEL_FEATURES as Record<string, BuilderFeature | undefined>)[panel];
}

/** Whether the list lets a workspace exist (the Form workspace always). */
export function workspaceAllowed(set: BuilderFeatureSet, workspace: string): boolean {
  const feature = workspaceFeature(workspace);
  return feature === undefined || featureOn(set, feature);
}

/** Whether the list lets a shell panel exist. */
export function panelAllowed(set: BuilderFeatureSet, panel: string): boolean {
  const feature = panelFeature(panel);
  return feature === undefined || featureOn(set, feature);
}

/**
 * What the master list and the attributes that can only restrict leave of the PDF and Journeys
 * sides. A side is on when the list allows it, its own attribute is not `"off"` and its workspace
 * is not hidden; an attribute that asks for it while the list leaves it out is ignored, with one
 * warning.
 */
export interface BuilderSides {
  pdf: boolean;
  journeys: boolean;
}

export function builderSides(input: {
  features: BuilderFeatureSet;
  pdf: string | undefined;
  journeys: string | undefined;
  hiddenWorkspaces: readonly string[];
}): BuilderSides {
  const sides: BuilderSides = { pdf: false, journeys: false };
  for (const side of ["pdf", "journeys"] as const) {
    const attribute = input[side];
    const requested = attribute !== undefined && attribute.trim() !== "" && attribute.trim() !== "off";
    if (!featureOn(input.features, side)) {
      if (requested) {
        warnBuilderFeatureOnce(`ignored:${side}`, `${side} attribute ignored: not in features`);
      }
      continue;
    }
    sides[side] = attribute?.trim() !== "off" && !input.hiddenWorkspaces.includes(side);
  }
  return sides;
}
