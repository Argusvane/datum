import type { ComponentPath } from "../schema/types.js";
import { stringifyComponentPath } from "../tree/component-path.js";

export type FormValues = Record<string, unknown>;

/**
 * The answer stored at `path`, read as an own key only: a component whose id or data key is
 * `constructor` or `toString` has its own answer, never the member every object inherits.
 */
export function ownValue(values: FormValues, path: string): unknown {
  return Object.prototype.hasOwnProperty.call(values, path) ? values[path] : undefined;
}

export interface NavigationState {
  mode: "normal" | "wizard";
  currentStepId?: string;
  visitedSteps: Set<string>;
  completedSteps: Set<string>;
}

export interface ValidationState {
  valid: boolean;
  lastValidatedAt?: number;
  /**
   * The value paths an async validation stage is judging right now (`ValidationStage.paths`):
   * set as such a stage starts and cleared as it settles, or once the run it belongs to is
   * replaced by a newer check of the path. The store always holds one (empty when nothing is
   * out); optional so a state built by hand needs none.
   */
  pending?: ReadonlySet<string>;
}

export type SubmissionStatus = "idle" | "submitting" | "submitted" | "rejected";

export interface SubmissionState {
  status: SubmissionStatus;
  attempts: number;
  lastSubmissionId?: string;
  lastAcceptedAt?: number;
}

/**
 * Where a person is in a journey. Separate from {@link NavigationState}, which is
 * the steps container's: a journey's pages are not nodes of the tree.
 */
export interface JourneyState {
  journeyId: string;
  /** The page being shown. */
  pageId: string;
  /** Pages the person has continued from; kept to the pages on the current path. */
  completedPages: Set<string>;
  /**
   * What the presentation's worked-out values last wrote, by the target's value
   * path: a worked-out value whose sources are all unanswered clears its target only while the
   * target still holds what it wrote, so an answer that came from elsewhere — a prefill, a
   * draft — survives. Kept in drafts, so a resumed journey knows its own writes; dropped with
   * the journey. Absent until a worked-out value writes.
   */
  written?: Record<string, unknown>;
  /**
   * The review page a Change link left (`goToPage(id, { direction: "change" })`): while it is
   * set, Continue and Back go to the first page on the path not yet completed, else back to it.
   * Cleared on arriving there and by any other move — a jump, an error shown, a restart, the
   * path no longer taking it. Kept in drafts. Absent otherwise.
   */
  returnTo?: string;
  /*
   * No record of what the host's server passed: the runtime remembers that in memory only, and
   * a draft never carries it — a stored "clean" is a claim a client could forge.
   */
}

export interface FormState {
  values: FormValues;
  touched: Set<string>;
  dirty: Set<string>;
  validation: ValidationState;
  submission: SubmissionState;
  navigation: NavigationState;
  locale: string;
  /** The journey running, when the form is being filled page by page. */
  journey?: JourneyState;
}

/** Whether the key continues, from `from`, as `<digits>].` (the rest of a row field's key). */
function isRowFieldKeyTail(key: string, from: number): boolean {
  let at = from;
  while (at < key.length && key.charCodeAt(at) >= 48 && key.charCodeAt(at) <= 57) {
    at += 1;
  }
  return at > from && key.startsWith("].", at);
}

/** The state typed read-only: the values and the sets cannot be written through it. */
export type DeepReadonlyState = Readonly<
  Omit<FormState, "values" | "touched" | "dirty"> & {
    values: Readonly<FormValues>;
    touched: ReadonlySet<string>;
    dirty: ReadonlySet<string>;
  }
>;

export class FormStateStore {
  private state: FormState;

  constructor(initialLocale = "en") {
    this.state = {
      values: {},
      touched: new Set(),
      dirty: new Set(),
      validation: { valid: true, pending: new Set() },
      submission: { status: "idle", attempts: 0 },
      navigation: {
        mode: "normal",
        visitedSteps: new Set(),
        completedSteps: new Set()
      },
      locale: initialLocale
    };
  }

  /**
   * The live state, not copied: for a reader inside the runtime that only reads it and keeps
   * nothing (the orchestrator's recompute). Anything handed outside the runtime (events,
   * drafts, submissions) takes {@link snapshot}'s independent copy instead.
   */
  public readView(): DeepReadonlyState {
    return this.state;
  }

  public snapshot(): FormState {
    const snapshot: FormState = {
      ...this.state,
      touched: new Set(this.state.touched),
      dirty: new Set(this.state.dirty),
      validation: { ...this.state.validation, pending: new Set(this.state.validation.pending) },
      submission: { ...this.state.submission },
      navigation: {
        ...this.state.navigation,
        visitedSteps: new Set(this.state.navigation.visitedSteps),
        completedSteps: new Set(this.state.navigation.completedSteps)
      },
      values: { ...this.state.values }
    };
    if (this.state.journey) {
      snapshot.journey = {
        ...this.state.journey,
        completedPages: new Set(this.state.journey.completedPages),
        ...(this.state.journey.written !== undefined ? { written: { ...this.state.journey.written } } : {})
      };
    }
    return snapshot;
  }

  public setValue(path: ComponentPath, value: unknown): void {
    const key = stringifyComponentPath(path);
    // Own keys only: a field `constructor` never held `Object.prototype.constructor`.
    const previous = Object.prototype.hasOwnProperty.call(this.state.values, key) ? this.state.values[key] : undefined;
    this.state.values[key] = value;

    if (previous !== value) {
      this.state.dirty.add(key);
    }
  }

  /**
   * Writes a value produced by a calculation / default rule. Unlike {@link setValue} this
   * does not mark the field dirty, since the person did not author the change.
   */
  public setComputedValue(path: ComponentPath, value: unknown): void {
    this.state.values[stringifyComponentPath(path)] = value;
  }

  /**
   * Replaces every `collectionPath[i].field` value with the given rows, so form state
   * stays consistent with the collection runtime after a structural row op
   * (add / remove / reorder). Marks the collection path dirty.
   */
  public replaceCollectionValues(
    collectionPath: string,
    rows: ReadonlyArray<Record<string, unknown>>
  ): void {
    // A row field's key is `collectionPath[<digits>].field`: found by prefix and a digit run,
    // not a pattern built and run against every key of the form.
    const prefix = `${collectionPath}[`;
    for (const key of Object.keys(this.state.values)) {
      if (key.startsWith(prefix) && isRowFieldKeyTail(key, prefix.length)) {
        delete this.state.values[key];
      }
    }
    rows.forEach((row, index) => {
      for (const [field, value] of Object.entries(row)) {
        this.state.values[`${collectionPath}[${index}].${field}`] = value;
      }
    });
    this.state.dirty.add(collectionPath);
  }

  public markTouched(path: ComponentPath): void {
    this.state.touched.add(stringifyComponentPath(path));
  }

  public setLocale(locale: string): void {
    this.state.locale = locale;
  }

  public markValidated(timestamp: number = Date.now()): void {
    this.state.validation.lastValidatedAt = timestamp;
  }

  public setValidity(valid: boolean): void {
    this.state.validation.valid = valid;
  }

  /** Marks the value path `path` pending or settled; whether that changed anything. */
  public setPending(path: string, pending: boolean): boolean {
    const current = new Set(this.state.validation.pending);
    if (current.has(path) === pending) {
      return false;
    }
    if (pending) {
      current.add(path);
    } else {
      current.delete(path);
    }
    this.state.validation.pending = current;
    return true;
  }

  /** Marks the start of a submission attempt (increments the attempt counter). */
  public beginSubmission(): void {
    this.state.submission.status = "submitting";
    this.state.submission.attempts += 1;
  }

  public completeSubmission(submissionId: string, acceptedAt: number = Date.now()): void {
    this.state.submission.status = "submitted";
    this.state.submission.lastSubmissionId = submissionId;
    this.state.submission.lastAcceptedAt = acceptedAt;
  }

  public failSubmission(): void {
    this.state.submission.status = "rejected";
  }

  /**
   * Ends an attempt the site stopped before anything was checked or sent (a `beforeSubmit` hook
   * or a value transform threw): back to `idle`, not `rejected`, since nothing in the answers was
   * refused, and the attempt still counts. Without it the form stayed `submitting` until a reload.
   */
  public abandonSubmission(): void {
    this.state.submission.status = "idle";
  }

  public setWizardStep(stepId: string): void {
    this.state.navigation.mode = "wizard";
    this.state.navigation.currentStepId = stepId;
    this.state.navigation.visitedSteps.add(stepId);
  }

  /** Records a step as visited without changing the current step. */
  public visitStep(stepId: string): void {
    this.state.navigation.visitedSteps.add(stepId);
  }

  public markStepCompleted(stepId: string): void {
    this.state.navigation.completedSteps.add(stepId);
  }

  /**
   * The journey state itself, not a copy — for the runtime's own reads, which happen on every
   * render (a {@link snapshot} copies every value). Never handed to a host.
   */
  public peekJourney(): Readonly<JourneyState> | undefined {
    return this.state.journey;
  }

  /** Starts a journey on `pageId`, with nothing completed. Replaces any journey running. */
  public startJourney(journeyId: string, pageId: string): void {
    this.state.journey = { journeyId, pageId, completedPages: new Set() };
  }

  /** Puts back a journey from a draft, as it was saved — what its worked-out values had written included. */
  public restoreJourney(journey: {
    journeyId: string;
    pageId: string;
    completedPages: Iterable<string>;
    written?: Readonly<Record<string, unknown>> | undefined;
    returnTo?: string | undefined;
  }): void {
    this.state.journey = {
      journeyId: journey.journeyId,
      pageId: journey.pageId,
      completedPages: new Set(journey.completedPages)
    };
    if (journey.written !== undefined && Object.keys(journey.written).length > 0) {
      this.state.journey.written = { ...journey.written };
    }
    if (journey.returnTo !== undefined) {
      this.state.journey.returnTo = journey.returnTo;
    }
  }

  /** Sets, or with `undefined` clears, the review page a Change link left ({@link JourneyState.returnTo}). */
  public setJourneyReturn(pageId: string | undefined): void {
    const journey = this.state.journey;
    if (!journey) {
      return;
    }
    if (pageId === undefined) {
      delete journey.returnTo;
    } else {
      journey.returnTo = pageId;
    }
  }

  /**
   * Records what a worked-out value of the running presentation wrote at `targetPath`, or forgets it (`held: false`) once the target no longer holds it. Nothing
   * without a journey.
   */
  public setJourneyWritten(targetPath: string, value: unknown, held = true): void {
    const journey = this.state.journey;
    if (!journey) {
      return;
    }
    if (!held) {
      if (journey.written !== undefined) {
        delete journey.written[targetPath];
        if (Object.keys(journey.written).length === 0) {
          delete journey.written;
        }
      }
      return;
    }
    // Spread rather than assigned into a literal: a path named `__proto__` stays a key.
    journey.written = { ...(journey.written ?? {}), [targetPath]: value };
  }

  public setJourneyPage(pageId: string): void {
    if (this.state.journey) {
      this.state.journey.pageId = pageId;
    }
  }

  public markPageCompleted(pageId: string): void {
    this.state.journey?.completedPages.add(pageId);
  }

  /** Keeps only the completed pages in `pageIds` — the current path, after answers rerouted it. */
  public keepCompletedPages(pageIds: readonly string[]): void {
    const journey = this.state.journey;
    if (!journey) {
      return;
    }
    for (const pageId of [...journey.completedPages]) {
      if (!pageIds.includes(pageId)) {
        journey.completedPages.delete(pageId);
      }
    }
  }

  public endJourney(): void {
    delete this.state.journey;
  }

  /**
   * Replaces values, touched, dirty, locale and the steps container's navigation from a draft.
   * A journey is left as it is: {@link restoreJourney} puts back the draft's own.
   */
  public hydrate(snapshot: {
    values: FormValues;
    touched: string[];
    dirty: string[];
    locale: string;
    navigation?: {
      mode?: "normal" | "wizard";
      currentStepId?: string;
      visitedSteps?: string[];
      completedSteps?: string[];
    };
  }): void {
    // Hydration replaces runtime state from a persisted draft snapshot.
    this.state.values = { ...snapshot.values };
    this.state.touched = new Set(snapshot.touched);
    this.state.dirty = new Set(snapshot.dirty);
    this.state.locale = snapshot.locale;

    this.state.navigation = {
      mode: snapshot.navigation?.mode ?? "normal",
      visitedSteps: new Set(snapshot.navigation?.visitedSteps ?? []),
      completedSteps: new Set(snapshot.navigation?.completedSteps ?? [])
    };
    if (snapshot.navigation?.currentStepId !== undefined) {
      this.state.navigation.currentStepId = snapshot.navigation.currentStepId;
    }
  }
}
