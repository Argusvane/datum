import type { HostError } from "../errors/form-error.js";
import type { CanonicalSubmission } from "../submission/canonical-submission.js";
import type { Expression } from "../expressions/expression.js";
import type {
  Journey,
  JourneyPage,
  JourneyPageKind,
  ResolvedJourneyValidation
} from "../schema/journey.js";

/**
 * The shapes the journey path engine (`journey-path.ts`), the runtime, the renderer and the
 * validation kernel share. Types only, so render and the kernel can import them
 * without importing the runtime.
 */

/**
 * Which pages own which components. Plain records, not Maps: the path engine runs in the
 * validation sandbox too, and its data has to survive being handed across.
 */
export interface JourneyOwnership {
  rootId: string;
  /**
   * Every node id of the form, root first, in document (pre-)order. The form's components only:
   * the nodes a presentation owns are never in it, so nothing that walks it — the
   * placements, the fold, a page's scope — ever sees one.
   */
  order: string[];
  /**
   * Component id -> the pages listing it or one of its ancestors, in page order. A form component also stands on the page of an own node that references it, fills it (an
   * alias) or works it out; and each own node in use is here under its own id, with its one
   * page ({@link ownNodes} tells the two kinds of id apart).
   */
  pagesOf: Record<string, string[]>;
  /**
   * Page id -> what the page draws, in its order: the form component ids it lists (as strings,
   * or as references at the top of the page) that the form has, and the ids of its own entries
   * in use.
   */
  membersOf: Record<string, string[]>;
  /**
   * Ancestors of placed components that are not themselves on any page: never folded. Placed
   * means listed, referenced, filled or worked out.
   */
  structural: Record<string, true>;
  /**
   * Collection path -> the repeating section whose entries live there, so an entry's
   * keys follow the section's pages even when its collection path shares nothing with its id; a
   * data grid is such a section, its rows entries at its collection path.
   */
  collectionOwners: Record<string, string>;
  /**
   * The ids in {@link pagesOf} that are a presentation's own nodes in use, not form components
   *: every node of an own entry that passes the usability rules A–C, bar a
   * worked-out value that is ignored (rules E and G). A value key is never placed by one.
   * Present, with the two records below, only when a page of the journey holds an object
   * entry: a journey of component ids alone has the ownership it always had.
   */
  ownNodes?: Record<string, true>;
  /**
   * Own field id -> the form field it fills: the aliases in use, those whose
   * `configuration.fills` names a usable target from a node that holds a value itself (rules E
   * and F). An own field with a `fills` that is not here is a plain own field.
   */
  aliasOf?: Record<string, string>;
  /**
   * Worked-out node id -> the form field it works out: the `journey-value` nodes in
   * use (rules E and G). One that is not here is ignored: not drawn, and its target not placed.
   */
  workedOutOf?: Record<string, string>;
}

/**
 * Why the path looks as it does: one decision per page on the path bar an exit page, saying how
 * the walk left it. Every page the walk reaches is on the path, shown even when nothing on it
 * shows: passing a page by is a route its predecessor's author writes.
 */
export type JourneyDecision =
  | { kind: "route"; pageId: string; routeIndex: number; to: string }
  | { kind: "next"; pageId: string; to: string };

/** The path through a journey for one set of answers. */
export interface JourneyTrace {
  /** Page ids on the path, in order. */
  pages: string[];
  /** `"exit"` when the path stops at an exit page; `"end"` when it runs off the end. */
  end: "end" | "exit";
  decisions: JourneyDecision[];
}

/** Where a component stands against a path. */
export type JourneyPlacement = "on" | "off" | "unassigned";

/** Evaluates a condition against component-id-keyed values (`evaluateExpression`, or the kernel's). */
export type JourneyEvaluate = (expression: Expression, values: Record<string, unknown>) => unknown;

export interface JourneyPathInput {
  /**
   * The submittable answers, keyed by component id (rows and keys owned by no component pass
   * through as they are). The walk shows a condition only the part of these on pages already
   * on the path, plus the answers of components on no page.
   */
  values: Record<string, unknown>;
  ownership: JourneyOwnership;
  evaluate: JourneyEvaluate;
}

/**
 * How a page change came about. `"change"`: a Change link on a review page took the person back
 * to a page they completed, to change an answer; Continue and Back from there return
 * ({@link JourneyView.returning}).
 */
export type PageChangeDirection = "start" | "resume" | "forward" | "back" | "jump" | "error" | "change";

/** Why a page change did not happen. */
export type JourneyBlockReason =
  /** The page's own validation found an error that blocks. */
  | "validation"
  /** The host's server found an error that blocks. */
  | "server"
  /** The host's server could not be reached, and the page's `onUnavailable` is `"block"`. */
  | "server-unavailable"
  /** The host's server found only warnings: shown once; Continue again with the same answers goes on. */
  | "warnings"
  /** A check or another move is still in flight. */
  | "pending"
  /** The answers changed while the host's server was checking them. */
  | "stale"
  /** Back, a jump or leaving the journey called the page's check off. */
  | "cancelled"
  | "at-end"
  | "at-start"
  | "unreachable"
  | "no-journey"
  | "exit"
  | "vetoed";

export interface JourneyNavigationResult {
  ok: boolean;
  /** The page shown after the call. */
  pageId?: string;
  reason?: JourneyBlockReason;
  /** A veto's message, or the server's, when there is one. */
  message?: string;
}

/** The journey as the page being shown sees it: what the runtime tells the renderer. */
export interface JourneyView {
  journeyId: string;
  journey: Journey;
  pageId: string;
  page: JourneyPage;
  kind: JourneyPageKind;
  /** Page ids on the current path. */
  path: string[];
  /** The page's position on the path, 0-based. */
  index: number;
  /** Questions and review pages on the path — the "of N" of "Page 2 of 5". */
  total: number;
  /** The page's position among the questions and review pages on the path, 1-based. */
  number: number;
  /** Pages on the path the person has completed. */
  completed: string[];
  /** The first page on the path not completed: the furthest the person may jump. */
  frontierPageId: string;
  /**
   * Where Back goes; absent on the first page. While {@link returning}, on a page completed
   * before, its `nextPageId`; on a page not yet completed, the page before it as ever.
   */
  backPageId?: string;
  /**
   * The person came here by a Change link from a review page (`goToPage(id, { direction:
   * "change" })`) and is on the way back to it: Continue goes to `nextPageId`, the first page on
   * the path not yet completed bar this one (a page the changed answers put on the path), else
   * the review page itself; so does Back from a page completed before the Change. Absent
   * otherwise, and on the review page.
   */
  returning?: { reviewPageId: string; nextPageId: string };
  /** The last page on the path: its action submits. */
  final: boolean;
  end: "end" | "exit";
  /** The component ids the page draws, in order. */
  members: string[];
  /** Component id -> the earliest page on the path that holds it. */
  pageOf: Record<string, string>;
  validation: ResolvedJourneyValidation;
  /**
   * A check against the host's server is in flight: `"page"`, the page's on Continue (Back
   * calls it off); `"journey"`, the one a submit makes at the journey's end (nothing calls it
   * off, and the page cannot change until it is back).
   */
  pending?: "page" | "journey";
  /**
   * Form component id -> the node of this page that shows its errors: a form field
   * the page asks through a node of the presentation's own — an alias that fills it, or the
   * read-only copy of a worked-out value — is not drawn itself, so an error the form's rules,
   * the sandbox or a server reports on it is shown on that node. The first alias on the page
   * that shows, else the worked-out value; never for a field the page also draws itself (listed
   * or referenced). The errors keep naming the form field (`componentId`): only where they are
   * drawn, and what is focused first, moves. Present only while the running journey holds
   * nodes of its own; no prototype, since it is keyed by ids an author chose.
   */
  hosts?: Record<string, string>;
}

/**
 * What the browser asks the host's server to check: the answers as they would be
 * submitted, and which journey — never the path, which the server works out again itself.
 */
export interface JourneyValidationRequest {
  formId: string;
  /** The definition's version, which the server looks the form up by. */
  formVersion: string;
  journeyId: string;
  /** `"page"`: check one page on Continue. `"journey"`: check everything, before submit. */
  scope: "page" | "journey";
  /** The page being left, for `scope: "page"`. */
  pageId?: string;
  /**
   * Every submittable answer keyed by value path — the shape a submission's `values` has — for
   * a page's check as for the journey's: the server's fold then agrees with the browser's.
   */
  values: Record<string, unknown>;
  locale: string;
}

/**
 * The server's verdict. `errors` holds warnings too: a check blocks only on an entry whose
 * severity is `"error"` (the default). Any other key is ignored — an `accepted` flag, say.
 */
export interface JourneyValidationResponse {
  /**
   * The problems found, as a host reports them into a form (`FormRuntime.setErrors`). An entry
   * names its field by `componentId` (or `field`, read the same way), else by value `path`;
   * the browser keeps a page's reply to the page's components and the entries naming none.
   */
  errors: HostError[];
  /** The server's own path, for diagnostics only: the browser never navigates by it. */
  journey?: { pages: string[]; end: "end" | "exit" };
}

/**
 * The host's way to its server. The runtime aborts `signal` when the check is
 * called off or times out. `document` is the submission envelope over the request's values,
 * built as Submit builds `datum-submit`'s: what a Datum host's `POST /api/submissions/validate`
 * takes, wrapped as `{ document, scope, pageId }` (`createFetchJourneyValidator` posts that).
 * Absent when the runtime was given no version context to stamp into it.
 *
 * Rejects when there is no verdict. An error carrying a numeric `status` (an HTTP status, as
 * `createFetchJourneyValidator` attaches) says how the server answered; every status, a 4xx as
 * much as a 5xx, counts as the server being unavailable (`server-error`), as does a rejection
 * with none (the network), and the journey's `onUnavailable` decides. A misconfigured host then
 * holds the journey rather than letting answers through unchecked.
 */
export type JourneyServerValidator = (
  request: JourneyValidationRequest,
  options?: { signal?: AbortSignal; document?: CanonicalSubmission }
) => Promise<JourneyValidationResponse>;
