import type { FormValues } from "../../core/state/form-state.js";

export interface FormDraft {
  id: string;
  formId: string;
  formVersion: string;
  runtime: {
    schemaVersion: string;
    rendererVersion: string;
  };
  locale: string;
  values: FormValues;
  state: {
    /** Navigation mode; "normal" when absent. */
    mode?: "normal" | "wizard";
    currentStep?: string;
    touched: string[];
    dirty: string[];
    /** Full wizard progress; [] when absent. */
    visitedSteps?: string[];
    completedSteps?: string[];
    /**
     * The journey being filled in: its id, the page shown and the pages continued
     * from. Absent when the form was being filled on one page.
     */
    journey?: FormDraftJourney;
  };
  updatedAt: number;
}

/**
 * A draft's place in a journey. Never what the host's server said about the answers:
 * a stored "clean" is a claim a client could forge, and a verdict goes stale. A resumed journey
 * asks the server again.
 */
export interface FormDraftJourney {
  id: string;
  page: string;
  completed: string[];
  /**
   * What the journey's worked-out values last wrote, by the target's value path:
   * the runtime's own bookkeeping (`JourneyState.written`), so a resumed journey clears a
   * worked-out field only while it still holds what the journey wrote — never an answer that
   * came from elsewhere. Not a verdict and not an answer: the values themselves are in
   * `values`. Absent when nothing was written.
   */
  written?: Record<string, unknown>;
  /**
   * The review page a Change link left (`JourneyState.returnTo`): a resumed journey still
   * returns there. Kept only while the path takes it and the draft's page is another.
   */
  returnTo?: string;
}

export interface FormDraftSummary {
  id: string;
  formId: string;
  formVersion: string;
  locale: string;
  updatedAt: number;
}

export interface DraftStore {
  save(draft: FormDraft): Promise<void>;
  /** Rejects with a {@link DraftError} `draft.notFound` when nothing is stored under `id` (the engine's stores do). */
  load(id: string): Promise<FormDraft>;
  list(): Promise<FormDraftSummary[]>;
  delete(id: string): Promise<void>;
}

/**
 * Why a draft could not be brought back: nothing stored under the key (`draft.notFound`), a
 * draft of another form (`draft.formMismatch`), a version the form cannot read
 * (`draft.incompatible`, the compatibility policy's verdict), or a draft with no answers to
 * give (`draft.malformed`: not a record, `values` not a record, or no `state`).
 */
export type DraftErrorCode = "draft.notFound" | "draft.formMismatch" | "draft.incompatible" | "draft.malformed";

/**
 * A draft that could not be brought back, with a code a caller can branch on instead of reading
 * the message. Every store the engine ships rejects `load` with it, and
 * `FormRuntime.hydrateFromDraft` and `assertDraftCompatible` throw it. The messages are the ones
 * these places always threw (`Draft not found: <id>`, `Draft form mismatch: …`, `Draft is
 * incompatible: …`), so a host that reads `message` sees no change. A host's own
 * {@link DraftStore} may still reject with a plain `Error` of the same wording: a caller that
 * needs the reason reads `code` when it is one of these and the message otherwise.
 */
export class DraftError extends Error {
  public readonly code: DraftErrorCode;

  constructor(code: DraftErrorCode, message: string) {
    super(message);
    this.name = "DraftError";
    this.code = code;
  }
}

/**
 * A draft's journey when it is usable, else `undefined`, read alike by a draft file
 * and by the runtime putting any store's draft back. Tolerant rather than strict: a
 * hand-edited or damaged journey block costs the person their place in the journey, never the
 * answers the draft holds, which then resume at the journey's start. Anything else
 * in the block — a server's verdict an earlier draft kept (`clean`), say — is dropped: a
 * draft file is the person's to edit, so it never vouches for answers. `written`
 * is kept: it vouches for nothing — it only says which worked-out values the journey may
 * clear again.
 */
export function readDraftJourney(value: unknown): FormDraftJourney | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "" || typeof record.page !== "string" || record.page === "") {
    return undefined;
  }
  const journey: FormDraftJourney = {
    id: record.id,
    page: record.page,
    // An entry that is no page id is dropped, not the list: the pages it does name stay done.
    completed: Array.isArray(record.completed) ? record.completed.filter((entry): entry is string => typeof entry === "string") : []
  };
  // What the journey's worked-out values had written: the runtime's bookkeeping,
  // kept when it is a record of any size; anything else costs only a recomputation.
  const written = record.written;
  if (written !== null && typeof written === "object" && !Array.isArray(written) && Object.keys(written).length > 0) {
    journey.written = { ...(written as Record<string, unknown>) };
  }
  if (typeof record.returnTo === "string" && record.returnTo !== "") {
    journey.returnTo = record.returnTo;
  }
  return journey;
}
