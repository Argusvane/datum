/**
 * The Logic workspace's model: every rule the form and
 * its outputs hold, as data the rule list and the rule editor draw from. Types only; the walker
 * that builds them is `logic-model.ts`, the words `builder-texts.ts`.
 *
 * Logic edits the form's controller for the form's own rules. A journey's Go to rule (a route) is
 * edited through the Journeys mode's host (`logic-journey-host.ts`),
 * which writes the journey's own controller; where the builder has no such host the route is
 * listed read-only, as a PDF layout's `when` always is, each with the document to open in its
 * designer.
 */
import type { Expression, RunScope } from "../../core/expressions/expression.js";
import type { HiddenValueBehavior } from "../../core/state/effective-state.js";

/** What a rule does, in the list's words. */
export type LogicRuleKind =
  /** `rules.visibleWhen` on a field or container: "Show X when …". */
  | "show"
  /** `rules.visibleWhen` whose top node is `not` over a condition (not a bare field): "Hide X when …". */
  | "hide"
  /** `rules.requiredWhen`: "Require X when …". */
  | "require"
  /** `rules.validWhen`, with the field's `messages.rule`: "Accept X only when …". */
  | "validate"
  /** `rules.enabledWhen`: "Enable X when …". */
  | "enable"
  /** `rules.readonlyWhen`: "Make X read-only when …". */
  | "readonly"
  /** `rules.value`: "Calculate X as …". */
  | "calculate"
  /** `rules.defaultValue`: "Start X at …". */
  | "default"
  /** `rules.filter`: "Offer X's options where …". */
  | "filter"
  /** `rules.minRows` on a data grid: "Require at least … rows in X". */
  | "min-rows"
  /** `rules.maxRows` on a data grid: "Allow at most … rows in X". */
  | "max-rows"
  /** `rules.navigationGating` on a step: "Continue past step X only when …". */
  | "gate"
  /** `rules.visibleWhen` on a step of a `steps` container: "Show step X when …". */
  | "show-step"
  /** A `hide` rule on a step: "Hide step X when …". */
  | "hide-step"
  /** A journey route, "Go to step S when …" (or always, when it has no condition); editable where a host writes the journey. */
  | "route"
  /** A PDF layout's `when`, read-only: "Print PDF layout L when …". */
  | "pdf-layout";

/** The rule list's filters (the left column of the Logic surface), in display order. */
export type LogicFilterId = "all" | "show" | "require" | "calculate" | "steps" | "journeys" | "pdf";

/** One piece of a rule's sentence: words, a field or document named as a token, a value, an expression. */
export interface LogicToken {
  kind: "verb" | "word" | "field" | "value" | "expression" | "document";
  text: string;
  /** For `field`: the component it names (the list selects it on a click). */
  componentId?: string | undefined;
  /** For `field`: the path names no field in the form (drawn in the danger wash, as the box draws it). */
  unknown?: boolean;
}

/**
 * Where a rule lives. `form` rules are editable in Logic; so are `journeys` rules where the
 * builder has a Journeys mode to write them (`LogicRule.editable`); layouts are not.
 */
export type LogicRuleSource =
  | { mode: "form" }
  | {
      mode: "journeys";
      journeyId: string;
      /** The step the rule leaves, by its page id. */
      pageId: string;
      /** Its position among the step's written routes: the order they are tried in. */
      routeIndex?: number | undefined;
      /** How many written routes the step has, for "Tried 1st of 2". */
      routeCount?: number | undefined;
    }
  | { mode: "pdf"; layoutId: string };

/** The heading a rule is listed under: the step its target is on, the form, or an outputs group. */
export interface LogicGroup {
  /** Stable: `step:<id>`, `form`, `steps`, `journeys`, `outputs`. */
  id: string;
  label: string;
  kind: "step" | "form" | "steps" | "journeys" | "outputs";
}

export interface LogicRule {
  /** Stable across walks: `<source>:<owner id>:<rule key>[:<index>]`. */
  id: string;
  kind: LogicRuleKind;
  filter: Exclude<LogicFilterId, "all">;
  source: LogicRuleSource;
  /** Whether Logic edits it: form rules, and journey routes where the Journeys mode writes them. */
  editable: boolean;
  /** What the rule acts on: a component (form rules), a page, a route's target page or a layout. */
  target: { id: string; label: string; type: string };
  /** `visibleWhen`, `requiredWhen`, … for form rules; `when` for journeys and layouts. */
  ruleKey: string;
  /** The tree the stored rule stands for; `undefined` for a formula that does not parse. */
  expression: Expression | undefined;
  /**
   * The rule as the editor opens it: the stored formula (bare or in the object form), else the
   * tree printed with ids (`feel-print.ts`). A `hide` rule's text is still the whole rule.
   */
  formula: string;
  /** Whether the rule is stored as text (a string or the object form); a tree opens printed and is written back as text when edited. */
  storedAsText: boolean;
  /** Where the rule runs (`both` when it says nothing); journeys and layouts keep their own sides. */
  run: RunScope;
  group: LogicGroup;
  /** For `show`: what happens to the answer while hidden (`configuration.hiddenValueBehavior`), as stored; absent = "exclude-from-submission", the default. */
  hiddenValueBehavior?: HiddenValueBehavior | undefined;
  /** For `validate`: the field's `configuration.messages.rule` as stored; absent when it has none. */
  message?: unknown;
  /** The rule as one sentence ("Show [Registered agent] when [Business structure] is [Partnership] or [Corporation]"). */
  sentence: LogicToken[];
  /** Form-scoped paths the expression reads (first segment = the component it reads). */
  reads: string[];
}

/** A problem the walk found across rules, shown above the list ("Two rules hide each other's answers…"). */
export interface LogicDiagnostic {
  code:
    | "visibility-cycle"
    | "reads-missing-field"
    | "reads-later-step"
    /** A stored formula the parser refuses; the rule is listed with its text. */
    | "formula-invalid"
    /** A formula a form rename could not follow because it does not parse: it still names the old id. */
    | "rename-unparsed"
    /** A server-only or secret rule reading `host.` (an error) or the clock (a warning), as journey-diagnostics names it. */
    | "rule.server-cannot-run"
    /** A browser-only required rule, which the server does not enforce. */
    | "rule.browser-only-required"
    /** A secret rule reading a field a browser-only rule may hide. */
    | "rule.secret-reads-browser-hidden";
  /** Absent: a warning. */
  severity?: "error" | "warning" | undefined;
  message: string;
  /** The rules it is about, for "Show them". */
  ruleIds: string[];
}

/** A journey the form holds, as the rule editor's pickers need it: its steps in order. */
export interface LogicJourneySummary {
  id: string;
  /** The journey's name, else its id. */
  label: string;
  pages: Array<{
    /** The step's page id. */
    id: string;
    /** Its title, else its first form field's label, else its id. */
    label: string;
    /** An exit step: it stops the journey, so no rule leaves it. */
    exit: boolean;
    /** The path takes no rule from this step: an exit step, or a review step (which goes to the end). A rule cannot leave it. */
    stops: boolean;
    /** Whether a route can name it: the first step written under its id (a route finds the first). */
    firstOfId: boolean;
    /** Written routes on it with no condition, by position: a rule added to the step goes before the first. */
    unconditional: number[];
    /** How many written routes it has. */
    routes: number;
  }>;
}

/** The rule list's model. */
export interface LogicModel {
  rules: LogicRule[];
  /** Rules per filter, `all` included. */
  counts: Record<LogicFilterId, number>;
  /** The groups in display order: the steps (or the form), then Steps, Journeys, PDF layouts (id `outputs`). */
  groups: LogicGroup[];
  /**
   * The form's steps as the page-flow strip shows them, when it has a `steps` container: each
   * step's label, how many rules target components on it, and whether a rule decides it is shown.
   */
  steps: Array<{ id: string; label: string; ruleCount: number; conditional: boolean }>;
  diagnostics: LogicDiagnostic[];
  /** The journeys the form holds (live from the Journeys mode when the builder has one), in order. */
  journeys: LogicJourneySummary[];
}
