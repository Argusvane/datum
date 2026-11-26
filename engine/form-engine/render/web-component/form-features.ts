/**
 * Which optional capabilities a form element has. The `features` attribute (and the
 * `features` property) of `<datum-form>`, `<datum-form-renderer>` and `<datum-form-host>` is a
 * list of the ones that exist on this page:
 *
 * - absent: today's behaviour exactly, every capability there for the attributes and properties
 *   that configure it;
 * - present: only the listed ones. The per-feature attributes (`pdf`, `wasm`, `validate-url`,
 *   `draft`, `translations`, `data-sources`, `signing-*`) still configure a listed feature and
 *   can only narrow it further; none of them can switch on a feature the list leaves out.
 *
 * A capability that is left out is left out of behaviour, not of the file: what the page or the
 * definition asks of it is ignored with one console warning, its methods reject (or throw, where
 * they are synchronous) with a message naming the feature, and the lazy chunks that belong to it
 * (the PDF module, the sandbox, the WebAuthn code, the server validator, the journey
 * diagnostics) are never requested.
 *
 * One model for every element that reads the list: it lives in the engine because the engine's
 * own renderer element is one of them, and `packages/datum` re-exports it. A token an
 * element has nothing behind (the engine's renderer has no WebAuthn, no draft store) is still a
 * token: it is accepted and gates nothing there. A pure model; it touches no DOM.
 *
 * One token is opt-in: `agent`, the WebMCP agent tools over the form. It is not in
 * `all` and an absent list does not include it, so a page that says nothing never registers
 * tools; `features="all agent"` turns it on. {@link formFeatureOn} is the one place that rule is
 * read, so no caller can take an absent list for "agent on".
 */
export const FORM_FEATURES = ["journeys", "print", "translations", "data-sources", "drafts", "server-validation", "signing", "pdf", "wasm", "agent"] as const;

export type FormFeature = (typeof FORM_FEATURES)[number];

/** The tokens a page must name to have: never part of `all`, never implied by an absent list. */
export const FORM_OPT_IN_FEATURES = ["agent"] as const;

export type FormOptInFeature = (typeof FORM_OPT_IN_FEATURES)[number];

/** The values of `agent-access` on <datum-form>: how the host's policy meets the definition's switch. */
export const AGENT_ACCESS_VALUES = ["always", "definition", "never"] as const;
export type AgentAccess = (typeof AGENT_ACCESS_VALUES)[number];
/**
 * What <datum-form> does with its agent tools when agent-access is absent:
 * "definition", the form's root.configuration.agentTools decides. Changing the default to
 * "always" widens what every form exposes, so it is a deliberate policy change.
 */
export const DEFAULT_AGENT_ACCESS: AgentAccess = "definition";

/** Whether a token is one of {@link FORM_OPT_IN_FEATURES}. */
export function isOptInFormFeature(feature: string): feature is FormOptInFeature {
  return (FORM_OPT_IN_FEATURES as readonly string[]).includes(feature);
}

/** The preset tokens: `all` is every feature but the opt-in ones, `minimal` a single-page form that renders, validates (rules and formulas included) and submits, and nothing more. */
export const FORM_FEATURE_PRESETS: Readonly<Record<"all" | "minimal", readonly FormFeature[]>> = {
  all: FORM_FEATURES.filter((feature) => !isOptInFormFeature(feature)),
  minimal: []
};

/**
 * Whether a feature exists under a resolved list: an absent list (`undefined`) is every
 * feature but the opt-in ones; a present list is exactly what it names. The elements' own
 * `allows()` reads the absent list as "everything", which is right for every token but `agent`;
 * this is the test to use for an opt-in token.
 */
export function formFeatureOn(list: readonly FormFeature[] | undefined, feature: FormFeature): boolean {
  return list === undefined ? !isOptInFormFeature(feature) : list.includes(feature);
}

/** What the page may write as a list: the attribute's words, or the same tokens as an array. */
export type FormFeaturesInput = string | readonly string[];

/** A resolved list, with the words in it that are not features. */
export interface ParsedFormFeatures {
  /** The features that exist, in the order {@link FORM_FEATURES} lists them. */
  features: readonly FormFeature[];
  /** Tokens that name no feature or preset: dropped (never read as "everything"), and reported by the element. */
  unknown: readonly string[];
}

const FEATURE_SET: ReadonlySet<string> = new Set(FORM_FEATURES);

/** Words separated by spaces and/or commas. */
function words(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Reads a features list: tokens separated by spaces or commas, case-insensitive, presets
 * expanded. An empty list is a list: it names no feature, which is the same as `minimal`.
 *
 * A word that starts with `-` takes a feature out: `all -drafts` is every feature but drafts,
 * and so is `-drafts` alone, since a list made only of exclusions starts from `all`. An exclusion
 * wins wherever it stands (`-drafts all` reads the same), and it wins over the same feature
 * named beside it.
 *
 * A word that is neither a feature nor a preset (an exclusion of one included: `-all`,
 * `-draft`) is left out and returned in `unknown`, so a typo can only narrow what exists, never
 * widen it: a list holding such a word is no longer "only exclusions", so it starts from
 * nothing rather than from `all`.
 */
export function parseFormFeatures(input: FormFeaturesInput): ParsedFormFeatures {
  const tokens = (typeof input === "string" ? words(input) : input.flatMap((token) => words(token))).map((token) => token.toLowerCase());
  const named = new Set<FormFeature>();
  const excluded = new Set<FormFeature>();
  const unknown: string[] = [];
  let onlyExclusions = tokens.length > 0;
  for (const token of tokens) {
    if (token.startsWith("-") && FEATURE_SET.has(token.slice(1))) {
      excluded.add(token.slice(1) as FormFeature);
      continue;
    }
    onlyExclusions = false;
    if (token === "all" || token === "minimal") {
      for (const feature of FORM_FEATURE_PRESETS[token]) {
        named.add(feature);
      }
    } else if (FEATURE_SET.has(token)) {
      named.add(token as FormFeature);
    } else if (!unknown.includes(token)) {
      unknown.push(token);
    }
  }
  if (onlyExclusions) {
    for (const feature of FORM_FEATURE_PRESETS.all) {
      named.add(feature);
    }
  }
  return { features: FORM_FEATURES.filter((feature) => named.has(feature) && !excluded.has(feature)), unknown };
}
