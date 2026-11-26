import type { ValidationContext, ValidationResult } from "../schema/contracts.js";
import type { FormValues } from "../state/form-state.js";
import type { PageChangeDirection } from "../journey/journey-types.js";

export interface BeforeValidationHookContext {
  values: FormValues;
  validationContext: ValidationContext;
}

export interface AfterValidationHookContext {
  values: FormValues;
  validationContext: ValidationContext;
  result: ValidationResult;
}

/**
 * The page's account of the answers the agent tools wrote. Client-side and
 * advisory: a server trusts it as far as it trusts the values. Covers the agent tools only, never
 * an assistant that types into the page like a person. Never in the canonical envelope.
 *
 * Limits: an assistant driving the page like a person (a browser extension typing, computer use)
 * looks like the person; values the form works out itself (calculations, `value` rules, defaults)
 * are never attributed, save a worked-out copy of a presentation field the agent wrote; values a
 * host prefilled, a draft brought back or an earlier page load wrote carry no agent mark; nothing
 * survives a reload or a draft round trip unless the host keeps it.
 *
 * Core carries the type without knowing agents: the runtime copies what the element hands it
 * into the submit hook contexts and nowhere else.
 */
export interface AgentProvenance {
  version: 1;
  /** An agent write tool changed an answer on this form since it loaded (sticky). */
  involved: boolean;
  /** Value paths among the submitted values whose last writer is the agent tools; sorted; at most 2 000. */
  paths: string[];
  /** Collections whose rows the agent tools added, removed or replaced last. */
  tables: string[];
  /** false when some agent writes can no longer be traced (a rebuild, a draft restore, the tools withdrawn after writing). */
  complete: boolean;
  /** Who started this submission or download: the submit / download_pdf tool, or anything else on the page (the person's button, Enter, host script). */
  submittedBy: "agent" | "page";
  /** Agent sessions opened on this form since it loaded, and whether one is open now. */
  sessions: number;
  sessionOpen: boolean;
  /** When the agent tools last wrote an answer (ms since epoch); absent when never. */
  lastWriteAt?: number;
  /** More than 2 000 paths. */
  truncated?: true;
}

export interface BeforeSubmitHookContext {
  values: FormValues;
  modeId: string;
  /**
   * A frozen copy of the page's agent provenance, present on every submit of
   * a form element the agent tools were registered for since it loaded: the person's button,
   * the host's `submit()` and the agent's `submit` tool alike. Absent when they never were.
   */
  agent?: Readonly<AgentProvenance>;
}

export interface AfterSubmitHookContext {
  values: FormValues;
  modeId: string;
  submissionId: string;
  /** The same frozen object `beforeSubmit` saw. */
  agent?: Readonly<AgentProvenance>;
}

export interface BeforeNavigationHookContext {
  fromStepId?: string;
  toStepId?: string;
  mode: "normal" | "wizard";
}

/**
 * A journey is about to change page on the person's say-so: Continue, Back, a jump,
 * or a Change link on a review page (`"change"`). A hook vetoes the move by throwing; its message comes back as the navigation's
 * `message`. Never run for the moves the runtime makes itself — starting a journey, resuming
 * after the path changed under the page, going to the page an error is on.
 */
export interface BeforePageChangeHookContext {
  journeyId: string;
  fromPageId: string;
  toPageId: string;
  direction: Extract<PageChangeDirection, "forward" | "back" | "jump" | "change">;
  values: FormValues;
}

export interface BeforeDraftSaveHookContext {
  draftId: string;
  values: FormValues;
}

export interface AfterDraftLoadHookContext {
  draftId: string;
  values: FormValues;
}

export interface FormHooks {
  beforeValidation?: Array<(context: BeforeValidationHookContext) => void | Promise<void>>;
  afterValidation?: Array<(context: AfterValidationHookContext) => void | Promise<void>>;
  beforeSubmit?: Array<(context: BeforeSubmitHookContext) => void | Promise<void>>;
  afterSubmit?: Array<(context: AfterSubmitHookContext) => void | Promise<void>>;
  beforeNavigation?: Array<(context: BeforeNavigationHookContext) => void | Promise<void>>;
  beforePageChange?: Array<(context: BeforePageChangeHookContext) => void | Promise<void>>;
  transformValues?: Array<(values: FormValues) => FormValues | Promise<FormValues>>;
  beforeDraftSave?: Array<(context: BeforeDraftSaveHookContext) => void | Promise<void>>;
  afterDraftLoad?: Array<(context: AfterDraftLoadHookContext) => void | Promise<void>>;
}

const HOOK_KEYS: Array<keyof FormHooks> = [
  "beforeValidation",
  "afterValidation",
  "beforeSubmit",
  "afterSubmit",
  "beforeNavigation",
  "beforePageChange",
  "transformValues",
  "beforeDraftSave",
  "afterDraftLoad"
];

/**
 * Concatenates hook arrays key-by-key. Entries from `extra` run after entries from `base`
 * (host hooks first, then plugin-contributed hooks).
 */
export function mergeFormHooks(base: FormHooks, extra: FormHooks | undefined): FormHooks {
  if (!extra) {
    return base;
  }
  const merged: FormHooks = {};
  for (const key of HOOK_KEYS) {
    const combined = [...(base[key] ?? []), ...(extra[key] ?? [])];
    if (combined.length > 0) {
      // Each key's element type is identical between base and extra.
      (merged[key] as unknown[]) = combined;
    }
  }
  return merged;
}

export async function runHookSeries<T>(
  hooks: Array<(context: T) => void | Promise<void>>,
  context: T
): Promise<void> {
  for (const hook of hooks) {
    await hook(context);
  }
}

export async function runValueTransforms(
  transforms: Array<(values: FormValues) => FormValues | Promise<FormValues>>,
  values: FormValues
): Promise<FormValues> {
  let current = { ...values };

  for (const transform of transforms) {
    current = await transform(current);
  }

  return current;
}
