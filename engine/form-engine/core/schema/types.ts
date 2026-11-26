export interface FormMetadata {
  name?: string;
  description?: string;
  tags?: string[];
}

/**
 * One locale the form can be viewed in. The `label` is the locale's name as a language
 * switcher shows it — in that language ("Français (Canada)"), the way a person looking for
 * their language reads it. Authored in the form, so the same definition names its locales
 * the same way under every host. Absent, the renderer names the locale itself
 * (`Intl.DisplayNames`, falling back to the code).
 */
export interface SupportedLocale {
  code: string;
  label?: string;
}

export interface LocalizationConfiguration {
  defaultLocale?: string;
  /**
   * The locales a person may view the form in, in the order a switcher offers them, each
   * `{ code, label? }`. Read through `supportedLocaleEntries` / `supportedLocaleCodes` /
   * `supportedLocaleOptions` (`core/localization/supported-locales.ts`) rather than indexing
   * the array directly.
   */
  supportedLocales?: SupportedLocale[];
}

export interface AccessibilityConfiguration {
  /**
   * Whether a failed check takes focus to the first field in error (the default), or `false` to
   * keep it on the error summary. Beneath a host's own `errorPresentation.focusFirstError`; a
   * binding that sends focus to the summary anyway (`errorFocus`) is not changed by `true`.
   */
  focusFirstError?: boolean;
}

import type { RuleSource } from "../expressions/expression.js";
import type { CollectionBinding } from "./collection.js";
import type { JourneyConfiguration } from "./journey.js";
import type { FormTestConfiguration } from "../form-tests/form-test-types.js";
import type { PdfConfiguration } from "./pdf-layout.js";
import type { FormTranslations } from "../localization/translations.js";

/**
 * Declarative rule attachments on a component. Each entry is a {@link RuleSource}: a
 * FEEL-subset formula string (`'session = "both" and not(empty(email))'`), an expression tree
 * (the engine's internal form, still accepted as written), or the object form
 * `{ formula | expression, run }` that also says where the rule runs (`"both"`, the default,
 * `"browser"`, `"server"` or `"server-secret"`). A runtime compiles the definition into a copy
 * whose formulas are trees before it reads a rule (`core/expressions/compile.ts`), and
 * evaluates each against scoped contexts (form / ancestor / row / component / host) with the
 * day the host supplies (`today()`). A formula that does not parse reads as no rule, and the
 * form root's `configuration.formulaErrors` (`"warn" | "fail"`, default `"fail"`) says whether that is warned about or refused; a host's own
 * setting overrides it.
 */
export interface ComponentRules {
  /** When falsy, the component is effectively hidden. Defaults to visible. */
  visibleWhen?: RuleSource;
  /** When truthy, the component is required (subject to hidden-required policy). */
  requiredWhen?: RuleSource;
  /** When falsy, the component is disabled. Defaults to enabled. */
  enabledWhen?: RuleSource;
  /** When truthy, the component is read-only. */
  readonlyWhen?: RuleSource;
  /**
   * A check on the answer: while the field holds a non-empty answer and this is not
   * `true`, the answer is refused with the code `rule`, worded by the component's
   * `configuration.messages.rule`. Read where `requiredWhen` is (a component holding an answer of
   * its own, outside a repeating section), over the same settled view, by the browser and the
   * sandbox alike. Unlike the other rules it fails closed: under `formulaErrors: "warn"` a formula
   * that does not parse refuses every answer rather than being dropped.
   */
  validWhen?: RuleSource;
  /**
   * Calculation: the component value is recomputed from this expression. It comes to no
   * answer when the expression does (an `if` with no case holding and no `else`).
   */
  value?: RuleSource;
  /**
   * On a data grid: the fewest rows a submission may carry, worked out from the
   * answers. Evaluated form-scoped (a `row.` read is warned about as `rule.unsupportedScope` and
   * never evaluated: the bound belongs to the whole grid) to a number; a finite whole number from
   * 0 (one past 500 read as 500) wins over `configuration.minRows`, anything else leaves that
   * fixed bound in force. Both the browser and the sandbox kernel evaluate it, under the same run
   * scopes as every rule. On any other component it does nothing (`component.dataGrid.boundsRule`).
   */
  minRows?: RuleSource;
  /**
   * On a data grid: the most rows a submission may carry, worked out as
   * {@link minRows} is; it wins over `configuration.maxRows`, and one below the resolved minimum
   * reads as the minimum.
   */
  maxRows?: RuleSource;
  /** Applied only while the current value is `undefined`. Browser-side only: `run` may not name the server. */
  defaultValue?: RuleSource;
  /** Option/collection filter predicate (consumed by data + collection runtimes). Browser-side only. */
  filter?: RuleSource;
  /** On wizard-step containers: navigation into/out of the step is gated on truthiness. Browser-side only. */
  navigationGating?: RuleSource;
}

export interface ComponentNode {
  id: string;
  type: string;
  /**
   * The component's settings, by type. On the form root it also carries the form-wide
   * settings a runtime reads with `kernelReadEnum`, among them `formulaErrors`
   * (`"warn" | "fail"`): what a runtime does with a rule whose formula does not
   * parse, when the host does not say (see {@link ComponentRules}).
   * On the form root it may also carry agentTools ("allowed" | "off"; absent: not provided),
   * the author's switch for assistants in the browser: a <datum-form> whose
   * agent-access is "definition" registers its agent tools live only when it is "allowed".
   * Any other value reads as not provided.
   */
  configuration: unknown;
  rules?: ComponentRules;
  /** Present on repeating sections / data grids. */
  collection?: CollectionBinding;
  children?: Record<string, ComponentNode[]>;
}

export interface FormDefinition {
  id: string;
  version: string;
  schemaVersion: string;
  metadata?: FormMetadata;
  root: ComponentNode;
  localization?: LocalizationConfiguration;
  accessibility?: AccessibilityConfiguration;
  /**
   * The form's PDF layouts: named documents rendered from the same answers, each a
   * generated flow tree or an existing template to fill. Additive; a form without one gets a
   * layout derived from its tree.
   */
  pdf?: PdfConfiguration;
  /**
   * The form's journeys: multi-page flows over the same components, each a list of
   * pages referencing component ids, with conditions and routes between them. Additive; a form
   * without one renders on one page.
   */
  journey?: JourneyConfiguration;
  /**
   * The form's tests: scenarios written in the test language, each one `test "…"`
   * block as the author wrote it. Additive. They are the author's, so the public copy of the
   * definition (`publicDefinition`) drops them and a form served to a browser never carries them.
   */
  tests?: FormTestConfiguration;
  /**
   * The form's translations: locale → kind (`form`, `components`, `chrome`,
   * `journeys`, `pdf`) → the owner's id → a tree of property segments whose leaves are
   * `{ text, source }`. Every text elsewhere in the definition is a plain string in the default
   * language. Read and written only through `core/localization/translations.ts`
   * (`readFormTranslations`, `resolveText`, `writeTranslation`, …).
   */
  translations?: FormTranslations;
  /**
   * The base engine type of every component type the form uses that is not the engine's own: a
   * plugin's or a design-system binding's type → the engine type it is read as (a `gcds-date`
   * → `date`). Validation, the sandbox and the PDF program read such a component as its base
   * from this map alone, with no plugin or binding code (`core/schema/component-kinds.ts`). The
   * structure check refuses an entry whose base is not an engine type, or that maps an engine
   * type. A type absent from the map and not the engine's is unknown.
   */
  kinds?: Record<string, string>;
}

export interface SlotDefinition {
  id: string;
  multiple: boolean;
  min?: number;
  max?: number;
  allowedTypes?: string[];
  allowReorder?: boolean;
  allowNested?: boolean;
  /**
   * What the builder's canvas says in the slot while it is empty, in place of its "Drop
   * components here." — what goes there, for a slot that takes only some types (a journey's
   * pages, a page's routes). Builder chrome only: the running form draws nothing
   * for an empty slot.
   */
  emptyHint?: string;
}

export interface ChildrenDefinition {
  slots: SlotDefinition[];
}

export interface PathSegment {
  key: string;
  index?: number;
}

export interface ComponentPath {
  segments: PathSegment[];
}
